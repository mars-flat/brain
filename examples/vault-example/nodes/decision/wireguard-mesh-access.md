---
id: wireguard-mesh-access
type: decision
title: "Remote access via WireGuard mesh"
aliases: ["mesh vpn", "wireguard"]
tags: [network, security]
created: 2026-02-01
updated: 2026-02-01
status: active
confidence: high

caused_by: ["[[single-public-ip]]", "[[no-open-inbound-ports]]"]
about: ["[[home-lab]]"]

summary: >
  Phones and laptops join a WireGuard mesh; every lab service is reachable
  only over mesh addresses. No dynamic DNS, no port forwards, no
  TLS-on-the-WAN. Survives the ISP address rotation transparently.
---

## Links
- caused_by → [[single-public-ip]], [[no-open-inbound-ports]]
- about → [[home-lab]]
