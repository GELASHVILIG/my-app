# 0005. First-party visit tracking, in DynamoDB, without cookies

Status: accepted
Date: 2026-08-14

## Context

M3 of `docs/plans/news-aggregator.md` wants to know whether anyone besides the
author is visiting and coming back: page views and a rough unique-visitor count,
readable via `/stats` or a CloudWatch dashboard. The plan assumes a self-hosted
counter in DynamoDB keyed by day plus a first-party cookie for uniqueness, and
flags it as unconfirmed.

Forces:

- **The stated question is small.** "Is anyone out there?" — not funnels, not
  retention cohorts, not attribution. Any answer accurate to within a factor of
  two is sufficient to make the only decision it informs (keep going or stop).
- **Cost ceiling** and a stated preference to avoid third-party dependencies and
  the privacy questions they bring.
- ADR 0004 ships **no client-side JavaScript**. Any option requiring a JS snippet
  is either rejected or forces that ADR to be reopened.
- A cookie set for analytics is a *non-essential* cookie. Under the EU ePrivacy
  Directive that requires consent regardless of whether it is first-party and
  regardless of whether the value is anonymous. A consent banner on a page that
  is otherwise a list of links is a bad trade for a hobby project.
- ADR 0001 defers CloudFront. Anything that caches full pages at the edge makes
  per-request counting undercount, so this decision and that one are coupled.

## Options considered

### A. DynamoDB counter + first-party cookie (the plan's assumption)

- **Fit:** good. Set an opaque random id in a `Set-Cookie` on first visit; count
  a unique when the request arrives without one. Uniqueness is stable across days
  for the same browser, which is the *better* signal for "are people coming
  back".
- **Cost:** ~2 extra DynamoDB writes per view; under $0.01/mo at 10k views.
- **Operational burden:** low.
- **Rejected because** it is precisely the thing that triggers a cookie-consent
  obligation for EU visitors. Adding a consent banner would cost more effort than
  the entire analytics feature and would require the client-side JS that ADR 0004
  removes; not adding one is a compliance gap on a public site. The whole point
  of self-hosting here was to *avoid* the privacy question, and this option
  reintroduces it.

### B. DynamoDB counter + cookieless daily-rotating-salt fingerprint (chosen)

Derive `hash = SHA-256(salt_of_the_day || client_ip || user_agent)`, truncated.
Store the hash, never the inputs. The salt rotates daily and the previous day's
salt is not retained, so yesterday's hashes cannot be recomputed or linked to
anyone.

- **Fit:** good enough. This is the approach Plausible and similar tools use
  precisely to avoid cookies.
- **Cost:** identical to A — 2 writes per view, under $0.01/mo.
- **Operational burden:** low. One SSM parameter, one date-derived salt.
- **Cons:** accuracy is rougher — visitors behind shared NAT undercount, mobile
  users whose IP changes overcount, and uniqueness cannot span days by design
  (so it answers "how many distinct visitors today", not "how many returned").

### C. Third-party analytics (Plausible, Fathom, Umami, GA4)

- **Fit:** far more capability than asked for — referrers, geography, trends.
- **Cost:** Plausible/Fathom ~$9–14/mo, which is 20x the entire rest of the
  design. Umami self-hosted needs an always-on container and a Postgres (~$15/mo,
  ADR 0001 option C and ADR 0002 option C, both already rejected). GA4 is free.
- **Rejected because** the paid options break the cost constraint outright, the
  self-hosted option breaks it via infrastructure, and GA4 is free only in the
  sense that the visitors pay — it sends visitor data to an ad company, requires
  a consent banner and a privacy policy, and requires the client-side JS that ADR
  0004 removes. Every variant contradicts a constraint the user stated.

### D. CloudWatch metrics only (API Gateway / Lambda request counts, or EMF)

- **Fit:** partial. Request count is free, already collected, and graphable
  today with zero code.
- **Cost:** $0. Ten CloudWatch alarms and basic metrics are in the always-free
  tier.
- **Rejected as the sole mechanism because** it cannot distinguish visitors from
  bots, or one person reloading twenty times from twenty people. "Is anyone
  besides me visiting" is exactly the question it cannot answer. It is kept as a
  free supplement, not the answer.

### E. Access logs to S3 + Athena

- **Rejected:** a data pipeline that costs more (S3 storage, per-query scanning)
  and takes more effort than the counter it would replace. This is the correct
  answer only if full-page CDN caching is introduced later.

## Decision

**Option B: a self-hosted counter in DynamoDB, incremented server-side on each
page render, with cookieless daily-rotating-salt fingerprinting for the rough
unique count.** This keeps the plan's "self-hosted, not third-party" decision and
its DynamoDB counter, and **changes the uniqueness mechanism from a cookie to a
rotating hash** so that no consent banner is required and no identifier is stored
on the visitor's device or in our table.

The trade-off accepted: **less accurate uniques, and no cross-day identity.** We
cannot say "40% of visitors returned this week" — only "N views and roughly M
distinct visitors per day". That is worse than option A and much worse than
option C, and it does not matter because the decision this data informs is binary
("is this reaching anyone") and a daily distinct count answers it.

Mechanics:

- **On each page render**, after the HTML is composed and before the response is
  returned:
  1. `UpdateItem` on `Stats` (`day`, `#counts`) with `ADD views 1`.
  2. Conditional `PutItem` of `(day, v#<hash>)` with `attribute_not_exists`; if
     it succeeds, `ADD uniques 1`. If it fails, this visitor was already counted
     today. Visitor items carry a 48-hour TTL.
- **The salt** is a random value in an SSM Parameter Store `SecureString`
  (free; Secrets Manager would be $0.40/month/secret for no benefit — there is
  nothing to rotate automatically). The effective daily salt is derived from it
  plus the UTC date, so it rotates without any moving parts.
- **What is stored:** a truncated hash and a day. No IP, no user-agent string, no
  cookie, no PII, ever — this is a hard rule for the adapter and worth an
  assertion in its unit test.
- **Latency:** the two writes are awaited, adding roughly 10ms. Fire-and-forget
  is not an option on Lambda (the execution environment freezes after the
  response). 10ms on a page with a 300ms cold start is not worth engineering
  around.
- **Failure mode: analytics never breaks the page.** The counter write is wrapped
  so that any error is logged as `stats.write.failed` and swallowed. Losing a
  view count is nothing; losing the page over a view count is absurd.
- **`/stats`** returns JSON — per-day views and uniques for the last 30 days —
  and is **public**. It exposes no personal data, and a private endpoint would
  need auth, which is more machinery than the data is worth. It is served with
  `Cache-Control: public, max-age=300`.
- **A structured `page.view` log event** is emitted per request regardless. If a
  CloudWatch chart is ever wanted, promoting it to an EMF metric is a code change
  of a few lines with no extra service — option D stays available for free.
- **Bots are not filtered in v1.** The M3 acceptance criterion says the counter
  reflects actual loads, and it will — including crawler loads. Uniques are
  labelled "approximate" wherever they are displayed. If the numbers become
  obviously bot-dominated, a small user-agent denylist is the fix, and it is a
  one-file change.
- **Privacy note in the page footer**, one sentence: no cookies, no third
  parties, aggregate counts only. It is true, and it is cheaper than a policy.

**Cost at idle: $0.00/month.** At 10k views/month: roughly 20k DynamoDB writes ≈
**$0.02/month**. SSM Parameter Store standard parameters are free.

## Consequences

**Easier:** no consent banner, no privacy policy obligation beyond one honest
sentence, no third-party script, no vendor account, no client-side JavaScript.
The data lives in our own table and `/stats` is queryable without leaving the
project. Nothing about this decision can generate an unexpected bill.

**Harder:** every page render now performs two writes, so the read path is no
longer read-only — the web Lambda needs write access to `Stats` (which is exactly
why ADR 0002 keeps `Stats` in a separate table from `Articles`). Unique counts
are approximate and not comparable across days in the "returning visitor" sense.
And this is the only non-reconstructible data in the project, which is what
justifies point-in-time recovery on that table.

**Coupling to ADR 0001 — read this before adding a CDN.** Per-request counting
only works while every request reaches the Lambda. If CloudFront is added to
mitigate cold starts, cached hits become invisible and the counter will
undercount, possibly badly. The options at that point are: exclude `/` from
caching (defeats the purpose), count from CloudFront logs (option E, now
justified because the alternative no longer works), or accept the undercount as a
lower bound. Whichever is chosen, it supersedes this ADR rather than amending it.

**Revisit when:** the question changes from "is anyone here" to "where are they
coming from and what do they click" — that is a genuinely different requirement
and the honest answer then is a hosted analytics product, accepted as a real
monthly cost with a real consent story, not a bigger home-grown counter.
