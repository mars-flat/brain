---
name: brain-memory
description: Use the brain (graph memory over the owner's vault, reached through the tool-gateway MCP server — the brain's tools are upstreams behind that gateway) in both directions — recall before acting on anything it may already know (past decisions, preferences, constraints, people, project history), and capture durable facts the moment they emerge (a decision made, a preference stated, a correction issued, a constraint discovered). Also covers correcting memory — pin corrections, supersede reversals. Trigger whenever a conversation needs or produces personal or project memory.
---

# Brain memory protocol

The brain is the owner's long-term memory: an Obsidian vault of typed,
linked nodes reached through the tool gateway — the `tool-gateway` MCP
server inside the `~/brain` repo (project scope, stdio), or
`tool-gateway-remote` from any other directory (user scope, HTTPS to
the deployed gateway). The gateway is not the brain — it fronts many
upstream MCP servers, and the brain (`brain.*` URNs) is one of them.
This skill is the protocol for using it well. Mechanics: find tools
with `tools_search` (it matches capability text, not the word
"brain"), inspect with `tools_describe`, invoke with `tools_call`.

## Recall — before acting, not after

- At the start of any non-trivial task, and before consequential
  decisions, call `brain.recall` with a question-shaped query and a
  token budget (e.g. 2000–3000). The pack it returns already follows
  superseded decisions to their replacement and labels contradictions —
  trust its structure.
- If a pack node needs more depth, `brain.expand` it by id;
  `brain.neighbors` shows the surrounding graph; `brain.trace` shows
  which episodes a node came from; `brain.timeline` lists episodes
  chronologically.
- Capture without recall builds an archive nobody reads. When in doubt,
  recall first.

## Capture — at the moment, not at session end

- The instant a durable fact appears, `brain.note` it: a decision made,
  a preference stated, a correction issued, a constraint discovered, a
  person or project detail worth keeping. One fact per note, written for
  a future reader with no session context.
- Do not wait for the end of the conversation, and do not write recap
  notes — a SessionEnd hook ingests the whole transcript as a backstop.
  Deliberate in-the-moment notes beat recaps because they say what
  mattered.
- Over-capture is safe: every write flows through the single-writer
  consolidator, which deduplicates, quarantines anything suspect, and
  git-commits each run. Duplicates collapse; nothing lands silently.
- Do not capture: secrets or credentials (never — the vault is private
  but episodic storage is not a secret store), facts derivable from the
  repo or its git history, or trivia scoped to the current session.

## Correct — memory has edit semantics, use them

- A correction to an existing node → `brain.pin` with the node id, the
  correction, and the reason. Pins render at full tier and block bad
  supersedes.
- A reversal of a recorded decision → `brain.note` stating the new
  decision and that it supersedes the old one (name the old node if
  known). The traversal engine then always chases to the current answer;
  never leave a reversal uncaptured, or the brain will confidently serve
  the stale decision.

## Division of labor with Claude Code auto-memory

Durable facts about the owner and their projects belong in the brain —
the owner owns it, browses it in Obsidian, and it serves every surface.
Claude Code auto-memory keeps only harness-local workflow trivia (tool
quirks, session bootstrap pointers). When a fact would help a future
conversation on any surface, it goes to the brain.
