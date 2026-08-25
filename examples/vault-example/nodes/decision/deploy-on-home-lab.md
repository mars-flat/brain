---
id: deploy-on-home-lab
type: decision
title: "The tracker deploys on the home lab"
tags: [garden, infra]
created: 2026-01-05
updated: 2026-08-21
status: active
sources: ["[[2026-08-21-home-lab-review]]"]

caused_by: ["[[self-hosting-preference]]", "[[budget-conscious-hosting]]"]
depends_on: ["[[docker-compose-stacks]]"]
about: ["[[garden-tracker]]"]

summary: >
  The tracker is one more compose stack on the lab box behind Caddy, reached
  over the mesh. Zero marginal hosting cost and the garden data stays home.
  Re-confirmed at the August review.
---

## Links
- caused_by → [[self-hosting-preference]], [[budget-conscious-hosting]]
- depends_on → [[docker-compose-stacks]]
- about → [[garden-tracker]]
