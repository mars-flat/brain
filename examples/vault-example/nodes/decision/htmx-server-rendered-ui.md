---
id: htmx-server-rendered-ui
type: decision
title: "Frontend is server-rendered HTML with htmx"
aliases: ["htmx frontend", "frontend choice"]
tags: [software, frontend]
created: 2026-06-02
updated: 2026-06-02
status: active
confidence: high
sources: ["[[2026-06-02-garden-tracker-frontend-rewrite]]"]

supersedes: ["[[react-spa-frontend]]"]
caused_by: ["[[prefers-boring-tech]]"]
about: ["[[garden-tracker]]"]
example_of: ["[[progressive-enhancement]]"]

summary: >
  Templates render on the server; htmx swaps partials for the interactive
  dashboard bits. One deploy artifact, forms that work without JavaScript, and
  roughly a tenth of the previous bundle surface. The third and intended-final
  frontend.
---

## Detail

Second rewrite: jquery prototype → React SPA → this. The lesson recorded: interactivity needs were overestimated from the start.

## Links
- supersedes → [[react-spa-frontend]]
- caused_by → [[prefers-boring-tech]]
- about → [[garden-tracker]]
- example_of → [[progressive-enhancement]]
