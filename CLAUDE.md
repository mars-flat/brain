# brain — working in this repo

This repo hosts a personal memory system and eats its own dogfood: the
`brain-gateway` MCP server in `.mcp.json` exposes the owner's brain.

- **Recall before acting** on anything the brain may already know — past
  decisions, constraints, preferences, project history. The `brain-memory`
  skill is the protocol.
- **Capture durable facts the moment they emerge**, not at session end; a
  SessionEnd hook ingests the transcript as a backstop.
- **Architecture first**: read `architecture/README.md` before building
  anything; the `architecture-sync` skill is the protocol for keeping the
  docs true.
