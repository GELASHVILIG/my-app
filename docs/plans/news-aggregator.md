# Tech news aggregator

## Problem

People who follow tech/programming news today check a handful of separate
sources (blogs, HN, publications) individually or subscribe to too many RSS
feeds to reasonably read. There's no single place that pulls the curated
sources one person trusts into one page that stays current on its own.

## In scope (v1)

- A curated list of tech/programming RSS feeds, fetched on a schedule
- A public web page listing recent articles (title, source, published time,
  link out to the original) sorted by recency, deduplicated across sources
- Automatic refresh — new articles appear without a manual redeploy
- Basic visit tracking (page views, rough unique-visitor count) so it's
  possible to tell whether anyone besides you is coming back

## Out of scope (v1)

- User accounts, login, personalization, saved articles
- Comments, likes, voting, any social feature
- Full article text / reader view — v1 only links out to the source
- Search, filtering, multiple topic categories
- Submitting feeds via UI — the feed list is a config file you edit
- A mobile app
- Any topic besides tech/programming

## Assumptions

- **Hosting: AWS, serverless.** Fits the existing `infra/` CDK setup and the
  "keep it cheap" constraint — pay-per-request instead of an always-on
  server. A scheduled Lambda (EventBridge rule) fetches feeds; a second
  Lambda behind API Gateway serves the page.
- **Storage: DynamoDB.** One table, articles keyed by dedup hash of URL,
  queried by recency. Cheap at this scale, no ops burden, on-demand billing.
- **Rendering: server-rendered HTML, no frontend framework.** Keeps the
  Lambda bundle small and cold starts fast; nothing to build/ship
  client-side for a page that's just a sorted list of links.
- **Analytics: self-hosted, not a third-party service.** A view counter
  written to DynamoDB per request, keyed by day + a first-party cookie for
  rough uniqueness. Avoids adding a paid dependency or a privacy question
  for a "keep it cheap" personal project. If you want real analytics later
  (funnels, geography, referrers) that's a deliberate upgrade, not v1.
- **Fetch cadence: every 30 minutes.** Tech news doesn't need faster than
  that, and it keeps Lambda invocation volume (and cost) low.

These are marked as assumptions, not decisions — they should get an ADR
from the `architect` agent before implementation starts, per the working
agreement in `CLAUDE.md`.

## Milestones

### M1 — One feed, end to end
A single hardcoded RSS feed is fetched, stored, and rendered at a live
URL. Proves the full pipeline (fetch → store → serve → deploy) works
before adding scale or polish.

**Demo:** visit the URL, see real articles from that one feed.

### M2 — Curated feed list, self-refreshing
Replace the single feed with a real curated list (10+ tech/programming
sources). A scheduled job keeps articles current with no manual steps.
Articles are deduplicated across sources and sorted by recency. One
broken feed doesn't take down the others.

**Demo:** come back the next day without touching anything and see new
articles that weren't there yesterday.

### M3 — Visit tracking
Every page view is counted. A way to see totals (a `/stats` endpoint or a
CloudWatch dashboard) exists so you can tell whether real people are
returning.

**Demo:** load the page a few times from different browsers/devices, check
the counter moved.

## Tasks

Roughly one agent session each; listed in dependency order.

1. **Domain — article model + RSS parsing** (`src/domain`): parse RSS/Atom
   XML into a plain `Article { title, url, source, publishedAt }`, pure
   function, no I/O, unit-testable with fixture XML. *No dependencies.*
2. **Adapter — feed fetcher** (`src/adapters`): HTTP fetch of a feed URL
   with a timeout, feeding raw XML to the domain parser. *Depends on 1.*
3. **Adapter — article store** (`src/adapters`): DynamoDB put (dedup by
   URL hash) and query-recent. *No dependencies, can run parallel to 1–2.*
4. **Service — aggregation** (`src/services`): given a list of feed URLs,
   fetch each (isolated try/catch per feed, log + skip failures), parse,
   dedupe, persist new articles. *Depends on 1, 2, 3.*
5. **Infra — data + schedule stack** (`infra/`): DynamoDB table, scheduled
   Lambda running the aggregation service, EventBridge rule (30 min).
   *Depends on 4.*
6. **HTTP — article list page** (`src/http`): route rendering stored
   articles as server-rendered HTML, most recent first. *Depends on 3.*
7. **Infra — web stack** (`infra/`): API Gateway + Lambda serving the HTTP
   layer. *Depends on 6.*
8. **Seed feed list**: research and commit 10+ real tech/programming RSS
   feed URLs as config. *No code dependency, needed before M2 demo.*
9. **Visit tracking** (`src/services`, `src/http`): increment a per-day
   counter + first-party cookie on each page view; `/stats` route or
   CloudWatch metric to read it back. *Depends on 6, 7.*
10. **E2E** (`tests/e2e`): Playwright check that the homepage loads and
    shows at least one article link. *Depends on 7.*

M1 = tasks 1, 2, 3, 4 (single hardcoded feed), 5, 6, 7.
M2 = task 8 (real feed list) + hardening task 4's per-feed isolation.
M3 = task 9.

## Acceptance criteria

- **M1:** `GET /` returns 200 and renders at least the articles present in
  the one seed feed, each with title, source name, published date, and a
  working link to the original article.
- **M2:** 10+ feeds configured; two articles with the same URL from
  different feeds render once; a feed returning malformed XML or a
  non-200 response is logged and skipped without breaking the page for
  the other feeds; an article published after the last deploy appears on
  the page within one fetch cycle (30 min) with no manual action taken.
- **M3:** each page load increments a view counter; the counter is
  queryable (via `/stats` or a CloudWatch dashboard) and reflects the
  actual number of loads within one polling interval.

## Risks

- **RSS feeds are inconsistent** (malformed XML, feeds that disappear or
  change format). Cheapest way to find out early: build the parser
  against 2–3 real feeds in task 1 before writing the other 7+ into the
  config in task 8, rather than assuming standard RSS/Atom compliance.
- **Cold-start latency** on Lambda could make the page feel slow. Cheapest
  mitigation: keep the HTTP Lambda's dependency footprint minimal (no
  heavy templating engine) and check real cold-start latency after M1
  before investing in provisioned concurrency or a different compute
  model.
- **"Real visitors return" is a distribution problem, not an engineering
  one.** Nothing in this plan gets you an audience — that's on sharing the
  link somewhere your niche already is. Building M1–M3 only makes it
  possible to know if that worked, not likely.
