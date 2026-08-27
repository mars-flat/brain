# Personal LLM System — Architecture

**Status:** Revision 5 + build in progress — Azure host, OpenAI `gpt-5.6-luna`, Bun runtime. **P0–P4 complete + the Mode A Claude Code harness** (all local); **P5 underway — gates cleared 2026-08-27**. See Current status below.
**Code repo:** `mars-flat/brain` — **public** · **Vault:** `brain/vault/`, its own local git repo, never tracked here ([§9.1](./11-repo-safety.md))
**MCP revision targeted:** `2026-07-28` · **Last updated:** 2026-08-27

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

**P1 is done** (2026-08-25): `packages/brainstore` (canonical render/parse with property-tested round-trip, vault loader enforcing basename invariants, FTS5 index, salience-preserving rebuild), `packages/core` (traverse/pack/recall with every §8.3 invariant as a fast-check property — supersedes-to-terminal ignoring budget and hops, two-sided labeled contradictions, pins at full tier, downgrade-never-drop with explicit omission, byte-identical determinism under shuffled input), and `packages/cli` (`brain init | rebuild | recall | eval | doctor`). **Eval on the example vault: recall 1.0, tier placement 1.0, conflicts 1.0** against the committed baseline; CI gates regressions. Deviations recorded in §5.5/§5.10/§5.11 (no prefix stars, θ_seed=5.0, rank bands are minimums, chars/4 tokens, salience survives rebuild).

**P2 is done** (2026-08-25): the single-writer consolidator (`ingest → lease → extract → resolve → reserve → plan → validate-in-memory → write → git commit → ledger → reindex`), with quarantine instead of silent acceptance, trust gating per §6.5, pins blocking supersede attempts, and both idempotency flavors plus reservation-conflict semantics under test (15 invariant tests). Extraction is an interface: the LLM path (`adapters/model-openai`, Responses API, structured outputs, medium effort) and a deterministic `@node` marker grammar for tests/offline/hand capture. `brain` grew `ingest | consolidate | note | pin | lint` — lint ships the mechanical §5.9 checks with `--apply`. The REAL vault took its first two consolidated nodes end to end (commit `17b364f` in the vault repo). Doc corrections landed in §5.7-notes, §5.9, §9.1, §12 Q4.

**Owner Q&A round-trip complete** (2026-08-25): OPENAI_API_KEY landed in `.env` (LLM extraction verified live — the first free-text notes consolidated with correct types, edges into the existing graph, and clean summaries), P4 IdP = local Keycloak (§12 Q6), backup risk accepted (§12 Q1), property-links spike closed (§5.2). The repo also moved to **branch → PR → auto-merge on green** with all four checks Required on `main` (§8.6).

**P3 is done** (2026-08-25): `packages/brain-mcp` (the seven §5.10 tools over MCP) and `packages/gateway` — four meta-tools (measured base context **298 tokens**), FTS5 tool index, pure policy evaluator composed with the §6.5 trust matrix (strictest wins, property-tested), stdio pool with per-server health, single-use confirm tokens, hash-chained audit with arg digests only, 120/min rate cap. Live smoke (`bun scripts/gateway-smoke.ts`): three upstreams up (brain + everything + filesystem, 34 tools), `tools_search` ranks `brain.recall` first, and a recall through the gateway serves a real pack from the owner's vault. `.mcp.json` registers the gateway for Claude Code (one-time trust prompt on next session). The `brain init` seed interview (§5.6) remains open.

**P4 is done** (2026-08-26): the gateway is an OAuth 2.1 **resource server** (jose JWKS validation, RFC 9728 PRM, 401/403 challenges) against a local **Keycloak** container (`deploy/keycloak/`, realm auto-imported). Scope tiers enforced above policy so **step-up** is a real boundary; **token passthrough** structurally prevented and asserted (§8.4) — plus a real env-leak gap found and closed (bun auto-loads `.env` into upstream children; they now get a scrubbed env in a neutral cwd). Both credential planes: north-bound Keycloak clients (`brain-cli` PKCE, `agent-runtime` client_credentials), south-bound envelope-encrypted `${secret:...}` refs via `adapters/secrets-file` + `brain secret`. SSRF guard as defense-in-depth (§8.4). **Proven end to end** against live Keycloak (`bun scripts/auth-smoke.ts`: unauth 401 → PRM → authed recall → step-up 403) and deterministically in CI via a mock AS. 168 tests.

**Mode A harness is done** (2026-08-27, pulled forward of P5 — §11): `packages/harness-claude-code` — `normalizeEpisode` (Claude Code transcript → §5.7 envelope: noise-stripped, digest-only tool calls, deterministic per-session episode id, §5.8 trim; 9 tests) plus the SessionEnd hook that runs `brain ingest --now` locally (the §6.4 POST arrives with P5's HTTP surface). The repo now dogfoods its own memory: `.claude/skills/brain-memory/` carries the recall/capture protocol, a three-line `CLAUDE.md` points at it, `.claude/settings.json` registers the hook. Deviations recorded in §6.4; smoke-tested end to end against a scratch vault (marker extractor; idempotent rerun; every failure path exits 0 so session end never breaks).

**Phases P0–P4 are complete. P5 is underway (started 2026-08-27) — both its gates cleared that day:** the Azure budgets are re-spaced (§3.2 — tripwire 110 / shutdown 180 / credit-cap 2000 CAD, double the §12 Q8 suggestion per the owner; action-group wiring verified) and the OpenAI dashboard spend limit is set (owner-confirmed). The P5 hosted IdP is **Auth0** (§12 Q6 — account created, tenant configuration pending). Nothing has touched Azure compute yet; per the owner's standing preference, the P5 stack is built and tested locally before any VM exists.

**One human blocker remains, and it only gates P6: the Discord bot** ([§13](./13-setup.md) has the walkthrough). Open questions for the owner accumulate in `QUESTIONS-FOR-OWNER.md` at the repo root (local-only, gitignored).

**Keeping this document true:** the `architecture-sync` skill (`.claude/skills/`) is the protocol. Read the relevant chapter before building; when an implementation decision differs from what's written here, edit the doc in the same commit as the code. Stale docs are a bug.

**Next phase:** P0 — contracts, CI, example vault, repo-split enforcement.
