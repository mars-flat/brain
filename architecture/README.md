# Personal LLM System — Architecture

**Status:** Revision 5 built through P5 — Azure host, OpenAI `gpt-5.6-luna`, Bun runtime. **P0–P5 complete (2026-08-27): the brain serves remotely** from `brain-vm` over the tailnet with Auth0 auth. **P6 (Discord) deferred by the owner.** See Current status below.
**Code repo:** `mars-flat/brain` — **public** · **Vault:** private repo `mars-flat/brain-vault` — the VM's clone is the only writer; `brain/vault/` on the laptop is a read-only clone, never tracked here ([§9.1](./11-repo-safety.md))
**MCP:** SDK 1.30.0 pinned (protocol `2025-11-25`) · **Last updated:** 2026-09-24

---

## Read this first

Each file below is self-contained. **Open only what the task needs** — that is the point of the split.
Section numbers (§N) are stable across files and greppable, so a cross-reference like §4.3 always finds its home.

| File | Read it when you need… | Lines |
|---|---|---|
| [01-principles](./01-principles.md) | Why there's no embedding model; why BM25 ≠ embeddings | 36 |
| [02-overview](./02-overview.md) | The one-diagram picture of how the pieces connect | 70 |
| [03-deployment](./03-deployment.md) | Ports & adapters, the Azure VM, **the budget collision (§3.2)** | 155 |
| [04-gateway](./04-gateway.md) | MCP auth, progressive tool disclosure, policy engine | 250 |
| [05-brain-model](./05-brain-model.md) | Node format, edge vocabulary, Obsidian layout, storage | 157 |
| [06-brain-runtime](./06-brain-runtime.md) | Retrieval & traversal, consolidation, lint, MCP contract | 263 |
| [07-cost](./07-cost.md) | Model routing, effort levels, what it actually costs | 77 |
| [08-surfaces](./08-surfaces.md) | `agent-runtime`, Discord adapter, session router, trust tiers | 207 |
| [09-security](./09-security.md) | Threat model | 28 |
| [10-testing](./10-testing.md) | TDD approach, invariants, CI/CD pipeline | 131 |
| [11-repo-safety](./11-repo-safety.md) | Vault/code split, secrets, supply chain, packaging | 157 |
| [12-roadmap](./12-roadmap.md) | Repo layout, build phases, open questions | 135 |
| [13-setup](./13-setup.md) | **Prerequisites and the Discord bot walkthrough** | 97 |
| [14-appendix](./14-appendix.md) | What not to build, glossary, revision-3 audit | 72 |
| [15-console](./15-console.md) | The web console: authenticated vault viewer + ops dashboard | 190 |
| [16-tasks](./16-tasks.md) | Recurring tasks: own SQLite store, the console's one write path, `tasks.*` upstream, Mac reminder | 334 |

*Same idea as the brain's own catalog fallback ([§5.1](./05-brain-model.md)): a cheap list you always read, pointing at expensive detail you load on demand.*

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
| + | **Obsidian is the graph UI** | Vault *is* the brain. Typed edges live in Obsidian properties (§5.3). Kills the need for a custom graph *editor*; the read-only ops console and the tasks tab (§15, §16) came later and do not edit the vault |
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

**P3 is done** (2026-08-25): `packages/brain-mcp` (the seven §5.10 tools over MCP) and `packages/gateway` — four meta-tools (measured base context **298 tokens**), FTS5 tool index, pure policy evaluator composed with the §6.5 trust matrix (strictest wins, property-tested), stdio pool with per-server health, single-use confirm tokens, hash-chained audit with arg digests only, 120/min rate cap. Live smoke (`bun scripts/gateway-smoke.ts`): three upstreams up (brain + everything + filesystem, 34 tools), `tools_search` ranks `brain.recall` first, and a recall through the gateway serves a real pack from the owner's vault. `.mcp.json` registers the gateway for Claude Code (one-time trust prompt on next session) — *that project-scope stdio gateway was retired 2026-09-17; one gateway, see below.* The `brain init` seed interview (§5.6) remains open.

**P4 is done** (2026-08-26): the gateway is an OAuth 2.1 **resource server** (jose JWKS validation, RFC 9728 PRM, 401/403 challenges) against a local **Keycloak** container (`deploy/keycloak/`, realm auto-imported). Scope tiers enforced above policy so **step-up** is a real boundary; **token passthrough** structurally prevented and asserted (§8.4) — plus a real env-leak gap found and closed (bun auto-loads `.env` into upstream children; they now get a scrubbed env in a neutral cwd). Both credential planes: north-bound Keycloak clients (`brain-cli` PKCE, `agent-runtime` client_credentials), south-bound envelope-encrypted `${secret:...}` refs via `adapters/secrets-file` + `brain secret`. SSRF guard as defense-in-depth (§8.4). **Proven end to end** against live Keycloak (`bun scripts/auth-smoke.ts`: unauth 401 → PRM → authed recall → step-up 403) and deterministically in CI via a mock AS. 168 tests.

**Mode A harness is done** (2026-08-27, pulled forward of P5 — §11): `packages/harness-claude-code` — `normalizeEpisode` (Claude Code transcript → §5.7 envelope: noise-stripped, digest-only tool calls, deterministic per-session episode id, §5.8 trim; 9 tests) plus the SessionEnd hook that runs `brain ingest --now` locally (the §6.4 POST arrives with P5's HTTP surface). The repo now dogfoods its own memory: `.claude/skills/brain-memory/` carries the recall/capture protocol, a three-line `CLAUDE.md` points at it, `.claude/settings.json` registers the hook. Deviations recorded in §6.4; smoke-tested end to end against a scratch vault (marker extractor; idempotent rerun; every failure path exits 0 so session end never breaks).

**P5 is done (2026-08-27, one working day) — the brain is fully remote.** Every done-when holds: push to `main` deploys through OIDC + `run-command` with a doctor-gated rollback (`DEPLOY-OK` twice, including the GHCR pull path); `brain doctor` green on the VM; the restore drill passed in both forms (local-sourced, then the strict VM-sourced version over the tailnet — which caught and fixed a real systemd `HOME` bug in the backup unit). **Auth0 is live** (§12 Q6): tenant configured as code, the issuer swap was one URL, and the full chain is verified from the laptop — token minted, write-only credential correctly 403s on reads (step-up against real Auth0 tokens), headless SessionEnd delivery accepted → queued (§5.8) → consolidated on the VM → vault pushed to the private remote. Claude Code connects via the pre-registered `brain-cli` client id at local scope (tailnet URL stays out of the public repo, §9.2); first interactive login happens next session. Remaining niceties, not blockers: Auth0 signup-hardening toggles (§13) and the owner's first PKCE login. **P6 (Discord) is deferred by the owner until they provide the bot token.**

The P5 build detail:

- **Gates cleared**: budgets re-spaced at double the §12 Q8 suggestion (110/180/2000 CAD — owner's call, more credit; action-group verified), OpenAI dashboard limit set (owner-confirmed).
- **Landed and green**: the private vault remote (`mars-flat/brain-vault`, §12 Q1 closed); the one-container Compose stack + dev-IdP overlay with the five-step e2e smoke in CI (§3.1); the §6.4 SessionEnd POST swap (`brain.ingest` eighth tool, client_credentials delivery with disk token cache, CLI fallback) and a real `install()`; batched consolidation (§12 Q4 — `brain consolidate --batch` cadence, pending-vs-failing semantics, `BRAIN_INGEST_MODE=queue`); the OIDC deploy pipeline (multi-arch GHCR image with SBOM/provenance, id-pinned federated credential, run-command deploy with doctor-gated rollback, §8.6); `brain backup` + `scripts/restore-drill.sh` — **the §3.1 restore drill passed against the real vault** (doctor green, 26 nodes recalled through the restored stack).
- **Azure, live**: `brain-vm` (B2pls_v2 ARM, no public IP, 32 GiB data disk) is provisioned and **serving the brain** — gateway healthy, doctor green, real key set, batch-consolidation and vault-push timers armed (`Environment=HOME=/root` — systemd, run-command, and the workflow wrapper all lack `HOME` and git dies without it). First push-to-main deploy came back `DEPLOY-OK` through the doctor gate; GHCR package is public so deploys pull. **Tailnet live**: the gateway behind `tailscale serve` TLS on the VM's MagicDNS name (kept out of the repo, §9.2; since 2026-08-28 the edge is the console domain, §15.1); laptop leg verified; Tailscale SSH enabled for ops. **The strict VM-sourced restore drill passed** (backup on the VM → tailnet transfer → restore on the laptop → doctor + authed recall).
- **Auth0, live**: tenant configured by `scripts/auth0-setup.ts` (idempotent, Management-credential in `.env`); issuer swapped on the VM in one line; scope step-up, headless delivery, queue → consolidate → vault push all verified from the laptop over the tailnet.

**W1.6 is done (2026-08-28) — the dashboard grew teeth.** Service cards
(per-SaaS account, console link, credential expiry grading, live probes —
Azure ARM via the VM's managed identity with az-CLI dev fallback: VM
roster/state, retail-rate estimate, budgets; OpenAI/Vercel key checks;
issuer discovery), an **MCP upstream status** section over the gateway's
new internal `GET /healthz/upstreams`, a logout flow that doesn't get
silently re-logged-in by IdP SSO, a wider layout, and an `/architecture`
tab rendering the full system as one themed SVG (§15.6), and a `/graph`
tab — the vault's typed graph force-laid-out on a canvas, no external
scripts (owner-requested; ends the §15.5 v1 deferral). Data schema for
all of it lives in the private vault's `config/console.yaml` (§15.4).
The VM's managed identity has its Reader grant (owner-run 2026-08-28,
`azure/azure-config.md` §7); the IMDS path verifies on the next deploy.

**W1.7 is done (2026-08-28) — call analytics on the dashboard.** A
mini-Datadog section over the gateway's hash-chained audit log: stat
tiles, hourly outcome bars, top tools with latency percentiles (the
gateway now stamps `ms` on call/error audit events), and the latest
calls. Trailing-7-day *view* window — the append-only chain is never
truncated (§15.4). Same day, the console's front door became the graph
tab, with the vault (nodes + episodes behind one toggle) second (§15.3).

**W2 is built and laptop-verified (2026-08-28) — Google mail + Drive
behind the gateway.** `packages/mcp-google` (per-server docs live in its
README — architecture documents only the connection pattern): a thin
stdio MCP server over the plain REST APIs, one instance per account,
wired in the private vault's `servers.yaml` with `${secret:…}` refresh
tokens (§4.3 south-bound plane) and risk kinds carried by MCP annotations
(§4.4). Mail is read + label control with **structurally no send tool**;
the permanent send-deny policy rule is mirrored in the example vault and
now proven at the policy layer by test (a probe upstream advertises a
send-shaped tool; it dies before any upstream call). The compose e2e
smoke grew four W2 legs against a fake Google API (search + full-body
read, confirm-gated archive, Drive create→rename→trash→untrash, both
halves of no-send). Live from the laptop: all three account instances up
through the real gateway with real reads. The VM leg landed after the
owner-run secrets copy: all three account instances serve from the VM
gateway through the domain (roster verified live 2026-09-24).

*2026-09-18 — filter control.* Three tools (`mail_list_filters`,
`mail_create_filter`, `mail_delete_filter`) plus a declarative per-account
filter spec in the private vault, reconciled by `scripts/gmail-filters.ts`
(labels, filters, optional backfill; nothing deleted). Same no-send rule:
a filter's `forward` action is refused structurally. **Consent scope grew**
to `gmail.settings.basic` — each account needs a one-time re-consent before
its filter tools work (§13). Per-server detail stays in the package README.

**W3 is done (2026-08-31) — retrieval tuning instead of vector search.** The
owner weighed adding an embedding model and decided decision #5 stands; the
measured gaps were elsewhere and got fixed directly. The adversarial
paraphrase suite (`brain eval --paraphrase`, §8.5) is the new measuring
stick: zero-overlap enforcement via the FTS tokenizer itself, seed-vs-pack
split metrics, abstention probes, CI-gated baseline. Against it, three
mechanism changes (§5.5): salience now bumps on `brain.expand` (demand)
instead of full-tier render (a rich-get-richer loop); traversal damps
arriving path mass by node degree and full-tier slots are query-anchored
(hubs stopped squatting the expensive tiers — real-vault placement 4×);
and the scalar θ_seed became a four-feature abstention score standardized
against a per-vault **noise floor** recomputed at every rebuild, banded
into confident/hedged/abstain (`confidence` on the recall result, catalog
fallback on abstain). Constants come from the `brain tune` grid sweep under
a hard original-suite-holds-1.0 constraint — after tuning, the paraphrase
suite scores 1.0 across ¶-recall, recovery, placement, and abstention. The
`Embedder` port stays null; it earns its keep only if these numbers decay.

**One vault, one writer (2026-09-17).** The laptop had been running a second
gateway of its own — `.mcp.json`, stdio, against the local clone — alongside
the deployed one, so captures inside `~/brain` landed in the laptop clone and
captures anywhere else landed on the VM: two copies of the vault that met only
through the private remote, with nothing pulling on either side. It bit twice.
The 2026-09-01 shadow-vault incident (§4.2) came through the local gateway,
and the VM's nightly push had been rejected non-fast-forward since a
2026-09-02 laptop-side merge, leaving two weeks of VM memories unbacked-up
with only `journalctl` noticing. Resolved by removing the project-scope
gateway (every session, `~/brain` included, uses user-scope
`tool-gateway-remote`), pointing the SessionEnd hook at the VM through a
gitignored `.claude/brain-harness.json` (§6.4), merging the two histories once
more (colliding same-day episode basenames split as on 2026-09-02), and
declaring the laptop clone read-only — the VM is the only writer (§3.1). The
hook's local-ingest fallback is the one path that can still write the laptop
clone, and only when the VM is unreachable.

**T1 — the tasks surface (2026-09-18, §16).** Recurring tasks as a
**separate tool with its own SQLite store** (owner's ruling: scheduling
state is deterministic and relational, memory is not — the brain does not
know tasks exist). `packages/tasks`: a pure, property-tested recurrence
core (one open occurrence ever; completion-anchored by default, due-anchored
on request; late = one roll, never a pile-up; recurring until opt-out; the
append-only event log replays to the row), a WAL store beside the vault
shared by two writers, and a ten-tool `tasks.*` MCP upstream so every Claude
surface reaches the same store. The console grew a `/tasks` tab — **its
first write path**: POST-and-redirect forms with a session-bound CSRF token,
same-origin enforcement, and `form-action 'self'`; §15.3's rule is now "never
writes the *vault*". The owner's completion prompt shipped verbatim
("schedule again? yes / pick a date / no", yes default). `packages/tasks-reminder`
is the Mac launchd agent: `max(9am, first open)` as a guard, one System
Events dialog a day, read-only via its own `tools:read`-only Auth0 client.
`brain backup` snapshots the store (`VACUUM INTO`) beside the vault; the
compose smoke drives create → due → complete through the real gateway.
Same day, the owner made tasks the console's **front door**: `/` redirects
to `/tasks`, tasks leads the top bar, and the graph is back at `/graph`
(§15.3). An owner UI pass the same day brought **schema v2** (the first
in-place migration): time of day is optional and off by default, with
date-only tasks pinned to local noon; **tags** with a management page and
derived interval/status tags; **delete forever** for retired tasks through
a purge that keeps the log append-only for everything else; and the task
page's edit `<dialog>`, history toggle, and green/orange/red action trio
(§16.2–§16.4). Owner-run after merge (§13): the `tasks` roster entry on
the VM, one `auth0-setup` re-run, the reminder installer.

**Architecture audit (2026-09-24).** Five checkers read every chapter
against the code and found the older chapters still describing the
revision-5 design where reality had overruled it: the console edge (Caddy,
lego TLS, a domain) marked "dropped until WhatsApp"; Discord and CLI
surface adapters marked built; sandboxed per-server MCP containers, an
egress allowlist, per-principal caps, encrypted backups, log redaction,
Trivy and a weekly image rebuild described as existing when none are; a
three-segment URN; a debounced-plus-nightly consolidation cadence that is
a 15-minute timer; `brain init` and `brain doctor` claiming checks they
do not make. Every chapter was corrected in one PR, decisions amended
rather than erased. Two code fixes rode along: `brain.note` over MCP now
honours its `type` argument (it was accepted and dropped), and the
console's `/healthz` reads the tasks store and returns 503 when it cannot.

**One human blocker remains, and it only gates P6: the Discord bot** ([§13](./13-setup.md) has the walkthrough) — **deferred by the owner** for now. Open questions accumulate in `QUESTIONS-FOR-OWNER.md` at the repo root (local-only, gitignored).

**Keeping this document true:** the `architecture-sync` skill (`.claude/skills/`) is the protocol. Read the relevant chapter before building; when an implementation decision differs from what's written here, edit the doc in the same commit as the code. Stale docs are a bug.
