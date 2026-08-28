# The Web Console

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 15. `packages/console` — the authenticated vault viewer + ops dashboard

Added post-P5 (W1, 2026-08-27). Two things behind one login on one real
domain: the root is the **live vault**, rendered read-only; `/dashboard` is
the **ops hub** for everything running behind the brain. The concrete
hostname, tenant, and tailnet names are deployment config and never appear
in this public repo (§9.2/§9.4) — examples below use placeholders.

### 15.1 Exposure model: a real domain that only the tailnet can reach

The §3.1 posture (zero public ingress) survives contact with a public
domain: public DNS points `console.example.com` at the VM's **tailnet IP**.
Anyone can resolve the name; only tailnet devices can route to it. TLS is a
real Let's Encrypt certificate obtained via **DNS-01** (which needs a DNS
API, not reachability — the domain's DNS host must have one; GoDaddy's is
closed to small accounts, which forces the zone onto an API-capable host
first). Caddy fronts 443 and proxies to the loopback-bound services — it
subsumes `tailscale serve`, and `GATEWAY_RESOURCE` migrates to the real
domain. *Implemented:* Caddy runs under the compose profile `edge`
(production-only; dev stacks never interpolate it), serving a certificate
that `deploy/vm/certs.sh` obtains and renews via lego DNS-01 with a
monthly systemd timer — vanilla Caddy image, no DNS plugin build. Documented escalation if a no-tailnet device ever matters:
Cloudflare Tunnel + Access, addable without touching the app.

The window to know about: between the registry delegation flip and the new
DNS host serving the zone, fresh resolver lookups SERVFAIL. It cannot be
pre-warmed; schedule migrations for quiet hours.

### 15.2 Auth: OIDC session on top of the network gate

Same trust chain as the gateway (§4.3), different grant: the console is a
**confidential authorization-code + PKCE client** against the same IdP
tenant; the id_token verifies against the issuer JWKS (jose); the session
is a stateless HMAC cookie (HttpOnly, SameSite=Lax, 7d) so deploys never
log the owner out. `CONSOLE_ALLOWED_SUB` pins the console to the owner's
identity — any other authenticated user gets a 403 *that shows their sub*
(pinning requires learning the sub once). Dev stack runs the same code
against the compose Keycloak; only env differs. Logout clears the cookie
and lands on a **local** signed-out page rather than bouncing to `/login`
— the IdP's SSO cookie would silently re-login and make the button a
no-op; ending the IdP session too is offered as an explicit link
(`end_session_endpoint` from discovery, when the issuer publishes one).

### 15.3 The viewer: render the source of truth, don't mirror it

No static site generator, no Obsidian Publish, no rebuild step: the console
reads the same `/data/vault` (and FTS5 index) the consolidator maintains,
via `@brain/brainstore` — parsing, wikilink vocabulary, and search already
existed; the viewer is a thin server-rendered layer (marked + a CSS file's
worth of style, CSP `default-src 'self'`, zero external assets). Node pages
show summary/body with `[[wikilinks]]` resolved to viewer links, typed
edges both directions, pins, and provenance; plus index-by-type, episode
timeline, and FTS5 search. `/graph` (owner-requested, 2026-08-28 — ends
the §15.5 deferral) renders the typed graph itself: a hand-rolled force
layout on a canvas, no library — the CSP admits only same-origin scripts,
and at vault scale O(n²) repulsion is nothing. Data ships as `/graph.json`
from `loadGraph()`; nodes are sized by degree, colored by a fixed
type→slot mapping from a CVD-validated categorical palette (both console
surfaces; identity never rides color alone — hover cards, a
type-toggle legend, and the index page as the table view). Superseded
nodes render faded. Hover focuses a neighborhood (eased dim, edge
labels, a summary-bearing card); click opens the node page. An
Obsidian-style settings panel (localStorage-persisted) drives display
(arrows, node size, link width, label density, animate) and forces
(repel, link distance, center pull), plus a node search filter. **The console never writes** — the single-writer
consolidator remains the only writer (§5.7); read-only is a code-level
discipline (SQLite WAL needs fs write access even for readers).

### 15.4 The dashboard: links + live truth + expiry radar

Tiles are server-side fetches, briefly cached, individually degradable — an
unreachable source renders a warning, never a broken page: gateway health
(PRM probe), vault stats + last commit/push, consolidation queue and batch
depth (§5.8 tables), last deploy (GitHub API), and **credential expiries**.
Links and expiry items come from the private vault (`config/console.yaml`),
not the repo. The expiry tile grades urgency (green/amber/red by days
left); the standing items it exists for: the DNS-API token (~90d) and the
VM's Tailscale node key (~180d unless expiry is disabled per-machine).

Two sections grew out of that config file (W1.6, 2026-08-28):

**Service cards** — one card per external SaaS the system leans on, from a
`services:` list in the same private config: the account the owner signs
in with, the official console link, per-credential expiry rows (same
grading), and an optional **live probe** the console runs server-side.
Probes exist only where no new secret is needed: `azure` reads ARM via the
VM's system-assigned managed identity (IMDS; falls back to the az CLI on a
dev laptop) for the VM roster + power state, a retail-rate monthly
estimate (public Prices API, CAD), and budgets with `currentSpend` — which
the sponsorship subscription reports as zero (credit burn ≠ "spend" to the
Consumption API; the card says so rather than pretending). `oidc` checks
the console's own issuer discovery; `openai`/`vercel` validate keys the
env already carries (compose passes them through, absent = config-only).
The openai card adds month-to-date spend when `OPENAI_ADMIN_KEY` is set —
the costs endpoint rejects regular keys (403, `api.usage.read` is
admin-only), so this is a separate, optional credential (§13). Probe
results cache 5 min on success but only 30 s on failure, so a probe that
failed once at container start recovers fast instead of pinning the card.
A manual "refresh all cards" button drops every tile and probe cache —
server-throttled to one forced refresh per minute so upstream APIs never
see a button-mash.
The managed identity needs a one-time Reader grant at subscription scope —
an owner-run `az role assignment create` (IAM changes stay human).

**MCP upstream status** — deliberately separate from service cards (SaaS ≠
MCP servers): the roster comes from the same private `servers.yaml` the
gateway reads, live state from a new unauthenticated gateway endpoint
`GET /healthz/upstreams` (pool status: up/down, tool count, last error).
Internal in practice — the edge routes only `/mcp*` and PRM to the
gateway, so the endpoint never leaves the compose network. A roster row
the gateway doesn't report renders "not loaded" (restart to pick up
config); an unreachable gateway degrades the whole section to roster-only.

### 15.5 Deliberately not built

Secret *reveals* in the browser (the draft's step-up flow) wait until the
need is proven — `brain secret` on the box covers it, and the master key
stays off the VM's web path meanwhile. Also skipped: SPAs, ~~graph
visualizations (v1)~~ *(deferral ended 2026-08-28: the owner asked; built
server-light in §15.3 — the pages stay server-rendered, the graph is the
one canvas)*, and any new secret storage.

### 15.6 The architecture tab

`/architecture` renders the whole system as one server-side SVG — no
external assets, themed by the page's CSS variables, hand-authored from
small box/arrow helpers in `architecture.ts`. It deliberately duplicates
the §2 mermaid overview at higher fidelity (edge, auth, deploy, and cost
planes included): the console is where the owner actually looks, and a
map you can open next to the dashboard earns its duplication. Hostnames
and accounts stay out — the file is public (§9.4), so the diagram uses
placeholders where the truth is private. When the architecture moves,
this page is part of keeping the docs true (`architecture-sync`).

---

---

[← Index](./README.md)
