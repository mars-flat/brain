---
id: server-authoritative-state
type: decision
title: "The server is the single source of truth"
tags: [software, architecture]
created: 2026-06-02
updated: 2026-06-02
status: active

contradicts: ["[[local-first-sync]]"]
about: ["[[garden-tracker]]"]

summary: >
  All state lives in the server's SQLite; clients hold no durable data.
  Simple, consistent, and honest about the app being unusable offline.
  Standing tension with the local-first idea for garden visits beyond cell
  coverage.
---

## Links
- contradicts → [[local-first-sync]]
- about → [[garden-tracker]]
