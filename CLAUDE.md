# brain — working in this repo

This repo hosts a personal memory system and eats its own dogfood: the
owner's brain is reached through the user-scope `tool-gateway-remote` MCP
server — HTTPS to the deployed gateway on brain-vm, the same one every other
directory uses. There is no project-scope gateway, and `vault/` here is a
read-only clone: the VM is the only writer (§3.1). The brain MCP server is
one upstream behind the gateway (§4), not the gateway itself.

- **Recall before acting** on anything the brain may already know — past
  decisions, constraints, preferences, project history. The `brain-memory`
  skill is the protocol.
- **Capture durable facts the moment they emerge**, not at session end; a
  SessionEnd hook delivers the transcript to the VM as a backstop.
- **Architecture first**: read `architecture/README.md` before building
  anything; the `architecture-sync` skill is the protocol for keeping the
  docs true.
