---
id: sqlite-single-file-db
type: decision
title: "SQLite as the only database"
aliases: ["sqlite choice", "database choice"]
tags: [software, storage]
created: 2025-12-05
updated: 2026-04-15
status: active
confidence: high

supersedes: ["[[postgres-container-db]]"]
caused_by: ["[[prefers-boring-tech]]"]
about: ["[[garden-tracker]]"]

summary: >
  One SQLite file, WAL mode, backed up by the lab's restic run like any other
  file. Replaced the Postgres container after realizing the app has one writer
  and reads measured per minute, not per second.
---

## Links
- supersedes → [[postgres-container-db]]
- caused_by → [[prefers-boring-tech]]
- about → [[garden-tracker]]
