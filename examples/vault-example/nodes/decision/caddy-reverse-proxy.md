---
id: caddy-reverse-proxy
type: decision
title: "Caddy terminates TLS for all lab services"
aliases: ["caddy", "reverse proxy choice"]
tags: [infra]
created: 2026-01-15
updated: 2026-08-21
status: active
confidence: high
sources: ["[[2026-08-21-home-lab-review]]"]

supersedes: ["[[nginx-reverse-proxy]]"]
caused_by: ["[[automatic-https-requirement]]", "[[prefers-boring-tech]]"]
depends_on: ["[[docker-compose-stacks]]"]
about: ["[[home-lab]]"]

summary: >
  Caddy fronts every lab service with automatic internal-CA certificates and a
  20-line config, replacing nginx and its hand-managed cert renewal scripts.
  Six months in it has needed zero touches.
---

## Detail

The nginx setup wasn't broken, but cert renewal was a cron job with a failure mode discovered only when browsers complained.

## Links
- supersedes → [[nginx-reverse-proxy]]
- caused_by → [[automatic-https-requirement]], [[prefers-boring-tech]]
- depends_on → [[docker-compose-stacks]]
- about → [[home-lab]]
