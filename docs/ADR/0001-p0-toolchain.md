# ADR 0001 — P0 toolchain choices

Date: 2026-08-25 · Status: accepted

Judgment calls made inside the locked constraints (Bun, bun:sqlite, bun test,
TDD, public repo). Recorded per the handoff's "decide yourself and note it".

## Biome for lint + format

One fast tool, no plugin sprawl, `biome ci` in CI. ESLint+Prettier would add
two configs and a dependency tree for no additional value at this scale.

## Contracts validate with hand-written guards; ajv is a devDependency only

`packages/contracts` must have zero runtime dependencies (§8.1), but "every
schema validated both ways" (§8.2) needs an independent validator. Resolution:
the package ships small hand-written guards (plus the two semantic rules JSON
Schema can't express — turn `seq` strictly increasing, policy default rule
last), and the tests compile the schemas with ajv and assert guard/ajv
agreement on every fixture, plus byte-identical patterns/enums between schema
JSON and TS constants. Consumers get runtime validation with zero transitive
deps; drift between schema and guard is a test failure.

Timestamps are validated by `pattern` alone (no `format` keyword): ajv-formats'
date-time regex is case-insensitive and allows leap seconds, so leaning on it
would make the schema's meaning depend on which validator you hold.

## typescript pinned to 6.x, not 7

dependency-cruiser (the §3 purity gate) has no TS7 API support yet; with TS7
installed it silently parses nothing and cruises zero modules — a vacuous
gate, verified by canary. TS6's `tsc --noEmit` typechecks this codebase fine.
Revisit when dependency-cruiser supports the TS7 API. depcruise itself runs
under Bun (`bunx --bun`) because its CLI rejects non-LTS system Nodes.

## Example vault is generated, committed, and freshness-checked

`scripts/gen-example-vault.ts` holds the node data and validates every node
against `@brain/contracts` before rendering — the example vault cannot drift
from the schema. Output is committed so a clean clone needs no generation
step; CI regenerates and `git diff --exit-code`s to keep the two in sync.

## GitHub Actions pinned by commit SHA

Tag-pinned actions are mutable in a public repo's threat model (§9.3 pins
images by digest for the same reason). Dependabot's github-actions ecosystem
keeps the SHAs current.
