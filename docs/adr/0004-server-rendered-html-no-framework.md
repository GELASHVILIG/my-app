# 0004. Server-rendered HTML, no framework, no client-side JavaScript

Status: accepted
Date: 2026-08-14

## Context

The v1 page is a sorted list of links: title, source name, published time, and an
outbound anchor. There is no interactivity in scope — no search, no filtering, no
accounts, no comments. The plan assumes server-rendered HTML with no frontend
framework and flags it as unconfirmed.

Forces:

- ADR 0001 puts a Lambda in the request path, so **bundle size is latency**.
  Every dependency in the render path is paid for on every cold start.
- The content is entirely third-party text. **Feed titles are
  attacker-influenced input** — anyone who can publish to an aggregated feed can
  put `<script>` in a title. This is the only real security exposure in v1.
- One developer maintaining this in a year. A build step for the frontend is a
  second toolchain to keep alive.
- The page must be readable and shareable — plain HTML is also the best possible
  input to link previews, readers, and search engines.

## Options considered

### A. Plain template functions in `src/http`, no framework

Tagged-template or plain string functions returning HTML, with one shared escape
helper.

- **Fit:** exact for a static list of links.
- **Cost:** zero dependencies, ~nothing added to the bundle, no build step.
- **Operational burden:** none, but escaping is a discipline rather than a
  guarantee — a forgotten `escapeHtml` is an XSS hole.
- **Exit cost:** low. Swapping in a template engine later touches one module.

### B. A small template engine (Eta, Mustache, Handlebars)

- **Fit:** good. Auto-escaping by default is a genuine safety improvement over A.
- **Cost:** ~10–50 KB added to the Lambda bundle; templates become separate files
  that must be bundled correctly for Lambda (a classic packaging foot-gun with
  `NodejsFunction`).
- **Rejected because** the safety benefit is real but small at this size — one
  escape helper plus a unit test with a malicious-title fixture buys the same
  protection — and because it introduces a bundling failure mode that only shows
  up after deploy. Reconsider if the page ever grows past a handful of templates.

### C. React / Preact server-side rendering

- **Fit:** overkill. JSX auto-escapes, which is nice; everything else is unused.
- **Cost:** hundreds of KB of dependencies and a JSX build step, paid on every
  cold start, for a page with no state and no components worth reusing.
- **Rejected because** it optimizes for component reuse and interactivity that
  this page will never have.

### D. Client-side SPA against a JSON API

- **Fit:** poor. It turns one request into two, makes the page blank until JS
  runs, and hurts crawlers and link previews for a site whose entire purpose is
  being linked.
- **Rejected** on all counts. Also incompatible with the no-JS security posture
  below.

### E. Pre-rendered static HTML file

Covered and rejected in ADR 0001 (option B there) — it moves rendering into the
ingestion path and breaks per-request view counting.

## Decision

**Option A: server-rendered HTML produced by plain template functions in
`src/http`, with no frontend framework, no build step, and — deliberately — no
client-side JavaScript at all.** This confirms the plan's assumption and extends
it: the page ships zero `<script>` tags.

The trade-off accepted: **manual escaping discipline in exchange for a
zero-dependency render path.** A forgotten escape is a real XSS risk, and we are
choosing to manage that with a single choke-point rather than a framework
guarantee. Two things make that acceptable:

1. **One `escapeHtml` choke point.** All feed-derived text (title, source name)
   goes through it. A unit test renders an article whose title is
   `<img src=x onerror=alert(1)>` and asserts the output contains no raw `<`.
   That test is the guarantee; it must exist before M1 ships.
2. **A content security policy that removes the payoff:**
   `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:;`
   With no script source permitted at all, injected script does not execute even
   if escaping fails. Belt and braces, at the cost of one header.

Also binding:

- Styling is a small inline `<style>` block. No stylesheet request, no CSS
  framework, no font CDN — a third-party font request is a third-party dependency
  and a privacy leak (see ADR 0005 for why that matters here).
- Outbound article links carry `rel="noopener noreferrer nofollow ugc"` and
  `target="_blank"`. `nofollow ugc` is honest about the fact that we did not
  vouch for these links.
- Semantic HTML: `<ol>` of `<li>`, `<time datetime="...">` for published time so
  the machine-readable timestamp survives whatever we do to the display format.
- Security headers alongside CSP: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.
- Rendering lives in `src/http` and imports **only** `src/domain` types. It must
  not import from `src/adapters` — the handler passes it an array of `Article`
  objects. This keeps the renderer a pure function that can be unit-tested with
  no AWS anything.
- `Cache-Control: public, max-age=300` per ADR 0001.

**Cost at idle: $0.00/month.** This decision adds no AWS resources; its cost
impact is a smaller Lambda bundle and therefore shorter cold starts.

## Consequences

**Easier:** the render path has no dependencies to update, no build step to break,
and no client-side failure mode. The page works with JS disabled, on any browser,
on a bad connection, and in every RSS reader and link-preview crawler. Cold
starts stay as small as ADR 0001 allows. The whole renderer is unit-testable with
a fixture array and a string assertion.

**Harder:** any future interactivity (filtering, infinite scroll, a dark-mode
toggle that isn't pure CSS) requires either a full-page-reload design or
revisiting this ADR. Formatting logic that a template engine would give for free
— relative times, truncation, pluralization — is hand-written. Non-trivial layout
changes mean editing string concatenation, which gets unpleasant somewhere around
three or four distinct page types.

**Revisit when:** the site grows a second and third page type, or any feature
genuinely requires client-side state. The upgrade path is option B (a small
auto-escaping engine), not option C or D — and the CSP means adding client JS is
a conscious, visible change to a header rather than something that creeps in.
