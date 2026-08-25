---
id: restic-offsite-backups
type: decision
title: "Nightly restic snapshots to offsite storage"
aliases: ["offsite backups", "restic"]
tags: [infra, storage, backup]
created: 2026-03-14
updated: 2026-03-14
status: active
confidence: high
sources: ["[[2026-03-14-disk-failure-postmortem]]"]

caused_by: ["[[disk-failure-march-2026]]"]
depends_on: ["[[backblaze-b2]]"]
about: ["[[home-lab]]"]

summary: >
  Encrypted restic snapshots run nightly to Backblaze B2 with 90-day retention
  and a monthly restore drill. Covers what the mirror cannot: deletion
  mistakes, ransomware, and the house itself.
---

## Links
- caused_by → [[disk-failure-march-2026]]
- depends_on → [[backblaze-b2]]
- about → [[home-lab]]
