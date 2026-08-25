# Security & Threat Model

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 7. Security and threat model

| Threat | Vector | Mitigation |
|---|---|---|
| **Confused deputy** | Gateway forwards inbound token upstream | Hard plane separation; gateway holds its own upstream credentials; never forwards (§4.3) |
| **SSRF via CIMD fetch** *(Option A only)* | Malicious `client_id` URL → `169.254.169.254` | **Eliminated entirely under Option B** (§4.3) — you never fetch attacker-supplied URLs. Under Option A: HTTPS-only, public-IP-only, redirect cap, size cap, timeout; explicit test target (§8.4) |
| **Mix-up attack** | Malicious AS replays a code from an honest AS | RFC 9207 `iss` validation against recorded issuer |
| **Prompt injection via tool output** | Malicious content in a fetched page or issue body | Results tagged untrusted-content; writes from non-high surfaces need confirm; egress allowlist |
| **Memory poisoning** | False `preference` planted via Discord | Non-high-trust writes go to quarantine; `preference` and `pin` require high-trust origin |
| **Surface spoofing** | Random Discord user messages the bot | Exact-id allowlist; non-matches ignored, not merely denied |
| **Credential theft** | Host compromise | Envelope encryption, master key outside DB, short-lived upstream tokens, no inbound ports beyond Caddy |
| **Malicious MCP server** | Community server reads your files | Per-server container, no host mounts, egress allowlist |
| **Runaway agent** | Loop calls a paid API 10k times | Per-principal rate and spend caps in gateway; circuit breakers |
| **Secret leak to public repo** | Committed `.env` or token | §9 — gitleaks pre-commit + CI, push protection, `.env.example` only |
| **Vault leak to public repo** | Personal memory pushed publicly | **§9.1 — separate repos.** CI check fails if vault-shaped paths appear |
| **Supply chain** | Malicious transitive dep | Committed `bun.lock`, lifecycle scripts off by default, Dependabot, `bun audit` gate, digest-pinned base images (§9.3) |

**Deliberately out of scope:** multi-tenancy, RBAC, SOC2. Single user. Building them is the main way this project fails to ship.

---

---

[← Index](./README.md)
