---
id: nginx-reverse-proxy
type: decision
title: "nginx as the lab reverse proxy"
tags: [infra]
created: 2025-11-22
updated: 2026-01-15
status: superseded

about: ["[[home-lab]]"]

summary: >
  The original proxy: nginx with manually templated vhosts and a certbot
  renewal cron. Worked, but every new service meant editing config in two
  places. Replaced by Caddy in January 2026.
---

## Links
- about → [[home-lab]]
