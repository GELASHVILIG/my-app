import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { AppConfig } from './config.js';

/** Index name and attribute names are a contract with `src/adapters/dynamo-article-store.ts` (ADR 0002). */
export const PUBLISHED_AT_INDEX = 'byPublishedAt';

export interface StatefulStackProps extends StackProps {
  readonly config: AppConfig;
}

/**
 * Everything that holds state and is expensive or impossible to recreate:
 * the article corpus, the ingest DLQ, the alert channel and the account budget.
 * Redeploying compute never touches this stack (ADR 0001).
 */
export class StatefulStack extends Stack {
  /**
   * Passed to the stateless stack by construct props, so CDK generates and
   * manages the cross-stack CloudFormation export itself
   * (`ExportsOutputFnGetAttArticles...` / `Fn::ImportValue`). The deliberate
   * choice is CDK-managed rather than a hand-written `CfnOutput` +
   * `Fn.importValue` pair — not the absence of an export (ADR 0001).
   */
  public readonly articlesTable: dynamodb.Table;
  public readonly ingestDlq: sqs.Queue;
  public readonly alertsTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: StatefulStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.articlesTable = new dynamodb.Table(this, 'Articles', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      // On-demand: no capacity planning, no hourly floor, $0 at idle (ADR 0002).
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      // Default AWS-owned key. A customer-managed KMS key is $1/mo — more than
      // the rest of the design combined — with no compliance driver (ADR 0002).
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.isProd },
      deletionProtection: config.isProd,
      removalPolicy: config.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.articlesTable.addGlobalSecondaryIndex({
      indexName: PUBLISHED_AT_INDEX,
      partitionKey: { name: 'gsiPk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiSk', type: dynamodb.AttributeType.STRING },
      // INCLUDE, not ALL: the render path reads exactly these attributes, so the
      // index stays small and no second read is needed (ADR 0002).
      //
      // `id` is projected in addition to the four attributes listed in ADR 0002
      // because `toArticle()` in src/adapters/dynamo-article-store.ts requires it
      // and drops any item without it — without `id` here the homepage renders
      // empty. A GSI projection cannot be changed in place (it needs the index
      // dropped and rebuilt), so this has to be right on the first deploy.
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['id', 'title', 'url', 'source', 'publishedAt'],
    });

    this.ingestDlq = new sqs.Queue(this, 'IngestDlq', {
      // Long enough that a failure over a weekend is still inspectable on Monday.
      retentionPeriod: Duration.days(14),
      // SSE-SQS: encryption at rest with no KMS key charge.
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Adds a CDK-generated resource policy that DENIES `sqs:*` without TLS.
      // The wildcard is on a Deny, so it only ever removes permission.
      enforceSSL: true,
      // Failed events are diagnostic, not durable state: losing them on teardown
      // is acceptable, and RETAIN would orphan a queue on every stack delete.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.alertsTopic = new sns.Topic(this, 'Alerts', {
      displayName: `${config.projectName} ${config.environment} alerts`,
    });
    // Holds no state; the subscription is recreated with the topic. Set
    // explicitly rather than left to the CDK default.
    this.alertsTopic.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.alertsTopic.addSubscription(new subscriptions.EmailSubscription(config.alertEmail));

    // ADR 0001: the budget exists before the first deploy, not after the first
    // surprise bill. Account-wide (no cost filter) — this project is the only
    // thing in the account, and a filtered budget needs cost-allocation tags
    // activated by hand in the console.
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${config.projectName}-${config.environment}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 5, unit: 'USD' },
      },
      notificationsWithSubscribers: [50, 100].map((threshold) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          thresholdType: 'PERCENTAGE',
          threshold,
        },
        // Email direct rather than via the SNS topic: an SNS subscriber needs a
        // hand-written topic policy for budgets.amazonaws.com, and this is the
        // one alert that must survive a broken alarm pipeline.
        subscribers: [{ subscriptionType: 'EMAIL', address: config.alertEmail }],
      })),
    });
  }
}
