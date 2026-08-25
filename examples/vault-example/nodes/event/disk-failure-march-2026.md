---
id: disk-failure-march-2026
type: event
title: "Primary lab disk failed, March 2026"
aliases: ["the disk failure"]
tags: [incident, storage]
created: 2026-03-14
updated: 2026-03-14
status: active
sources: ["[[2026-03-14-disk-failure-postmortem]]"]

about: ["[[home-lab]]"]
mentioned_with: ["[[restic-offsite-backups]]"]

summary: >
  The original NVMe died without SMART warning. Compose stack was reproducible
  from git, but media metadata and two weeks of sensor history were lost.
  Direct cause of the ZFS mirror and the offsite backup routine.
---

## Links
- about → [[home-lab]]
- mentioned_with → [[restic-offsite-backups]]
