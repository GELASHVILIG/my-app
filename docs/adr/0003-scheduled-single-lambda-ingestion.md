# 0003. Feed ingestion: one scheduled Lambda, every 30 minutes

Status: accepted
Date: 2026-08-14

## Context

Articles must appear without a manual redeploy (`docs/plans/news-aggregator.md`,
M2). The plan assumes an EventBridge schedule at 30-minute intervals invoking a
Lambda, and flags the cadence as unconfirmed.

Forces:

- ~10–30 feeds in v1, each a single HTTP GET returning tens to hundreds of KB of
  XML. Total work per cycle is a few seconds of mostly-waiting.
- **One broken feed must not break the others** — an explicit M2 acceptance
  criterion.
- Feeds are third-party infrastructure we do not control and do not pay for.
  Politeness is a real constraint: aggressive polling gets an IP blocked, which
  is a failure mode with no error message.
- Invocation cost is *not* a real constraint here. 48 runs/day × 30 days × ~5s ×
  1 GB ≈ 7,200 GB-seconds/month, comfortably inside Lambda's always-free 400k
  GB-second allowance. The plan's stated rationale ("keeps cost low") is true but
  not load-bearing — cadence is a freshness and politeness decision.
- Lambda invocation is at-least-once. Duplicate runs must not create duplicate
  articles.

## Options considered

### A. One EventBridge rule → one Lambda that fetches all feeds in-process

- **Fit:** good. The whole job is ~30 concurrent HTTP GETs and a few hundred
  conditional writes; it finishes in seconds.
- **Cost at idle:** **$0.00/mo.** Scheduled EventBridge rules are free; the
  Lambda time is inside the free tier.
- **Operational burden:** one function, one log group, one DLQ, one alarm.
- **Exit cost:** low — the per-feed function already has the right signature to
  become an SQS consumer later.
- **Cons:** all feeds share one timeout budget, so a pathological feed eats time
  from the others (bounded by a per-fetch timeout); one poison feed retried
  repeatedly re-runs every other feed too (harmless, since writes are idempotent).

### B. EventBridge → SQS fan-out, one message per feed, worker Lambda

- **Fit:** the textbook answer. True isolation, per-message retries, per-feed DLQ
  visibility, trivially parallel.
- **Cost at idle:** ~$0.00/mo (SQS free tier covers 1M requests).
- **Operational burden:** a queue, a producer, a consumer, batch-failure handling,
  and two more things that can be misconfigured.
- **Rejected because** it is distributed-systems machinery for thirty HTTP GETs
  that complete in four seconds. `Promise.allSettled` provides the same isolation
  in one line and with a stack trace you can read. This is the designated escape
  hatch if the feed count grows — see revisit triggers.

### C. Step Functions Map state, one execution branch per feed

- **Fit:** good visual observability of which feed failed.
- **Cost:** Standard workflows charge per state transition; ~30 feeds × 48
  runs/day × several transitions ≈ ~130k transitions/month ≈ $3/mo, i.e. more
  than the entire rest of the design.
- **Rejected because** it costs more than everything else combined and adds a
  second orchestration language (ASL) to a project that already has TypeScript.

### D. Lambda per feed, each with its own schedule

- **Rejected out of hand.** Thirty functions, thirty log groups, thirty alarms,
  one developer. This is the microservices anti-pattern in miniature.

### Cadence

- **Every 5–10 minutes:** measurably fresher for breaking news; 3–6x the
  outbound requests to feed publishers; still free.
- **Every 30 minutes (assumed):** 48 runs/day. Freshness is well within what
  "tech news" means — the sources themselves publish on the order of hours.
- **Hourly:** halves outbound traffic; makes the site feel stale during a busy
  news morning; would require rewriting the M2 acceptance criterion.

## Decision

**Option A, at the assumed 30-minute cadence: one EventBridge rule
(`Schedule.rate(Duration.minutes(30))`) invoking one ingest Lambda that fetches
all feeds concurrently.** The cadence is confirmed, but for freshness and
politeness reasons rather than cost — cost does not distinguish any of these
choices.

**EventBridge Rule, not EventBridge Scheduler.** Scheduler's flexible time
windows and one-time schedules buy nothing for a single fixed recurrence, and
rules are free and older. Boring wins.

The trade-off accepted: **all feeds share one invocation, so failure isolation is
in application code rather than infrastructure.** A per-feed `try`/`catch` is
weaker than a per-message SQS retry — a feed that fails will not be retried until
the next cycle. That is fine because the next cycle is 30 minutes away and the
content is news, not payments.

Binding specifics:

- **Concurrency and isolation:** `Promise.allSettled` over feeds with a
  concurrency cap of 6. Each feed's failure is caught, logged as a structured
  `feed.fetch.failed` event with the feed URL and error class, and skipped.
- **Timeouts:** `AbortSignal.timeout(5000)` per feed fetch. Lambda `timeout: 60s`,
  `memorySize: 1024` (memory is CPU; XML parsing is CPU-bound and 1024 MB often
  costs less than 512 MB by finishing sooner). Both revisited against real
  measurements after M1.
- **Response size guard:** abort any feed response over ~5 MB, so one
  misconfigured feed cannot exhaust Lambda memory.
- **Conditional GET:** send `If-None-Match` / `If-Modified-Since` from the stored
  `FEED#` item (ADR 0002) and treat `304` as success-with-no-work. This is both
  good citizenship and the main write-cost control — unchanged feeds produce zero
  DynamoDB writes.
- **Watermark:** skip items older than the feed's `lastSeenPublishedAt` before
  attempting a put. Without this, every cycle burns ~29k conditional writes/day
  on articles we already have (~$0.54/mo — small, but it is 100% waste and it is
  the largest line item in the storage bill).
- **Identifying User-Agent** naming the project with a contact URL. Some feeds
  reject unknown agents outright, and an anonymous poller is the kind of thing
  that gets blocked without notice.
- **Idempotency:** conditional put on `attribute_not_exists(pk)` (ADR 0002). Safe
  under retries and overlapping runs by construction.
- **Reserved concurrency: 1** on the ingest function. Guarantees no overlapping
  runs and caps the blast radius of any accidental invocation loop.
- **Async invocation config:** `retryAttempts: 2`, `maxEventAge: 1 hour`, then an
  SQS **dead-letter queue** (14-day retention, in the stateful stack).
- **Alarms** (SNS → email, each with a runbook line): any visible message in the
  DLQ; `Invocations` sum < 1 over 2 hours with
  `treatMissingData: BREACHING` — the "scheduled job silently stopped" case,
  which is the failure this design is most likely to hit and the one nothing else
  would notice.
- **Feed list is a checked-in config file**, not a table. It changes by deploy,
  which is exactly the review process it should have, and it keeps the write path
  free of configuration state.

Layering (`CLAUDE.md`): RSS/Atom parsing, URL normalization, dedup and ordering
are pure functions in `src/domain` with fixture-XML unit tests. HTTP fetching and
DynamoDB access are `src/adapters`. Orchestration — iterate feeds, isolate
failures, persist — is `src/services`. The Lambda handler in `infra/`-referenced
entry code is a thin shim that wires adapters into the service and does nothing
else.

**Cost at idle: $0.00/month** (EventBridge scheduled rules are free; ingest
Lambda time is inside the always-free tier). Expected total ingest cost including
DynamoDB writes: **under $0.05/month** with the watermark and conditional-GET
controls, roughly $0.60/month without them.

## Consequences

**Easier:** one function to reason about, one log group to search, one stack
trace when something breaks. Retries are safe by construction. Adding a feed is a
one-line config change and a deploy.

**Harder:** feed-level observability is only as good as the log events we emit —
there is no queue depth or per-feed metric to look at, so the structured
`feed.fetch.failed` event is the only signal that a source has quietly died. A
feed that returns HTTP 200 with valid-but-empty XML will look healthy forever;
consider a follow-up "no new articles from source X in 7 days" check once the
real feed list exists (M2), not before.

**Accepted risk:** a single cycle can be lost entirely (Lambda failure after
retries) and nothing recovers it beyond the next cycle picking up whatever is
still in the feed window. For news links, this is invisible.

**Correction, M1 — the watermark does not hold for ranked feeds.** The
`lastSeenPublishedAt` watermark specified above assumes a feed is ordered by
publish time, so that anything older has already been seen. Hacker News' front
page, the M1 feed, is ranked rather than chronological: `pubDate` is submission
time, and a story frequently climbs onto the page hours after it was submitted.
Skipping on publish time therefore drops exactly the stories we want, and does so
permanently and silently. M1 ships without the skip and relies on the conditional
put (`attribute_not_exists(pk)`) alone for dedup, which is correct by
construction; the cost is the wasted conditional writes this bullet was meant to
avoid, which is cents per month. A per-feed "is this feed chronological" flag is
the obvious way to bring the watermark back once the M2 feed list exists.

**Revisit when:** the feed list exceeds ~100 sources, or a cycle's p95 duration
exceeds ~30s (half the timeout) — at which point move to option B (SQS fan-out),
which the service layer is already shaped for. Also revisit the cadence if a feed
publisher complains or starts returning 429; the fix is a longer interval and
per-host backoff, and it is a one-line change.
