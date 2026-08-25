# Personal LLM System — Architecture

**Status:** Revision 5 + build in progress — Azure host, OpenAI `gpt-5.6-luna`, Bun runtime. **P0 complete**; see Current status below.
**Code repo:** `mars-flat/brain` — **public** · **Vault:** `brain/vault/`, its own local git repo, never tracked here ([§9.1](./11-repo-safety.md))
**MCP revision targeted:** `2026-07-28` · **Last updated:** 2026-08-25

---

## Read this first

Each file below is self-contained. **Open only what the task needs** — that is the point of the split.
Section numbers (§N) are stable across files and greppable, so a cross-reference like §4.3 always finds its home.

| File | Read it when you need… | Lines |
|---|---|---|
| [01-principles](./01-principles.md) | Why there's no embedding model; why BM25 ≠ embeddings | 36 |
| [02-overview](./02-overview.md) | The one-diagram picture of how the pieces connect | 66 |
| [03-deployment](./03-deployment.md) | Ports & adapters, the Azure VM, **the budget collision (§3.2)** | 137 |
| [04-gateway](./04-gateway.md) | MCP auth, progressive tool disclosure, policy engine | 229 |
| [05-brain-model](./05-brain-model.md) | Node format, edge vocabulary, Obsidian layout, storage | 156 |
| [06-brain-runtime](./06-brain-runtime.md) | Retrieval & traversal, consolidation, lint, MCP contract | 180 |
| [07-cost](./07-cost.md) | Model routing, effort levels, what it actually costs | 75 |
| [08-surfaces](./08-surfaces.md) | `agent-runtime`, Discord adapter, session router, trust tiers | 191 |
| [09-security](./09-security.md) | Threat model | 28 |
| [10-testing](./10-testing.md) | TDD approach, invariants, CI/CD pipeline | 92 |
| [11-repo-safety](./11-repo-safety.md) | Vault/code split, secrets, supply chain, packaging | 144 |
| [12-roadmap](./12-roadmap.md) | Repo layout, build phases, open questions | 116 |
| [13-setup](./13-setup.md) | **Prerequisites and the Discord bot walkthrough** | 83 |
| [14-appendix](./14-appendix.md) | What not to build, glossary, revision-3 audit | 46 |

*Same idea as the brain's own `index.md` ([§5.1](./05-brain-model.md)): a cheap catalog you always read, pointing at expensive detail you load on demand.*

---

## 0. Decisions locked

| # | Decision | Consequence in this document |
|---|---|---|
| 1 | **Azure host, must migrate freely** | Ports-and-adapters throughout. The app never imports a cloud SDK in core. Deploy unit is OCI containers + Compose; Azure is one adapter (§3). Sponsorship subscription has **no hard spend cap** — see §3.2 |
| 2 | **Discord only, open-closed for more** | `SurfaceAdapter` port + manifest registry. Adding WhatsApp = one new package, zero core edits (§6.2) |
| 3 | **Claude Code only, open-closed for more** | `HarnessAdapter` port. No Hermes yet — but the seam is cut for it (§6.4) |
| 4 | **No bulk ingest, start from scratch** | Graph grows from first conversation. Cold-start handling in §5.6 |
| 5 | **No embedding model** | **BM25 ≠ embeddings — see §5.5.** SQLite FTS5 gives ranked lexical search with no model and no network. `Embedder` port exists but defaults to null |
| 6 | **Model routing: default split** | Frontier model for chat, cheap model for consolidation and lint (§5.8) |
| 7 | **Single user, packageable** | Single-tenant core, zero hardcoded identity, `brain init` bootstrap, synthetic example vault (§9.4) |
| + | **Obsidian is the graph UI** | Vault *is* the brain. Typed edges live in Obsidian properties (§5.3). Kills the need for a custom web UI |
| + | **TDD + CI/CD** | Contracts first, tests before implementation, invariant-based testing for traversal (§8) |
| + | **Model: `gpt-5.6-luna`** | OpenAI, not Anthropic. Structured outputs + function calling + MCP all supported, so no design changes — but **reasoning effort now dominates cost** (§5.8) |
| + | **Public repo** | Repo split, secret hygiene, supply-chain policy, OIDC deploy with zero stored cloud keys (§9) |

**Build order: build → test locally → deploy.** Phases 0–4 run entirely on your laptop with Docker Compose. Azure does not appear until Phase 5.

---

## Current status

**P0 is done** (2026-08-25): both git repos initialized with all four §9.1 guards verified by test; `packages/contracts` (three schemas + tool contracts + ports, zero runtime deps, guards cross-validated against ajv on a 32-fixture corpus); the synthetic example vault (81 nodes, 6 episodes, 20-query eval set); CI (checks + repo-split/identity guards + gitleaks + CodeQL, SHA-pinned actions); docs, MIT licence. A clean clone runs `bun install && bun test` green. Toolchain deviations recorded in `docs/ADR/0001`.

**Next: P1** (brainstore, core traversal/packing, `brain eval` baseline), then P2. **The owner has scoped P3–P4 to a later session** — stop after P2 unless that changes.

**One human blocker remains, and it only gates P6: the Discord bot** ([§13](./13-setup.md) has the walkthrough). Open questions for the owner accumulate in `QUESTIONS-FOR-OWNER.md` at the repo root (local-only, gitignored).

**Two things to do before P5, not before P0:**

1. Re-space the Azure budgets ([§3.2](./03-deployment.md)) — at current values `auto-shutdown-cap` fires during normal operation and deallocates production
2. Set a usage limit in the OpenAI dashboard — Azure budgets cannot see that bill

**Keeping this document true:** the `architecture-sync` skill (`.claude/skills/`) is the protocol. Read the relevant chapter before building; when an implementation decision differs from what's written here, edit the doc in the same commit as the code. Stale docs are a bug.

**Next phase:** P0 — contracts, CI, example vault, repo-split enforcement.
