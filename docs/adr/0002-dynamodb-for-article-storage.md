# 0002. DynamoDB on-demand for article and stats storage

Status: accepted
Date: 2026-08-14

## Context

The aggregator needs to store deduplicated articles and answer exactly one query
in v1: *"the N most recent articles."* Search, filtering, and categories are
explicitly out of scope. It also needs a small counter for visit tracking
(ADR 0005).

Forces:

- **The house default is one Postgres.** The `solution-architecture` skill says
  reach for anything else only with a recorded reason. This ADR is that reason.
- **Data volume is trivial.** ~30 feeds × ~20 items × 48 fetches/day, of which
  almost all are repeats. Expect a few hundred genuinely new articles per day and
  a working set well under 100 MB with a 30-day retention window.
- **Access is entirely key-based.** Write-if-absent by URL identity; read a
  recency-ordered page. No joins, no aggregates, no ad-hoc queries.
- **Cost at idle must be ~$0** (ADR 0001), and nothing may require a VPC, because
  a VPC Lambda needs a NAT Gateway at ~$32/mo.
- Article identity (the dedup key) and the URL normalization rules that produce
  it are the **hardest things here to change later** — they propagate into every
  stored item. They are recorded below deliberately.

## Options considered

### A. DynamoDB, on-demand billing

- **Fit:** exact. Conditional `PutItem` with `attribute_not_exists` is dedup *and*
  idempotency in one call. A GSI sorted by publish time answers the only query.
  Atomic `ADD` gives a counter without read-modify-write.
- **Cost at idle:** **$0.00/mo.** Storage sits far inside the always-free 25 GB
  allowance. At load: on-demand writes ≈ $0.625/M and reads ≈ $0.125/M, so a few
  hundred writes/day and 10k page reads/month is **under $0.05/mo**. No hourly
  charge of any kind.
- **Operational burden:** essentially none — no version upgrades, no connection
  pool, no VPC, no vacuum, no disk to fill.
- **Exit cost:** low *because the data is small and mostly reconstructible*. A
  few thousand items export trivially. The real lock-in is the access pattern
  assumption, not the data.
- **Cons:** any query we did not design for requires a scan or a new index. No
  SQL for poking around; inspection means the console or a script.

### B. A single JSON blob in S3

The ingest job writes `articles.json`; the web Lambda reads it.

- **Fit:** genuinely viable for v1 and the cheapest possible thing that works.
  Dedup and sorting happen in memory. S3 conditional writes (`If-Match`) make the
  read-modify-write safe even with concurrent writers.
- **Cost at idle:** ~$0.00/mo. At load: a GET per page view is $0.0004/1000.
- **Operational burden:** near zero.
- **Exit cost:** low.
- **Rejected because:** every write rewrites the whole file (fine at 1k items,
  unpleasant at 50k); there is no atomic increment, so the ADR 0005 counter would
  need its own mechanism anyway; there is no per-item TTL, so expiry becomes
  application logic; and a partial write during ingestion can lose the entire
  corpus rather than one item. It saves perhaps $0.05/month over option A in
  exchange for hand-rolling three things DynamoDB gives for free.

### C. Postgres — RDS `db.t4g.micro`

- **Fit:** excellent, and the stated default. `INSERT ... ON CONFLICT DO NOTHING`
  is dedup; `ORDER BY published_at DESC LIMIT 50` is the query; future filtering
  and full-text search come for free.
- **Cost at idle:** ~**$11.68/mo** for the instance plus ~$2.30 for 20 GB gp3 ≈
  **$14/mo**, billed continuously whether or not anyone visits. The 12-month free
  tier expires and this is meant to outlive it.
- **Operational burden:** meaningful — minor version upgrades, storage
  monitoring, backups, and a VPC. Connecting a Lambda to it either means a VPC
  Lambda (NAT Gateway, +$32/mo) or the RDS Data API/RDS Proxy (more cost, more
  parts).
- **Rejected because** it fails the skill's own escape clause in reverse: the
  access pattern *does* fit relational perfectly, but $14–46/mo to serve a page
  with one query violates the spec's hard cost constraint by roughly 30x. This is
  a deliberate deviation from the documented default and the only reason is cost
  at idle.

### D. Aurora Serverless v2

- **Cost at idle:** ~$43/mo at the historical 0.5 ACU floor. Scale-to-zero with
  auto-pause now exists, which makes idle much cheaper, but resume adds
  seconds of latency to a cold page load and it still lives in a VPC.
- **Rejected because** it is the most expensive option on the list for the least
  benefit, and the VPC requirement drags the NAT Gateway problem back in.

### E. SQLite (in the bundle, or on EFS, or replicated to S3 via Litestream)

- **Cost at idle:** ~$0 (EFS adds ~$0.30/GB-mo and a VPC).
- **Rejected because** a read-only SQLite baked into the deploy bundle cannot
  accept new articles between deploys, which breaks the core "refreshes itself"
  requirement; and Litestream/LiteFS on Lambda is novel infrastructure with
  concurrency caveats. The skill's preference for boring, well-documented
  services applies directly.

### Sub-decision: one table or two?

- **One table** (articles + feed state + stats, single-table style): fewer
  resources, one adapter.
- **Two tables** (Articles, Stats): identical cost ($0 either way), but the web
  Lambda can be granted *read-only* on Articles and write on Stats with one
  `grant` call each, instead of a hand-written `dynamodb:LeadingKeys` condition.
  Preserves one-writer-per-table: only ingest writes articles, only web writes
  stats. A bug in the request handler cannot corrupt the article corpus.

## Decision

**DynamoDB with `PAY_PER_REQUEST` billing, in two tables: `Articles` and
`Stats`.** This confirms the plan's assumption. It is a deliberate deviation
from the "one Postgres" default, made solely because Postgres costs $14+/month at
idle and this project must cost approximately nothing at idle.

The trade-off accepted: **we give up ad-hoc querying.** The first feature that
wants "articles from source X in the last week" or full-text search will need a
new GSI, a scan, or a different store. That is acceptable because search,
filtering and categories are explicitly out of scope for v1, and because at this
data volume even a full scan of the table costs a fraction of a cent.

Two tables rather than one is a deviation from single-table orthodoxy, chosen for
least-privilege IAM and blast radius, at zero cost. It is still **one datastore**
— no second database technology enters the project.

### `Articles` table

| | |
|---|---|
| PK | `pk` (string) |
| Item types | `ARTICLE#<id>` and `FEED#<url>` — both written only by the ingest Lambda |
| GSI `byPublishedAt` | PK `gsiPk` = constant `"ARTICLE"`, SK `gsiSk` = `<publishedAt ISO-8601 UTC>#<id>` |
| GSI projection | `INCLUDE` (title, url, source, publishedAt) — avoids a second read on the render path |
| TTL | attribute `ttl`, 30 days after `fetchedAt`, on `ARTICLE#` items only |

- **`id` = SHA-256 of the normalized URL**, hex encoded. This is the dedup key
  and it is the single hardest thing here to change later.
- **URL normalization (fixed, and part of the identity contract):** lowercase
  scheme and host; drop default ports; drop the fragment; drop tracking
  parameters (`utm_*`, `ref`, `source`, `fbclid`, `gclid`); sort remaining query
  parameters; strip a single trailing slash; preserve path case. This lives in
  `src/domain` as a pure function with unit tests, because changing it changes
  every future id and must be a visible, deliberate act.
- **Writes are conditional puts** (`attribute_not_exists(pk)`), which makes the
  whole ingest run idempotent under Lambda's at-least-once retry semantics.
- **Recency query:** `Query` the GSI with `ScanIndexForward: false, Limit: 50`.
  A constant partition key means all articles share one GSI partition. That is a
  hot-partition anti-pattern at scale and completely fine here — the ceiling is
  1,000 WCU/3,000 RCU on a single partition and we are three orders of magnitude
  below it. **Revisit** if sustained writes approach 100/second; the fix is
  sharding `gsiPk` into `ARTICLE#<0-9>` and querying all shards.
- **`FEED#` items** hold per-feed state: `etag`, `lastModified`, `lastSuccessAt`,
  `lastSeenPublishedAt`. Same writer, same table, no extra resource (ADR 0003).

### `Stats` table

| | |
|---|---|
| PK | `day` (string, `YYYY-MM-DD` UTC) |
| SK | `#counts` for the counter item, `v#<hash>` for visitor-fingerprint items |
| TTL | attribute `ttl`, 48h on `v#` items only; counters never expire |

Counters use atomic `ADD`. Counter items are tiny and permanent — this is the
only data in the project that cannot be reconstructed.

### Table settings (both)

- `billingMode: PAY_PER_REQUEST`. On-demand, never provisioned: provisioned
  capacity means capacity planning, and the free provisioned tier is not worth
  the attention it costs.
- `removalPolicy: isProd ? RETAIN : DESTROY`, set explicitly, never defaulted.
- `pointInTimeRecovery: isProd`. Cheap (~$0.20/GB-month on a table measured in
  megabytes) and it is the only restore path for `Stats`.
- Default AWS-owned encryption key. A customer-managed KMS key costs $1/month —
  more than the entire rest of the design — and there is no compliance
  requirement to justify it.
- IAM by grant methods only: ingest gets `grantReadWriteData(articles)`; web gets
  `grantReadData(articles)` + `grantWriteData(stats)` + `grantReadData(stats)`.
  No hand-written policies, no `*`.

**Cost at idle: $0.00/month.** Expected at load: under $0.05/month.

## Consequences

**Easier:** dedup, idempotency, expiry and atomic counting are all primitives
rather than code. No VPC, no connection pooling, no maintenance windows. The
storage bill cannot grow unnoticed because TTL caps the corpus at 30 days.

**Harder:** the adapter layer (`src/adapters`) has to hide DynamoDB's item shape
completely — `src/domain` and `src/services` must speak in `Article` objects and
a narrow port interface, or the query model leaks upward and the exit cost stops
being low. Debugging means the console or a script, not `psql`. Anything wanting
a new access pattern needs an index designed up front.

**Accepted losses:** articles older than 30 days are gone permanently; there is
no archive. If an "all-time" view is ever wanted, that is a new decision (S3
Parquet exports, or dropping the TTL and paying storage) and it must be made
*before* 30 days of history are wanted, not after.

**Revisit when:** search or per-source filtering enters scope; or the item count
exceeds ~1M, where GSI partition and scan costs start to matter; or a second
genuinely relational feature appears — at which point the answer is to move
wholesale to Postgres, not to add a second database alongside this one.
