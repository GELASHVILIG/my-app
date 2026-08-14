import type { Construct } from 'constructs';

/**
 * Deploy-time configuration, resolved from CDK context only.
 *
 * ADR 0002 requires the removal policy to be an explicit, visible decision. The
 * environment is therefore never inferred and never silently defaulted in code:
 * `cdk.json` declares `"env": "dev"` for local synth, and a real deploy passes
 * `-c env=prod`. An unrecognised value is a hard failure rather than a fallback,
 * because the failure mode of guessing wrong is a `DESTROY` policy on the
 * production table.
 */
export const DEPLOY_ENVIRONMENTS = ['dev', 'prod'] as const;

export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

export const PROJECT_NAME = 'news-aggregator';

/**
 * Fallback alert address. Override per deploy with `-c alertEmail=...`.
 * Alerts are the only thing standing between a silently dead ingest job and a
 * stale page, so this must point at an inbox someone actually reads.
 */
export const DEFAULT_ALERT_EMAIL = 'giorgigelashvili18@gmail.com';

export interface AppConfig {
  readonly projectName: string;
  readonly environment: DeployEnvironment;
  /** Drives removal policy, PITR and deletion protection (ADR 0002). */
  readonly isProd: boolean;
  readonly alertEmail: string;
}

function contextString(scope: Construct, key: string): string | undefined {
  const value: unknown = scope.node.tryGetContext(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isDeployEnvironment(value: string): value is DeployEnvironment {
  return (DEPLOY_ENVIRONMENTS as readonly string[]).includes(value);
}

export function resolveAppConfig(scope: Construct): AppConfig {
  const environment = contextString(scope, 'env');
  if (environment === undefined || !isDeployEnvironment(environment)) {
    throw new Error(
      `CDK context "env" must be one of ${DEPLOY_ENVIRONMENTS.join(' | ')} (got ${
        environment ?? 'undefined'
      }). Pass it explicitly, e.g. cdk deploy -c env=prod.`,
    );
  }

  return {
    projectName: PROJECT_NAME,
    environment,
    isProd: environment === 'prod',
    alertEmail: contextString(scope, 'alertEmail') ?? DEFAULT_ALERT_EMAIL,
  };
}
