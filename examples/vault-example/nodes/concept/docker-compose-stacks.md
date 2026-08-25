---
id: docker-compose-stacks
type: concept
title: "Everything runs as Docker Compose stacks"
aliases: ["compose stack"]
tags: [infra]
created: 2025-11-20
updated: 2026-08-21
status: active

about: ["[[home-lab]]"]
example_of: ["[[infrastructure-as-code]]"]

summary: >
  One compose file per service group, all in a single git repo.
  Rebuild-from-scratch is `git clone` plus `docker compose up`. No service is
  installed on the host directly, which is what made the disk failure
  survivable.
---

## Links
- about → [[home-lab]]
- example_of → [[infrastructure-as-code]]
