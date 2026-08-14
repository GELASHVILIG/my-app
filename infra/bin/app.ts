import { App, Tags } from 'aws-cdk-lib';
import type { Environment } from 'aws-cdk-lib';
import { resolveAppConfig } from '../lib/config.js';
import { StatefulStack } from '../lib/stateful-stack.js';
import { StatelessStack } from '../lib/stateless-stack.js';

const app = new App();
const config = resolveAppConfig(app);

/**
 * Account/region come from the ambient credentials at deploy time (CI), which
 * keeps account ids out of the repo. Synth without credentials stays
 * environment-agnostic, which is what `npm run cdk:synth` does locally.
 */
const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'];
const env: Environment = {
  ...(account === undefined ? {} : { account }),
  ...(region === undefined ? {} : { region }),
};

const stateful = new StatefulStack(app, 'Stateful', {
  env,
  stackName: `${config.projectName}-stateful-${config.environment}`,
  description: `${config.projectName} data, DLQ, alert channel and budget (${config.environment}).`,
  config,
});

const stateless = new StatelessStack(app, 'Stateless', {
  env,
  stackName: `${config.projectName}-stateless-${config.environment}`,
  description: `${config.projectName} compute and delivery (${config.environment}).`,
  config,
  articlesTable: stateful.articlesTable,
  ingestDlq: stateful.ingestDlq,
  alertsTopic: stateful.alertsTopic,
});

// Implied by the construct-prop references, but stated so that dropping a
// reference later cannot silently reorder the deploy.
stateless.addStackDependency(stateful);

for (const stack of [stateful, stateless]) {
  Tags.of(stack).add('Project', config.projectName);
  Tags.of(stack).add('Environment', config.environment);
  Tags.of(stack).add('ManagedBy', 'cdk');
}

app.synth();
