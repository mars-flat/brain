# Setup

Grows with each phase. Right now (post-P0) the system is contracts + tests;
there is nothing to run in production yet.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4
- git
- [gitleaks](https://github.com/gitleaks/gitleaks) — optional locally
  (`brew install gitleaks`); the pre-commit hook uses it if present, and CI
  runs it regardless

## Developing

```sh
git clone https://github.com/mars-flat/brain && cd brain
git config core.hooksPath .githooks   # REQUIRED: vault/secret guards (§9.1)
bun install
bun run check                          # lint + typecheck + depcruise + tests
```

`bun run format` applies Biome fixes. `bun scripts/gen-example-vault.ts`
regenerates the synthetic vault (CI verifies the committed output is fresh).

## Your private vault

Your real vault lives at `vault/` inside this tree but is **its own git
repository** with no remote — created by `brain init` (arrives in P1/P2), or
by hand:

```sh
mkdir vault && cd vault && git init
```

Never weaken the four guards that keep it out of the public repo
(architecture §9.1). Point `BRAIN_VAULT_PATH` at it in `.env` (copy
`.env.example`). Confirm your backup tool (e.g. Time Machine) covers the
vault directory — it has no remote until you add a private one.
