# Handoff: P5 and beyond

You're continuing a personal LLM system: an MCP tool gateway, a graph-memory
"brain" backed by an Obsidian vault, and a pluggable surface layer. **P0–P4
plus the Mode A Claude Code harness are done and entirely local.** What
remains is taking it remote (P5) and giving it its first server-driven
surface (P6).

## First: read the spec, then keep it true

The design is in **`architecture/`** — 15 files, split so you never load all
of them.

1. Read **`architecture/README.md`**. Locked decisions, navigation, and
   **Current status** — always the source of truth for what exists, more
   current than this file.
2. Read **only the chapter** for what you're touching. The nav table maps
   topic → file.
3. The **`architecture-sync` skill** is mandatory before building. When your
   implementation deviates from the doc, edit `architecture/` in the same
   commit as the code. A doc that no longer describes reality is a bug.

Cross-references use stable § numbers. `grep -rn "§3.2" architecture/` finds
the target wherever it lives.

## The gates — do not start P5 or P6 without these

| Gate | Who | What |
|---|---|---|
| **Azure budgets re-spaced** (§3.2, §12 Q8) | owner | `monthly-tripwire` → 55 CAD, `auto-shutdown-cap` → 90 CAD. At current values the shutdown cap fires during normal operation and deallocates production |
| **OpenAI spend limit** (§7) | owner | Set in the OpenAI platform dashboard. Azure budgets cannot see that bill; nothing else caps it |
| **Discord bot token** (§13) | owner | Gates P6 only. §13 has the walkthrough |

If a gate is uncleared, ask in `QUESTIONS-FOR-OWNER.md` (repo root,
gitignored — the owner answers inline; check it at session start) and build
something else meanwhile. Do not start P5 on an uncleared budget gate: the
first VM-hour starts the clock on a bill with a mis-spaced auto-shutdown.

## What's already set up

| | |
|---|---|
| `azure/azure-config.md` | **Local, gitignored, hook-guarded** — real tenant/subscription/billing ids and cost guard rails. The starting point for P5; never track or quote it |
| `vault/` | The owner's real memory, accumulating daily via the SessionEnd hook. Own nested git repo, **no remote yet** — creating the private remote is a P5 deliverable (§12 Q1: loss risk accepted only until then) |
| `deploy/keycloak/` | Local IdP container (realm auto-imports). P5 swaps to a hosted IdP by changing one issuer URL (§4.3, §12 Q6) |
| `.env` | `BRAIN_VAULT_PATH` + `OPENAI_API_KEY` (live, LLM extraction works). Only `.env.example` is committed |
| `gh` | Authenticated as `mars-flat`. Repo commits use the noreply identity `75336695+mars-flat@users.noreply.github.com`, never the owner's personal identity (§9.4) |
| Workflow | **Branch → PR → auto-merge on green** (`gh pr merge <n> --auto --rebase`). All four checks Required on `main`; direct pushes are refused |

## The phases

| Phase | Build | Done when |
|---|---|---|
| **P5** | Azure VM + Compose + Tailscale + OIDC deploy + rollback (§3); hosted IdP swap; private vault remote; Batch API for consolidation (§12 Q4) | Push to `main` deploys; `brain doctor` green; **restore-to-a-different-host drill succeeds** |
| **P6** | **`agent-runtime`** (§6.0 — the server-side loop, the piece revision 2 forgot), Discord adapter, session router, trust tiers, `surface-testkit` | Message on Discord → recall → tool call with button confirm → reply → episode lands in the vault; non-allowlisted user gets no response |

P5 details that are already decided, not yours to re-decide: no public IP
(Tailscale-only, §3.1); OIDC deploy with zero stored cloud keys (§9);
`agent-runtime` uses the OpenAI Agents SDK **pending an MCP-transport check
at P6** (§6.0/§12 Q7 — the fallback is a thin Responses-API loop, a day not
a redesign); Discord is DM-only at first (§12 Q5).

Small P5 items easy to miss: the SessionEnd hook currently delivers via the
local CLI — the swap to POSTing the envelope lives in exactly one script
(`packages/harness-claude-code/hooks/session-end.ts`, §6.4), and
`claudeCodeHarness.install()` goes from static notes to actually writing
harness config once a gateway URL exists.

## Constraints that aren't negotiable (unchanged from P0–P4)

- **Contracts first, then failing tests, then code** (§8.1). The schemas in
  `packages/contracts/` are the single integration point — extend them
  there, never fork them locally.
- **The vault never enters the public repo** (§9.1). Four independent
  guards; don't weaken any. Example data stays synthetic; no real vault
  content in `architecture/` or fixtures, ever.
- **No embedding model** (§1). BM25 + graph traversal; the `Embedder` port
  stays null unless `brain eval` proves otherwise.
- **Bun, not Node** — `bun:sqlite`, `bun test`, native TS, frozen lockfile.
- **Core stays pure** — no I/O, clock, or randomness in `packages/core`;
  depcruise enforces it in CI.
- **Public repo hygiene** — only `.env.example` committed; gitleaks
  pre-commit and CI; no hardcoded identity in code or fixtures (§9.2, §9.4).

## Hard-won facts — don't relearn these

- **Bun auto-loads `.env` into child processes.** The gateway scrubs the
  env for upstream stdio servers (a real leak was found and closed at P4,
  §8.4). Anything new that spawns children must do the same.
- **`typescript` is pinned to 6.x** — dependency-cruiser has no TS7 API;
  with TS7 the §3 purity gate silently cruises zero modules.
- **`salience` lives only in SQLite** and **node ids are bare basenames** —
  the two mistakes the design already made once (§5.2); don't reintroduce.
- **Dependabot's weekly "bun" job emails a failure** — their runner doesn't
  support Bun 1.4's lockfile v2 yet. Config is correct; `bun audit` in CI
  covers the gap. Ignore the emails.
- The eval gate (`brain eval --check` against the committed baseline) and
  the 167-test suite must stay green; CI enforces both.

## Judgment calls

**Decide yourself and note it:** library choices within the constraints,
file organization, test structure — anything a careful engineer would just
pick.

**Ask the owner** (via `QUESTIONS-FOR-OWNER.md`): anything that changes a
locked decision in README §0, adds a paid service or a human setup step, or
touches the vault/public-repo boundary. The owner's standing preference is
recorded: **test as much as possible locally before moving remote.**

## When you finish a phase

Update **`architecture/README.md` → Current status** in the same PR. It's
the first thing the next agent reads, and it's how this handoff chain stays
intact.
