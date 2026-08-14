import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { AppConfig } from './config.js';

/** Repo root, resolved from this file so the entry paths survive a move of `infra/`. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface StatelessStackProps extends StackProps {
  readonly config: AppConfig;
  /**
   * Passed by construct props from the stateful stack — one cross-stack
   * reference path, not two (ADR 0001). Typed as the concrete `Table` rather
   * than `ITable` because `exactOptionalPropertyTypes` makes the interface's
   * optional `tableStreamArn` incompatible with the class's `string | undefined`.
   */
  readonly articlesTable: dynamodb.Table;
  readonly ingestDlq: sqs.IQueue;
  readonly alertsTopic: sns.ITopic;
}

/**
 * Compute and delivery: everything here can be torn down and redeployed without
 * risking data (ADR 0001). No VPC anywhere — a VPC Lambda needs a NAT Gateway at
 * ~$32/mo, which would be 100x the rest of this bill.
 */
export class StatelessStack extends Stack {
  public readonly httpApiUrl: string;

  constructor(scope: Construct, id: string, props: StatelessStackProps) {
    super(scope, id, props);

    const { config, articlesTable, ingestDlq, alertsTopic } = props;

    const commonFunctionProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      // ARM is cheaper per GB-second and no slower for this workload.
      architecture: lambda.Architecture.ARM_64,
      handler: 'handler',
      environment: { ARTICLES_TABLE_NAME: articlesTable.tableName },
      bundling: {
        // Not minified on purpose: a readable stack trace at 3am is worth more
        // than the few hundred KB it saves on a bundle this size.
        minify: false,
        sourceMap: false,
        // Ship the AWS SDK from the lockfile instead of externalizing it and
        // inheriting whatever version the Node 22.x runtime happens to provide.
        // `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are declared as
        // production dependencies; bundling them makes that an honest claim and
        // makes the deployed behaviour reproducible from the lockfile alone.
        // Costs a larger bundle and a slightly longer cold start — worth it for
        // a runtime whose SDK version we do not control.
        bundleAwsSDK: true,
      },
    } as const;

    // --- web ---------------------------------------------------------------

    // Explicit log group rather than the deprecated `logRetention` prop. Two
    // weeks: the CloudWatch default is forever, and it bills forever.
    const webLogs = new logs.LogGroup(this, 'WebFunctionLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const webFunction = new nodejs.NodejsFunction(this, 'WebFunction', {
      ...commonFunctionProps,
      entry: path.join(REPO_ROOT, 'src/lambda/web.ts'),
      timeout: Duration.seconds(5),
      memorySize: 512,
      // Cost circuit-breaker: caps what a scraper or a runaway retry loop can bill.
      reservedConcurrentExecutions: 10,
      logGroup: webLogs,
      description: 'Renders the article list page (ADR 0001).',
    });

    // Read-only on the article corpus: a bug in the request path cannot corrupt
    // it (ADR 0002). Grant method, no hand-written policy, no wildcard.
    articlesTable.grantReadData(webFunction);

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${config.projectName}-${config.environment}`,
      description: 'Public read-only news aggregator API.',
      // Default stage is created below so it can carry throttle settings.
      createDefaultStage: false,
    });

    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('WebIntegration', webFunction, {
        // 29s is the API Gateway maximum (ADR 0001 says "30s, its maximum").
        // The Lambda times out at 5s first; this is only a backstop.
        timeout: Duration.seconds(29),
      }),
    });

    const defaultStage = new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi,
      autoDeploy: true,
      // The second cost circuit-breaker (ADR 0001). Far above real traffic,
      // far below anything that could produce a meaningful bill.
      throttle: { rateLimit: 20, burstLimit: 40 },
    });

    this.httpApiUrl = defaultStage.url;

    // --- ingest ------------------------------------------------------------

    const ingestLogs = new logs.LogGroup(this, 'IngestFunctionLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ingestFunction = new nodejs.NodejsFunction(this, 'IngestFunction', {
      ...commonFunctionProps,
      entry: path.join(REPO_ROOT, 'src/lambda/ingest.ts'),
      timeout: Duration.seconds(60),
      // Memory is CPU: XML parsing finishes sooner at 1024MB, often for less money.
      memorySize: 1024,
      // Exactly one run at a time: no overlapping cycles, and an accidental
      // invocation loop cannot fan out (ADR 0003).
      reservedConcurrentExecutions: 1,
      logGroup: ingestLogs,
      description: 'Fetches every configured feed and stores new articles (ADR 0003).',
      // Async invocation config: EventBridge retries twice, then the event goes
      // to the DLQ rather than disappearing.
      retryAttempts: 2,
      maxEventAge: Duration.hours(1),
      onFailure: new destinations.SqsDestination(ingestDlq),
    });

    // Only the ingest function writes articles (ADR 0002's one-writer-per-table rule).
    articlesTable.grantReadWriteData(ingestFunction);

    new events.Rule(this, 'IngestSchedule', {
      description: 'Fetch feeds every 30 minutes (ADR 0003).',
      schedule: events.Schedule.rate(Duration.minutes(30)),
      targets: [new targets.LambdaFunction(ingestFunction)],
    });

    // --- alarms ------------------------------------------------------------

    // Three alarms, deliberately. One person is on call; an alarm that fires on
    // something they will not act on trains them to ignore all of them.
    const notify = new cwactions.SnsAction(alertsTopic);

    const dlqAlarm = new cloudwatch.Alarm(this, 'IngestDlqNotEmptyAlarm', {
      alarmName: `${config.projectName}-${config.environment}-ingest-dlq-not-empty`,
      metric: ingestDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Ingest run failed all retries and its event landed in the DLQ. Check the IngestFunction log group for the last error, fix and redeploy, then purge the queue — the next 30-minute cycle re-fetches everything, so the message itself is diagnostic only.',
    });
    dlqAlarm.addAlarmAction(notify);

    // Rate, not raw count: on a page with a handful of visitors an hour, a single
    // 5xx is noise. `IF(...)` keeps a zero-traffic period from producing no-data.
    const requestCount = defaultStage.metricCount({ period: Duration.minutes(1) });
    const serverErrorCount = defaultStage.metricServerError({ period: Duration.minutes(1) });
    const serverErrorRate = new cloudwatch.MathExpression({
      expression: 'IF(requests > 0, 100 * errors / requests, 0)',
      usingMetrics: { requests: requestCount, errors: serverErrorCount },
      period: Duration.minutes(1),
      label: 'Web 5xx rate (%)',
    });

    const web5xxAlarm = new cloudwatch.Alarm(this, 'Web5xxRateAlarm', {
      alarmName: `${config.projectName}-${config.environment}-web-5xx-rate`,
      metric: serverErrorRate,
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      // Sustained, not a spike: 2 bad minutes out of 3.
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Web 5xx rate above 5% for 3 minutes. Check the most recent stateless deploy first (roll back by redeploying the previous commit from CI), then the WebFunction log group, then whether DynamoDB is returning errors.',
    });
    web5xxAlarm.addAlarmAction(notify);

    // The failure this design is most likely to hit and the only one nothing
    // else would notice: the schedule silently stops and the page quietly goes
    // stale. BREACHING on missing data is the entire point — no data IS the
    // failure (ADR 0003).
    const ingestStalledAlarm = new cloudwatch.Alarm(this, 'IngestNotRunningAlarm', {
      alarmName: `${config.projectName}-${config.environment}-ingest-not-running`,
      metric: ingestFunction.metricInvocations({
        period: Duration.hours(2),
        statistic: 'Sum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription:
        'Ingest Lambda has not run in 2 hours (expected every 30 min), so the page is going stale. Check the IngestSchedule EventBridge rule is enabled, then the function is not throttled by its reserved concurrency of 1, then the IngestFunction log group.',
    });
    ingestStalledAlarm.addAlarmAction(notify);

    // --- dashboard ---------------------------------------------------------

    // One dashboard, above the fold: traffic, errors, latency, and whether the
    // ingest job is alive. Free (CloudWatch includes 3 dashboards).
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${config.projectName}-${config.environment}`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Web — requests and 5xx',
        left: [requestCount],
        right: [serverErrorCount],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Web — latency p50/p95/p99',
        left: [
          defaultStage.metricLatency({ statistic: 'p50' }),
          defaultStage.metricLatency({ statistic: 'p95' }),
          defaultStage.metricLatency({ statistic: 'p99' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Ingest — invocations, errors, duration',
        left: [
          ingestFunction.metricInvocations({ statistic: 'Sum' }),
          ingestFunction.metricErrors({ statistic: 'Sum' }),
        ],
        right: [ingestFunction.metricDuration({ statistic: 'p95' })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Ingest — DLQ depth',
        left: [ingestDlq.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum' })],
        width: 12,
      }),
    );

    new CfnOutput(this, 'SiteUrl', {
      value: this.httpApiUrl,
      description: 'Public URL of the article list page.',
    });
  }
}
