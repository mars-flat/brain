# brain

A personal LLM system: a graph-memory "brain" backed by a plain Obsidian
vault, an MCP tool gateway with progressive disclosure, and pluggable
chat surfaces. Single-tenant by design, packageable by anyone.

**Status: under construction.** The full design lives in
[`architecture/`](./architecture/README.md) — read its README first; the
"Current status" section there is always the source of truth for what exists.

## The ideas in one paragraph

Memory is an Obsidian vault of typed, linked markdown notes — no embedding
model, no vector DB. Retrieval is SQLite FTS5 (BM25) to find entry points,
then weighted graph traversal, then packing under a token budget where
low-scoring nodes are *downgraded to cheaper render tiers, never dropped*.
Superseded decisions are always chased to their replacement; contradictions
are always surfaced in pairs. Writes go through a single-writer consolidator
that turns chat episodes into nodes, with quarantine instead of silent
acceptance, and a git commit per run so memory has an undo.

## Quickstart

```sh
git clone https://github.com/mars-flat/brain && cd brain
git config core.hooksPath .githooks   # pre-commit guards (§9.1)
bun install
bun test
```

A clean clone runs green with no configuration — tests use the synthetic
[`examples/vault-example/`](./examples/vault-example/README.md).

## Layout

| Path | What |
|---|---|
| `architecture/` | The design, split by topic, § numbers stable |
| `packages/contracts/` | Schemas + types + ports; zero runtime deps, written first |
| `examples/vault-example/` | Synthetic vault + retrieval eval set |
| `scripts/` | Repo tooling (example-vault generator, …) |
| `docs/` | Setup, ADRs |
| `vault/` | **Not in this repo.** Your private vault — its own git repo, four independent guards keep it out of this public one |

## Privacy model

This repo is public; the vault is verbatim personal conversation. They meet
in one directory tree but never in one git history — the vault is a separate
nested repository, gitignored, excluded, and hook-guarded, and CI fails if
anything vault-shaped is ever tracked here. Details: architecture §9.

## License

[MIT](./LICENSE). Security reports: see [SECURITY.md](./SECURITY.md).
