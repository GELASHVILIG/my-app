# Architecture decision records

One file per decision: `NNNN-<slug>.md`, numbered sequentially from `0001`, never
reused. Numbers are allocated in the order decisions are written, not by topic.

## Statuses

- `proposed` — written, not yet agreed. Implementation should not rely on it.
- `accepted` — binding until superseded (see `CLAUDE.md`, working agreements).
- `superseded by NNNN` — kept in place, never deleted.

An accepted ADR is **never edited**. If the decision changes, write a new ADR that
supersedes it and set the old one's status to `superseded by NNNN`.

## Sections

```
# NNNN. Title
Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Context          the forces at play — constraints, load, cost ceiling
## Options considered   at least two, each with pros / cons / cost / ops burden
## Decision         what we are doing and the specific trade-off accepted
## Consequences     what gets easier, what gets harder, what we revisit and when
```

A record with one option is a rationalization, not a decision. Every AWS design
states its **monthly cost at idle**.

## Write an ADR for

Anything touching data storage, anything hard to reverse, anything where the
obvious choice was rejected, and anything whose reasoning will be forgotten in
three months. Not for library picks or anything reversible in an afternoon.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-serverless-compute-and-delivery.md) | Serverless compute and delivery | accepted |
| [0002](0002-dynamodb-for-article-storage.md) | DynamoDB for article and stats storage | accepted |
| [0003](0003-scheduled-single-lambda-ingestion.md) | Scheduled single-Lambda feed ingestion | accepted |
| [0004](0004-server-rendered-html-no-framework.md) | Server-rendered HTML, no framework, no client JS | accepted |
| [0005](0005-first-party-cookieless-visit-tracking.md) | First-party cookieless visit tracking | accepted |
