# my-app

## What this is
<!-- One or two sentences: what it does and who for. Keep this current. -->

## Stack
- TypeScript (strict), Node 26.7.0
- Infrastructure: AWS CDK in `infra/`
- Tests: Vitest (`*.test.ts`), Playwright for end-to-end

## Layout
```
src/domain/     pure logic, no I/O
src/services/   orchestration
src/adapters/   DB, AWS SDK, HTTP clients
src/http/       routes and request validation
infra/          CDK stacks (stateful / stateless split)
docs/plans/     specs from the planner
docs/adr/       architecture decisions
```
`src/domain/` imports nothing from the other directories. Invert the dependency instead.

## Commands
| Command | What it does |
|---|---|
| `npm run dev` | local dev |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run lint` | ESLint |
| `npm run e2e` | Playwright |
| `npm run cdk:diff` | infrastructure diff |

## Working agreements
- **Plan before building.** Anything beyond a small fix starts with the `planner` agent writing to `docs/plans/`.
- **Architecture decisions get an ADR.** The `architect` agent writes them; an accepted ADR is binding until superseded.
- **The gate is `npm run typecheck && npm test && npm run lint`.** Nothing is done until it passes.
- **The `reviewer` agent runs before every commit** on non-trivial changes. It is read-only by design.
- **Deploys are human-run** from CI. Agents produce `cdk diff` and a summary, never `cdk deploy`.
- Never weaken a test to make it pass. Never commit secrets. Never fix production by hand.

## Project-specific context
<!-- The things an agent cannot infer from the code: why an odd decision was made,
     which external service is flaky, what the deploy sequence is, what NOT to touch. -->
