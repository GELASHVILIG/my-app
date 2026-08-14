import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveAppConfig } from './config.js';
import { StatefulStack } from './stateful-stack.js';
import { StatelessStack } from './stateless-stack.js';

/**
 * Assertions on the handful of properties that are either load-bearing for the
 * application (the table schema `src/adapters/dynamo-article-store.ts` assumes),
 * expensive to get wrong (removal policy, reserved concurrency, throttle), or
 * invisible until an incident (alarms). Deliberately not a snapshot test —
 * whole-template snapshots churn on every CDK upgrade.
 */
function synthesize(env: 'dev' | 'prod'): { stateful: Template; stateless: Template } {
  const app = new App({ context: { env } });
  const config = resolveAppConfig(app);
  const stateful = new StatefulStack(app, 'Stateful', { config });
  const stateless = new StatelessStack(app, 'Stateless', {
    config,
    articlesTable: stateful.articlesTable,
    ingestDlq: stateful.ingestDlq,
    alertsTopic: stateful.alertsTopic,
  });
  return { stateful: Template.fromStack(stateful), stateless: Template.fromStack(stateless) };
}

describe('infrastructure', () => {
  let dev: { stateful: Template; stateless: Template };

  beforeAll(() => {
    dev = synthesize('dev');
  }, 60_000);

  it('creates the Articles table with the schema the adapter assumes', () => {
    dev.stateful.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'byPublishedAt',
          KeySchema: [
            { AttributeName: 'gsiPk', KeyType: 'HASH' },
            { AttributeName: 'gsiSk', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            // `id` included: without it every queried item fails validation in
            // the adapter and the page renders empty.
            NonKeyAttributes: ['id', 'title', 'url', 'source', 'publishedAt'],
          },
        },
      ],
    });
  });

  it('destroys data outside prod and retains it in prod', () => {
    dev.stateful.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: Match.objectLike({
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
      }),
    });

    const prod = synthesize('prod');
    prod.stateful.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        DeletionProtectionEnabled: true,
      }),
    });
  }, 60_000);

  it('keeps failed ingest events for two weeks and budgets the account at $5', () => {
    dev.stateful.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
    dev.stateful.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 5, Unit: 'USD' },
        TimeUnit: 'MONTHLY',
        BudgetType: 'COST',
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 50 }) }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100 }) }),
      ]),
    });
  });

  it('caps concurrency on both functions and throttles the API', () => {
    dev.stateless.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 5,
      ReservedConcurrentExecutions: 10,
      Architectures: ['arm64'],
    });
    dev.stateless.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1024,
      Timeout: 60,
      ReservedConcurrentExecutions: 1,
      Architectures: ['arm64'],
    });
    dev.stateless.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it('gives the web function read-only access to the article corpus', () => {
    const policies = dev.stateless.findResources('AWS::IAM::Policy');
    const webPolicy = Object.entries(policies).find(([id]) =>
      id.startsWith('WebFunctionServiceRoleDefaultPolicy'),
    );
    expect(webPolicy).toBeDefined();

    const actions = JSON.stringify(webPolicy?.[1]);
    for (const write of ['PutItem', 'UpdateItem', 'DeleteItem', 'BatchWriteItem']) {
      expect(actions).not.toContain(write);
    }
    expect(actions).not.toContain('"Resource":"*"');
  });

  it('puts no function in a VPC', () => {
    for (const fn of Object.values(dev.stateless.findResources('AWS::Lambda::Function'))) {
      expect(fn['Properties']).not.toHaveProperty('VpcConfig');
    }
  });

  it('retries ingest twice for an hour then dead-letters', () => {
    dev.stateless.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 3600,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    dev.stateless.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(30 minutes)',
      State: 'ENABLED',
    });
  });

  it('alarms on the three failures worth waking someone for, each notifying SNS', () => {
    dev.stateless.resourceCountIs('AWS::CloudWatch::Alarm', 3);

    // The one nothing else would notice: the schedule silently stops.
    dev.stateless.hasResourceProperties('AWS::CloudWatch::Alarm', {
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      TreatMissingData: 'breaching',
      MetricName: 'Invocations',
      AlarmActions: [Match.anyValue()],
      AlarmDescription: Match.anyValue(),
    });

    dev.stateless.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
      AlarmActions: [Match.anyValue()],
    });

    for (const alarm of Object.values(dev.stateless.findResources('AWS::CloudWatch::Alarm'))) {
      const properties = alarm['Properties'] as Record<string, unknown>;
      const description: unknown = properties['AlarmDescription'];
      // Every alarm carries a runbook line — nobody remembers what to check at 3am.
      expect(typeof description === 'string' && description.length > 60).toBe(true);
    }
  });
});
