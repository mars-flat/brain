---
id: zfs-mirror-pool
type: decision
title: "Storage is a two-disk ZFS mirror"
aliases: ["zfs mirror", "storage redundancy"]
tags: [infra, storage]
created: 2026-03-14
updated: 2026-03-14
status: active
confidence: high
sources: ["[[2026-03-14-disk-failure-postmortem]]"]

supersedes: ["[[single-disk-ext4]]"]
caused_by: ["[[disk-failure-march-2026]]"]
about: ["[[home-lab]]"]

summary: >
  Both NVMe slots populated, mirrored with ZFS: any single disk can die
  without data loss, scrubs catch bit rot, and snapshots make restic's job
  atomic. Bought with the March disk failure fresh.
---

## Links
- supersedes → [[single-disk-ext4]]
- caused_by → [[disk-failure-march-2026]]
- about → [[home-lab]]
