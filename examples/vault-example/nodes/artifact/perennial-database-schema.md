---
id: perennial-database-schema
type: artifact
title: "Schema for beds, plantings, and harvests"
aliases: ["tracker schema"]
tags: [garden, software, artifact]
created: 2025-12-05
updated: 2026-06-02
status: active

depends_on: ["[[sqlite-single-file-db]]"]
about: ["[[garden-tracker]]"]

summary: >
  Five tables — beds, plantings, events, harvests, sensors — with plantings as
  the spine. Survived all three frontends unchanged, which is the quiet
  argument that the data model was the real design.
---

## Links
- depends_on → [[sqlite-single-file-db]]
- about → [[garden-tracker]]
