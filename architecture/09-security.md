# Security & Threat Model

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 7. Security and threat model

| Threat | Vector | Mitigation |
|---|---|---|
| **Confused deputy** | Gateway forwards inbound token upstream | Hard plane separation; gateway holds its own upstream credentials; never forwards (§4.3) |
| **SSRF via CIMD fetch** *(Option A only)* | Malicious `client_id` URL → `169.254.169.254` | **Eliminated entirely under Option B** (§4.3) — the gateway fetches no attacker-supplied URL. The guard (`ssrf.ts`: HTTPS-only, public-IP-only, redirect cap, size cap, timeout) is built and table-tested (§8.4) but wired to nothing; it arms with the first dynamic-fetch consumer (P6) |
| **Mix-up attack** | Malicious AS replays a code from an honest AS | RFC 9207 `iss` validation is the *client's* job (Claude Code, the console's OIDC client against one fixed issuer); the gateway is RS-only and neither emits nor checks `iss`. Not tested in this repo |
| **Prompt injection via tool output** | Malicious content in a fetched page or issue body | Results tagged untrusted-content; writes from non-high surfaces need confirm; the permanent `*.send_*` deny rule. *Planned:* egress allowlist (§4.6) |
| **Memory poisoning** | False `preference` planted via Discord | Every candidate from a non-high-trust episode is quarantined wholesale (no per-type carve-out); `untrusted` episodes are refused at ingest; `brain.pin` from a non-high surface hits the matrix's confirm (§6.5) |
| **Surface spoofing** | Random Discord user messages the bot | *P6 (unbuilt):* exact-id allowlist; non-matches ignored, not merely denied |
| **Credential theft** | Host compromise | Envelope encryption, master key outside DB, no inbound ports beyond Caddy. Upstream credentials are static refresh tokens and keys, rotated by hand — not short-lived |
| **Malicious MCP server** | Community server reads your files | *Today:* process-level isolation only — scrubbed env, neutral cwd, one container that mounts the vault — and every roster entry is first-party code (§4.6). *Planned before the first third-party server:* per-server container, no host mounts, egress allowlist |
| **Runaway agent** | Loop calls a paid API 10k times | 120/min sliding-window cap, one window per gateway process (single user); confirm-default policy. No spend cap or circuit breaker in the gateway — the OpenAI dashboard usage limit (§7) is the spend backstop |
| **Secret leak to public repo** | Committed `.env` or token | §9 — gitleaks pre-commit + CI, push protection, `.env.example` only |
| **Vault leak to public repo** | Personal memory pushed publicly | **§9.1 — separate repos.** CI check fails if vault-shaped paths appear |
| **Supply chain** | Malicious transitive dep | Committed `bun.lock`, lifecycle scripts off by default, Dependabot, `bun audit` gate, digest-pinned base images (§9.3) |

**Deliberately out of scope:** multi-tenancy, RBAC, SOC2. Single user. Building them is the main way this project fails to ship.

---

---

[← Index](./README.md)
