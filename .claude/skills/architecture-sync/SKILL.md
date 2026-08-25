---
name: architecture-sync
description: Read the spec in `architecture/` before writing code in this repo, and update it whenever an implementation decision turns out different from what's written. Use this whenever you are about to implement, scaffold, refactor, or design anything here — starting a build phase (P0–P6), adding a package, picking a library, changing a dependency/model/host, wiring CI, or answering "how should X work". Use it again after finishing, to check whether what you built still matches what the docs claim. The architecture is the source of truth; a doc that no longer describes reality is a bug, not a stale comment.
---

# Architecture-first development

## Why this exists

`architecture/` reached a buildable state over five revisions and an implementability audit that found twelve issues, two of them blockers. Several decisions in it are load-bearing in non-obvious ways:

- `supersedes` edges are followed to the terminal node **ignoring the token budget** — without that, memory confidently serves last month's answer (§5.3)
- `salience` lives only in SQLite, never in note frontmatter — putting it in the note makes every read a write and races the consolidator (§5.2)
- The vault is a **separate nested git repo**, not just a gitignored folder — git cannot stage the contents of a directory containing its own `.git`, which is what makes an agent's `git add -A` structurally incapable of leaking personal conversations to a public repo (§9.1)
- Node ids are bare basenames because Obsidian's autocomplete emits `[[foo]]`, not `[[decision/foo]]` — path-form links would break on every hand-edit (§5.2)

Each of those is written down *because the obvious implementation was wrong*. Building without reading means rediscovering them the expensive way.

The second half matters as much. Docs that drift become docs nobody trusts, and once nobody trusts them the architecture stops being a decision record and becomes archaeology. When you deviate, the doc changes. That isn't bureaucracy — it's what stops the next agent from being misled by you.

## Before you build

**Read `architecture/README.md` first.** 66 lines: locked decisions, navigation, current status, and what's blocked.

Then read **only** the chapter covering what you're touching. The docs were split precisely so nobody loads 1,600 lines to change one file — reading all of them defeats the design and wastes the context you need for the actual work.

| Working on | Read |
|---|---|
| `packages/contracts/` — schemas, ports | `12-roadmap` (layout) + the chapter owning that contract |
| Node parsing, edges, Obsidian format, storage | `05-brain-model` |
| Traversal, packing, scoring, consolidation, lint | `06-brain-runtime` |
| `packages/gateway/` — MCP, auth, policy, tool index | `04-gateway` |
| `packages/agent-runtime/`, `surface-*`, session router | `08-surfaces` |
| `adapters/`, Docker, Compose, anything Azure | `03-deployment` (+ `azure/azure-config.md`) |
| Tests, invariants, CI workflows | `10-testing` |
| `.github/`, secrets, `.gitignore`, dependencies | `11-repo-safety` |
| Model choice, reasoning effort, spend | `07-cost` |
| Phase scope, what's next, open questions | `12-roadmap` |
| Setting up an account, key, or the Discord bot | `13-setup` |

Cross-references use stable § numbers that don't move when files do. `grep -rn "§5.7" architecture/` finds the target wherever it lives.

## When your implementation deviates

You will hit things the architecture got wrong, underspecified, or that reality overruled. That's expected — it's a design doc, not a prophecy. What matters is that the deviation lands in the doc rather than only in the code.

**Record it when the change affects any of:**

- **A decision** someone could reasonably have made differently — a library, host, protocol, model, or approach
- **A contract** — a schema, tool signature, envelope shape, or port interface
- **An invariant** — the traversal rules, trust tiers, the single-writer guarantee, budget behavior
- **Cost or a phase estimate**
- **A prerequisite** — something a human has to do that wasn't listed

**Don't record** variable names, file organization inside a package, behavior-preserving refactors, or anything a reader would learn faster from the code itself. Noise in the architecture is as corrosive as staleness; the test is whether a future agent would be *misled* without it.

**Where it goes:**

| Kind of change | Edit |
|---|---|
| A locked decision changed or a new one was made | `README.md` §0 table |
| An open question got answered | `12-roadmap` §12 — strike it through and state the resolution, don't delete the row |
| A mechanism works differently than described | The owning chapter, at the § where it's described |
| A phase's scope, estimate, or done-when moved | `12-roadmap` §11 |
| A new human prerequisite appeared | `13-setup` |
| Something turned out not to be needed | `14-appendix` — "what not to build" |

**Keep the edits honest.** Say what changed and why, in the same voice as the surrounding text. If a decision was reversed, note what reversed it — the reasoning is more valuable than the conclusion, because it's what lets someone re-evaluate when circumstances change. The `14-appendix` revision audit is a good model: it records superseded thinking rather than erasing it.

## Mechanics that are easy to get wrong

- **Don't recreate `ARCHITECTURE.md`.** It was deliberately split. A single file defeats the point.
- **Keep § numbers stable.** They're the cross-reference system. Renumbering breaks references in other files, in the code, and in past conversations. Add `§5.12` rather than renumbering `§5.5`–`§5.11`.
- **Update the README nav table** when you add or remove a chapter. Line counts there are approximate — refresh with `wc -l architecture/*.md` after a substantial change, but don't chase small drift.
- **README status stays current.** If you finish a phase or clear a blocker, the "Current status" section should say so. It's the first thing the next agent reads.
- **Never let vault content into `architecture/`.** The vault is personal conversation and this repo is public (§9.1). Examples in the docs are synthetic; keep them that way.

## After you finish a chunk of work

Ask: **would someone reading only the architecture build what I just built?** If not, either the code drifted from a decision that still stands (fix the code) or the decision changed (fix the doc). Both are fine; leaving them disagreeing is not.
