# 0001. Serverless compute and delivery for the news aggregator

Status: accepted
Date: 2026-08-14

## Context

`docs/plans/news-aggregator.md` describes v1: a curated set of ~10–30 tech RSS
feeds pulled on a schedule into one public HTML page of recent articles, plus a
view counter. It assumes "AWS, serverless" but flags that as unconfirmed.

Forces:

- **Cost ceiling is the hard constraint.** "Near-zero at idle" is stated in the
  spec. This is a personal project with a public audience that may well be zero
  people for weeks at a time. Idle cost is therefore the deciding factor, not
  throughput or latency.
- **Expected load is tiny.** Assume 10k page views/month as a generous v1
  ceiling (~4 requests/hour average, spiky if a link gets shared). Write side is
  fixed and predictable: 48 scheduled runs/day regardless of traffic.
- **Team of one, no on-call.** Anything requiring patching, capacity planning, or
  a 2am restart is disqualified regardless of technical merit.
- **Read and write paths have different shapes.** Writes are batchy and
  scheduled; reads are tiny and bursty. Nothing in the read path is
  user-specific — every visitor gets byte-identical HTML that changes at most
  every 30 minutes.
- `infra/` does not exist yet. `package.json` already points `cdk:diff` at
  `infra/bin/app.ts`, so the first infrastructure task creates the directory
  following the stateful/stateless split in `CLAUDE.md`.

## Options considered

### A. Lambda + API Gateway HTTP API, rendering per request

Scheduled Lambda writes to the datastore; a second Lambda behind an HTTP API
renders HTML on each request.

- **Fit:** good. Both workloads are short, stateless, and bursty — the shape
  Lambda is actually for.
- **Cost at idle:** **$0.00/mo.** At 10k views/mo: HTTP API ~$0.01, Lambda inside
  the always-free 1M requests / 400k GB-s tier, logs inside the 5 GB free tier.
  Under $0.50/mo all-in excluding an optional domain.
- **Operational burden:** near zero. No hosts, no patching, no scaling. Failures
  surface as CloudWatch metrics and a DLQ.
- **Exit cost:** low. Handlers stay thin; `src/http` is framework-agnostic and
  could be mounted in a container in an afternoon.
- **Cons:** cold start on the first request after idle (the plan already flags
  this as a risk); a bug in the render path is a per-request bug rather than a
  one-time build failure.

### B. Static generation — scheduled Lambda renders HTML to S3, CloudFront serves it

- **Fit:** arguably the *best* fit for the read path. The page is identical for
  everyone and changes every 30 minutes; there is no reason to compute it 10,000
  times when it could be computed 48 times.
- **Cost at idle:** ~$0.00/mo (S3 storage of a few hundred KB; CloudFront's free
  tier covers 1 TB/mo egress).
- **Operational burden:** lowest of all options. No compute in the request path
  means no cold starts, no 5xx from the web tier, and the page stays up even if
  ingestion is completely broken.
- **Exit cost:** moderate — moving back to dynamic rendering means reintroducing
  an API tier.
- **Cons, and why it was rejected:** (1) it puts rendering in the *ingestion*
  path, which contradicts the agreed `src/http` layer and tasks 6–7 of the plan;
  (2) M3 requires per-page-view counting, and a static object served by a CDN
  never reaches our code — view counting would have to become CloudFront log
  analysis (S3 + Athena, more moving parts and more cost than the thing it
  measures) or a JS beacon, which ADR 0004 rules out; (3) `/stats` would need a
  Lambda anyway, so the "no compute" benefit is not actually complete.
  **This remains the best upgrade path if cold starts turn out to be
  unacceptable** — see revisit triggers.

### C. Always-on single Node process (App Runner / Fargate / EC2 / Lightsail)

One container running Express plus an in-process cron.

- **Fit:** simplest possible mental model — one process, one log, `node-cron` for
  the schedule, no cold starts.
- **Cost at idle:** this is what disqualifies it.
  - App Runner: ~**$3.30/mo** floor (0.5 GB provisioned memory at
    $0.009/GB-hour) before a single request.
  - Fargate 0.25 vCPU / 0.5 GB: ~**$9/mo**, plus $3.65/mo for a public IPv4,
    plus ~$16/mo if an ALB is used → $12–29/mo.
  - EC2 `t4g.nano`: ~$3.07/mo + EBS + $3.65/mo public IPv4 ≈ **$7/mo**.
  - Lightsail: **$5/mo** flat, but it is a poor fit for CDK and reintroduces OS
    patching.
- **Operational burden:** highest. OS/runtime patching, process supervision, a
  cron that silently stops when the process dies, and a single point of failure
  with no built-in retry semantics.
- **Exit cost:** low.
- **Rejected because** it costs $3–29/mo to serve a page nobody may visit, and it
  is the only option here that can page a person at 2am.

### D. Lambda Function URL instead of API Gateway

- Same as A but ~$1.00 per million requests cheaper (Function URLs are free).
- At 10k requests/month that saves **$0.01/month**.
- **Rejected because** API Gateway HTTP API buys three things worth more than a
  cent: stage-level **throttling** (a cost circuit-breaker — a scraper hitting a
  Function URL bills Lambda directly with no ceiling below account concurrency),
  native **custom domain** support with ACM, and structured access logs.

### E. CloudFront in front of A

- Adds edge caching (so repeat traffic never reaches Lambda), free TLS, custom
  domain, and hides cold starts behind a cached object.
- Cost at idle ~$0.00 (free tier).
- **Rejected for v1, deliberately deferred:** it makes per-request view counting
  incorrect (cached hits never reach the counter — see ADR 0005), and it adds a
  distribution with 5–15 minute deploys and cache-invalidation questions to solve
  a latency problem that has not been measured yet. The plan's own risk section
  says to measure cold starts after M1 first.

## Decision

**Option A: AWS serverless. A scheduled Lambda for ingestion, a second Lambda
behind an API Gateway HTTP API for serving, no VPC anywhere.** This confirms the
plan's assumption, but on cost-at-idle grounds rather than fashion.

The trade-off accepted: **we pay cold-start latency on the first request after a
quiet period, and we recompute an identical page on every request.** Both are
worse than option B. Neither matters here because the page is a list of links
where 300–500ms of first-byte latency is not user-visible in any meaningful way,
and because keeping rendering in `src/http` preserves the one-code-path property
that makes M3 (per-request counting) a five-line change instead of a
log-analytics pipeline.

Binding specifics:

- **No VPC.** Neither Lambda touches anything private. A VPC Lambda needs a NAT
  Gateway for outbound internet at ~$32/mo per AZ, which would be 100x the rest
  of the bill.
- `NodejsFunction`, `NODEJS_22_X`, `architecture: ARM_64`, explicit `timeout` and
  `memorySize` on both functions (web: 5s / 512 MB; ingest: 60s / 1024 MB —
  revisit after measuring), `logRetention: TWO_WEEKS`.
- **Reserved concurrency on both functions** (web: 10, ingest: 1). This caps the
  worst-case bill from a runaway loop or a scraper, and for ingest it guarantees
  no overlapping runs.
- **Stage-level throttle on the HTTP API** (e.g. 20 rps burst 40). Second cost
  circuit-breaker.
- **Response `Cache-Control: public, max-age=300`** from day one. It costs
  nothing, helps browsers and any future CDN, and makes option E a
  configuration-level upgrade rather than a rewrite.
- **AWS Budget at $5/month** with alerts at 50% and 100% to email, deployed
  *before* the first `cdk deploy`. Non-optional.

Stack mapping (`CLAUDE.md` stateful/stateless split):

| Stateful stack | Stateless stack |
|---|---|
| Articles table, Stats table (ADR 0002) | Ingest Lambda + EventBridge rule (ADR 0003) |
| Ingest DLQ (SQS) | Web Lambda + HTTP API |
| Alerts SNS topic | CloudWatch alarms + dashboard |
| Analytics salt parameter (SSM, ADR 0005) | |
| AWS Budget | |

Failure design:

1. **Dependency unavailable.** A feed host down → that feed is skipped, the rest
   render (degrade, never fail closed) — see ADR 0003. DynamoDB unavailable on
   the read path → 503 with a static apology body and a 5xx alarm; this is
   accepted rather than mitigated, because a cache layer to survive it costs more
   attention than the outage does.
2. **Retries.** AWS SDK default (3, exponential) for DynamoDB. EventBridge →
   Lambda async invocation: `retryAttempts: 2`, `maxEventAge: 1 hour`, then DLQ.
   No in-run retry of feed fetches — the next 30-minute cycle *is* the retry.
3. **Timeouts.** Every outbound feed fetch gets `AbortSignal.timeout(5000)`. Web
   Lambda 5s, ingest Lambda 60s, HTTP API integration timeout 30s (its maximum).
4. **Bad deploy blast radius.** Stateless stack only; data is in a separate stack
   and untouched. Rollback = redeploy the previous commit from CI. Deploys are
   human-run from CI per `CLAUDE.md`; agents produce `cdk diff` only.
5. **Data corruption/restore.** Articles are *reconstructible* — delete the table
   and the next fetch cycle repopulates whatever is still in the feeds (older
   items are lost, and that is acceptable for a recency-ordered page). Stats are
   **not** reconstructible, which is the actual reason to enable PITR (see ADR
   0002). This must be tested once, by hand, after M1: delete a few article items
   and confirm the next cycle restores the page.

Alarms (email via SNS, each with a runbook line in its description): any message
in the ingest DLQ; web 5xx rate sustained over 3 minutes; ingest Lambda
`Invocations` sum < 1 over 2 hours with `treatMissingData: BREACHING` (the
"scheduled job did not run" case); budget threshold.

**Cost at idle: $0.00/month.** Realistic monthly cost at 10k page views: under
$0.50. Add $0.50/mo for a Route 53 hosted zone plus ~$12/yr registration if a
custom domain is used — that domain is the single largest line item in this
design, which is the correct shape for a project of this size.

## Consequences

**Easier:** the bill is zero while nobody visits, so the project can sit dormant
for a year without becoming a liability. No servers to patch. Scaling to a
front-page traffic spike is automatic (and capped by reserved concurrency, so the
spike costs pennies rather than a surprise bill). Stateless redeploys cannot
destroy data.

**Harder:** local development no longer resembles production exactly — `npm run
dev` runs a plain Node process, so the Lambda handler must stay a thin adapter
over `src/http` with no logic in it, and the Playwright e2e suite has to target a
deployed URL. Cold starts exist and will be visible in p99. Cross-stack
references between the stateful and stateless stacks create CloudFormation
exports, which cannot be removed while in use — pass resources via construct
props and expect a two-step deploy if a table reference is ever dropped.

**Revisit when:**

- Measured cold start after M1 exceeds ~1s at p95 → add CloudFront (option E) and
  move view counting per ADR 0005's fallback, or move to option B.
- Sustained traffic exceeds roughly 5M requests/month, where an always-on
  container starts to be cheaper than per-request billing.
- A second page type appears that is genuinely user-specific, which would
  invalidate option B permanently and is worth noting when it happens.
