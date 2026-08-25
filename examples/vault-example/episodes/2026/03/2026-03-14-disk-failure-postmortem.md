---
episode_id: ep_01HRXDISKFA1LURE0000000001
started_at: 2026-03-14T19:02:00Z
ended_at: 2026-03-14T19:40:00Z
surface: cli
harness: claude-code
trust: high
labels: [home-lab]
---

**user** — The single ext4 disk in the mini PC just died and took the media library metadata with it. I want to never be in this position again.

**assistant** — Two independent changes: local redundancy (a ZFS mirror across two disks) and an offsite copy (restic snapshots to Backblaze B2). The mirror handles disk death; restic handles fat-fingered deletes and house-level risk.

**user** — Agreed on both. Order the second disk, and let's do nightly restic with a 90-day retention.
