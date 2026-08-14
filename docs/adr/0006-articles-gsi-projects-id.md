# 0006. `byPublishedAt` GSI projects `id` in addition to ADR 0002's listed attributes

Status: accepted
Date: 2026-08-14

## Context

ADR 0002 specifies the `byPublishedAt` GSI projection as `INCLUDE (title, url,
source, publishedAt)`. While implementing the infrastructure, this was found to
be one attribute short: `src/adapters/dynamo-article-store.ts`'s `toArticle()`
requires an `id` field on every item and silently drops (filters out) any item
missing one. A GSI query only returns the projected attributes — if `id` is not
projected, every item read back from `listRecentArticles()` fails validation and
is dropped, so the query returns `[]` unconditionally. Nothing about this fails
loudly: the Lambda succeeds, no alarm fires, and the homepage simply renders "no
articles yet" forever.

A GSI's projected attributes cannot be changed in place — changing them requires
deleting and recreating the index. Getting this right before the first deploy is
materially cheaper than fixing it after.

## Decision

The `byPublishedAt` GSI projects `id` in addition to the four attributes ADR 0002
lists: `INCLUDE (id, title, url, source, publishedAt)`. This is implemented in
`infra/lib/stateful-stack.ts` and pinned by a test in `infra/lib/stacks.test.ts`.

This does not change any other part of ADR 0002's storage design — table name,
partition key, TTL, billing mode, and the two-table split are all unchanged. It
corrects one omitted attribute in the projection list.

An alternative considered: derive `id` in the adapter from `gsiSk` instead (which
is always `<publishedAt>#<id>` and is already part of the index's key schema), and
leave the projection exactly as ADR 0002 states. This was not taken because it
would require changing `src/adapters/dynamo-article-store.ts`, which was out of
scope for the infrastructure task that found this gap. It remains a valid future
simplification if the projection is ever revisited.

## Consequences

**Easier:** `listRecentArticles()` works as designed; the read path needs no
second read to fetch `id`.

**Harder:** nothing — this is a strict correction of an omission, not a new
trade-off.

ADR 0002 itself is not edited (per this project's ADR convention, accepted
records are never edited in place); its projection line should be read alongside
this record.
