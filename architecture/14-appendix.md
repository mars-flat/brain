# What Not To Build · Glossary

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 14. What not to build

- **A graph database.** SQLite handles 10⁵ edges without noticing.
- **A vector database.** §1. Revisit only if `brain eval` says so.
- **Kubernetes.** Compose on one box. You have three containers (gateway, console, caddy) — plus Keycloak only in the dev overlay.
- **A web UI** — *built after all* (W1, 2026-08-28, §15). Obsidian is still the *graph-editing* UI, and that part of the rule held: the console never writes the vault. What got built is an authenticated viewer plus an ops dashboard, because the vault lives on a VM the owner does not open Obsidian against, and later the one write surface that is not memory at all — the tasks tab (§16). The rule survives as "no web UI for editing memory".
- **Multi-tenancy / RBAC.** One user.
- **Real-time consolidation.** Debounced batch produces a dramatically cleaner graph at zero cost to you.
- **An authorization server at all, probably.** Implement RFC 9728 protected resource metadata, audience validation, and scope challenges — that's the resource-server half, and it's required. Let a hosted IdP be the AS (§4.3, question 6). Definitely no consent-management UI for a single user.
- **Your own agent loop from scratch.** Use the OpenAI Agents SDK in `agent-runtime` (§6.0). Write the four things specific to this system; inherit the rest.
- **A public IP — until WhatsApp.** Discord is outbound-only and Tailscale covers laptop access (§3.1). *TLS and Caddy were built after all* (2026-08-28, §15.1, §12 Q3): the console wanted to be a normal HTTPS site, and a real Let's Encrypt cert via DNS-01 on a tailnet-only name costs one timer and no exposure. The public IP is the part that is an attack surface, and it is still not built.
- **Hermes, WhatsApp, or any second surface before P6 ships.** The ports exist so you *can* — which is exactly why you don't need to yet.
- **A second gateway, or a second writable copy of the vault, on the laptop.** One deployed gateway from every directory; the laptop's clone is read-only (§3.1). Two writers met only through the remote and drifted within days — twice (2026-09-17).

---

## Appendix A — References

- MCP Authorization `2026-07-28` — [spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) · [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) · [security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- OAuth Client ID Metadata Documents — [draft-ietf-oauth-client-id-metadata-document-00](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- RFC 9728 Protected Resource Metadata · RFC 9207 Issuer Identification · RFC 8707 Resource Indicators · RFC 8414 AS Metadata · RFC 6750 Bearer Tokens
- Karpathy, *LLM Wiki* — [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- Obsidian Properties — [docs](https://obsidian.md/help/properties)
- SQLite FTS5 — [full-text search + BM25](https://www.sqlite.org/fts5.html)

## Appendix B — Glossary

| Term | Meaning |
|---|---|
| **Principal** | Canonical identity behind any surface. Config-driven, never hardcoded |
| **Surface** | Transport a message arrives on. A free string in the envelope; in use today: `cli`, `claude-code`, `http` (the gateway's HTTP callers). `discord` arrives with P6 |
| **Harness** | Process running the agent loop. Claude Code now; Hermes later |
| **Episode** | One immutable conversation transcript. Layer 0 |
| **Node** | One Obsidian note in the semantic graph. Layer 1 |
| **Pack** | Token-budgeted, tiered rendering of a subgraph — output of `brain.recall` |
| **Tier** | Render depth in a pack: `full` · `summary` · `stub` |
| **Pin** | Human correction that generation may never overwrite |
| **URN** | Stable tool identifier, two segments: `<server>.<tool>` (e.g. `brain.recall`, `g-2006.mail_search`) — the server name from `servers.yaml` plus the tool's own name; there is no namespace segment (§4.4) |
| **CIMD** | Client ID Metadata Document — URL-based OAuth `client_id`, replaces DCR |

---

## Appendix C — Revision 3 implementability audit

Historical. Twelve issues found reviewing revision 2 against "could someone actually build this." Two were blockers. Kept because the *reasons* still constrain the design.

Twelve issues found reviewing revision 2 against "could someone actually build this." Two were blockers.

| Sev | Issue | Fix |
|---|---|---|
| 🔴 | **Nothing ran the agent loop for Discord.** Harness = "runs the agent loop" = Claude Code, a laptop CLI. It cannot answer a Discord message on a server. P6 was unbuildable | New `agent-runtime` component, two named execution modes (§6.0). P6: 3 → 5 days |
| 🔴 | **`salience` in note frontmatter made every read a write** — git churn per query, and a second writer racing the consolidator | Salience lives only in SQLite (§5.2) |
| 🟠 | **Obsidian links wouldn't resolve.** Notes used `[[decision/foo]]`; Obsidian's autocomplete emits `[[foo]]`. Every hand-made link would break | Ids are globally unique basenames; resolve by basename + alias; lint enforces uniqueness (§5.2) |
| 🟠 | **Lint was O(n²)** — all-pairs contradiction and duplicate checks don't terminate at 10⁴ nodes | Mandatory blocking + touched-since watermark (§5.9) |
| 🟠 | **Two authorization systems, no precedence rule** — scopes vs policy engine could silently disagree | Scopes first and coarse; policy second and narrowing-only (§4.3) |
| 🟠 | **Writing an OAuth AS was the largest and riskiest slice of P4**, including an attacker-controlled outbound fetch from the box holding every credential | Recommend hosted IdP; gateway is resource-server only. ~4 → ~2 days (§4.3, §12 q6) |
| 🟡 | "Rebuild produces a byte-identical index" — **SQLite files are never byte-reproducible**, so the test could never pass | Semantic equivalence instead (§8.3) |
| 🟡 | Ranking ties broke by FTS5 rowid, which changes on rebuild — determinism invariant was false | Sort by `(score DESC, id ASC)` everywhere (§5.5) |
| 🟡 | Episode envelope had no `schema_version`, and split `messages`/`tool_calls` discarded interleaving order | `schema_version` + one ordered `turns` array (§5.7) |
| 🟡 | `as_of` glossed over needing a git checkout and a throwaway index per query | Two-stage: cheap date filter now, true time-travel optional later (§5.10) |
| 🟡 | How `agent-runtime` authenticates to the gateway was unspecified | Pre-registered confidential client, `client_credentials`; claims from the router, never self-asserted (§6.0) |
| 🟡 | A 2 GB VM is too small once per-server sandboxing runs | 4 GB (`B2pls_v2`) from §4.6 onward (§3.1) |

---

---

[← Index](./README.md)
