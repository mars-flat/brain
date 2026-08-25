# Handoff: implement P0 → P4

You're building a personal LLM system: an MCP tool gateway, a graph-memory "brain" backed by an Obsidian vault, and a pluggable surface layer. Phases 0–4 are **entirely local** — no cloud, no Discord, no always-on host. You are building the durable core.

## First: read the spec, then keep it true

The design is in **`architecture/`** — 15 files, split so you never load all of them.

1. Read **`architecture/README.md`** (66 lines). Locked decisions, navigation, current status.
2. Read **only the chapter** for what you're touching. The nav table in the README maps topic → file.
3. The **`architecture-sync` skill** (in `.claude/skills/`) covers the full protocol, including what to do when your implementation deviates from the doc. Read it before you start writing code.

**The doc is the source of truth, and it is expected to change.** You will find things it got wrong or underspecified — a five-revision design doc is not a prophecy. When that happens, **edit `architecture/` in the same commit as the code**. The skill explains where each kind of change belongs and what's worth recording versus what's noise. A doc that no longer describes reality is a bug.

Cross-references use stable § numbers. `grep -rn "§5.7" architecture/` finds the target wherever it lives.

## What's already set up

| | |
|---|---|
| `mars-flat/brain` | Public repo, empty. `gh` authenticated as `mars-flat` — pushes, branch protection, and Actions config are all scriptable |
| `vault/` | Obsidian vault, **its own nested git repo**, gitignored by the parent. Never track it here (§9.1) |
| `azure/azure-config.md` | Azure subscription + cost guard rails. **Not needed until P5** — don't touch it |
| OpenAI API key | Available for P2 |
| Bun | Installed |

## The phases

| Phase | Build | Done when |
|---|---|---|
| **P0** | `contracts/` — node schema, episode envelope, both MCP tool contracts. CI, gitleaks, example vault, repo-split guard | A clean clone runs `bun install && bun test` green with no config |
| **P1** | Vault parse, SQLite FTS5 index, traversal, budgeted packing, `brain eval` | All §8.3 invariants pass; eval baseline committed; recall on the example vault meets target |
| **P2** | Consolidator, lint, pins, quarantine, git commit per run | Same episode ingested twice yields zero new nodes; concurrent overlapping episodes yield no duplicates |
| **P3** | Gateway with 3–4 stdio MCP servers, four meta-tools, policy engine | Claude Code connects locally; `tools.search` finds the right tool; base context < 1k tokens |
| **P4** | Gateway as OAuth resource server against a hosted IdP, both credential planes, encrypted secret store | Claude Code completes OAuth; token-passthrough assertion holds; step-up works end to end |

**Stop after P4.** P5 (Azure deploy) and P6 (Discord) are out of scope — P5 needs a budget change the owner has to approve first (§3.2), and P6 needs a Discord bot token that doesn't exist yet (§13).

## Constraints that aren't negotiable

**Contracts first, then failing tests, then code.** `packages/contracts/` has zero dependencies and gets written in P0 before any service exists. That ordering is what makes the TDD discipline hold rather than being aspirational (§8.1).

**The vault never enters the public repo.** It's verbatim personal conversation and this repo is public. Four independent guards exist (§9.1) — nested git repo, `.gitignore`, `.git/info/exclude`, pre-commit hook. Don't weaken any of them, and never put real vault content in `architecture/` or `examples/`. Example data is synthetic.

**No embedding model.** BM25 via SQLite FTS5, no vectors, no network call in the retrieval path. §1 explains why, and why the graph traversal recovers most of what embeddings would give. The `Embedder` port exists and defaults to null — leave it that way unless `brain eval` proves otherwise.

**Bun, not Node.** `bun:sqlite` (not `better-sqlite3`), `bun test` (not vitest/jest), native TS (no transpile step), `bun install --frozen-lockfile`. §10 covers what this replaces and why.

**Core stays pure.** No I/O, no clock, no randomness in `packages/core` — `Clock` is a port. That's what makes traversal and packing deterministic and unit-testable, and a dependency-cruiser rule in CI enforces it (§3).

**Public repo hygiene from commit one.** Only `.env.example` is committed. gitleaks pre-commit *and* CI. No hardcoded identity anywhere — no name, id, email, or path, in code or fixtures (§9.2, §9.4).

## The invariants worth reading before P1

§8.3 lists ten properties the system claims. Four of them encode decisions that are easy to implement wrong, and they're worth understanding before you write the traversal:

- **`supersedes` is followed to the terminal node ignoring the budget.** Otherwise memory serves a superseded decision as if current.
- **`contradicts` pulls in the counterpart** whenever either endpoint is included, and the pack labels the conflict.
- **Nothing is dropped for scoring low — it's downgraded** to a cheaper render tier. That's the whole context-budget mechanism.
- **Ties break by `(score DESC, id ASC)`.** FTS5 rowids change on rebuild, so an unstable sort makes identical queries return different packs.

Property-test these with `fast-check` rather than asserting on examples.

## Two things the design got wrong before — don't reintroduce them

- **`salience` belongs only in SQLite.** It's bumped on every full-tier render; storing it in note frontmatter makes every read a write, churns git, and races the single-writer consolidator.
- **Node ids are bare basenames** (`gateway-runs-on-ec2`), not paths. Obsidian's link autocomplete emits `[[foo]]`, so path-form links break on every hand-edit. Lint enforces basename uniqueness.

## Judgment calls

**Decide yourself and note it:** library choices within the constraints above, file organization inside a package, test structure, error handling, anything a careful engineer would just pick.

**Ask the owner:** anything that changes a locked decision in README §0, adds a paid service or a human setup step, or touches the vault/public-repo boundary. §12 lists the open questions and their defaults — the defaults are good; take them unless you find a reason not to, and record the reason if you deviate.

## When you finish

Update **`README.md` → Current status** with what's done and what's next. It's the first thing the next agent reads, and it's how the handoff chain stays intact.
