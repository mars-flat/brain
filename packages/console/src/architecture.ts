/**
 * The architecture tab: the whole system on one server-rendered SVG —
 * detailed enough to navigate by, small enough to read. Pure static
 * markup (CSP `default-src 'self'` holds; theme rides the page's CSS
 * variables). Concrete hostnames/accounts stay out: this file is public
 * (§9.4) — the diagram uses placeholders where the truth is private.
 * Prose companion: architecture/ in the code repo, §2 for the overview.
 */

import { page } from "./html.ts";

function box(x: number, y: number, w: number, h: number, title: string, lines: string[]): string {
  const text = lines
    .map((l, i) => `<text class="l" x="${x + 10}" y="${y + 36 + i * 15}">${l}</text>`)
    .join("");
  return `<rect class="b" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
    <text class="t" x="${x + 10}" y="${y + 19}">${title}</text>${text}`;
}

function grp(x: number, y: number, w: number, h: number, label: string): string {
  return `<rect class="grp" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>
    <text class="gl" x="${x + 10}" y="${y + 16}">${label}</text>`;
}

function flow(d: string, label?: string, lx?: number, ly?: number, dash = false): string {
  const path = `<path class="fl${dash ? " dash" : ""}" d="${d}"/>`;
  return label ? `${path}<text class="al" x="${lx}" y="${ly}">${label}</text>` : path;
}

const ARCH_STYLE = `
.arch svg { font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.arch .grp { fill:none; stroke:var(--line); stroke-dasharray:6 4; }
.arch .b   { fill:var(--card); stroke:var(--line); }
.arch .t   { fill:var(--fg); font-weight:600; font-size:12.5px; }
.arch .l   { fill:var(--muted); font-size:11px; }
.arch .gl  { fill:var(--accent); font-size:10.5px; font-weight:600; letter-spacing:.08em; }
.arch .fl  { stroke:var(--muted); fill:none; stroke-width:1.3; marker-end:url(#arr); }
.arch .fl.dash { stroke-dasharray:5 4; }
.arch .al  { fill:var(--muted); font-size:10.5px; font-style:italic; }
`;

export function architecturePage(): string {
  const svg = `
<svg viewBox="0 0 1180 960" role="img" aria-label="system architecture diagram">
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)"/></marker></defs>

${grp(20, 20, 560, 150, "OWNER DEVICES — THE LAPTOP")}
${box(40, 50, 240, 105, "Claude Code + brain CLI", ["MCP client → gateway /mcp", "SessionEnd hook → episode envelope", "PKCE login (brain-cli client)"])}
${box(300, 50, 120, 105, "browser", ["console UI", "vault + ops"])}
${box(436, 50, 124, 105, "Obsidian", ["edits the laptop", "vault clone", "(second writer)"])}

${grp(620, 20, 540, 150, "IDENTITY — AUTH0 TENANT")}
${box(640, 50, 240, 105, "OIDC issuer + JWKS", ["owner's Google sub pinned", "database signups disabled", "step-up scopes are real (§4.3)"])}
${box(900, 50, 240, 105, "registered clients", ["console — code+PKCE, confidential", "brain-cli — PKCE, public", "brain-hook — client-credentials"])}

${grp(20, 210, 1140, 140, "THE EDGE — A REAL DOMAIN ONLY THE TAILNET CAN REACH (§15.1)")}
${box(40, 240, 260, 90, "public DNS — Vercel zone", ["brain.&lt;domain&gt; → tailnet IP", "anyone resolves, nothing routes", "also the DNS-01 API for certs"])}
${box(330, 240, 240, 90, "tailnet (WireGuard)", ["the only network path in", "no public IP anywhere"])}
${box(600, 240, 280, 90, "Caddy :443 (profile: edge)", ["Let's Encrypt cert via lego DNS-01", "monthly renew timer reloads it"])}
${box(910, 240, 230, 90, "routes", ["/mcp* + PRM → gateway", "everything else → console"])}

${grp(20, 390, 1140, 340, "AZURE brain-vm — Standard_B2pls_v2 ARM · canadacentral · NO PUBLIC IP · DOCKER COMPOSE (§3.1)")}
${box(40, 430, 260, 100, "console :8091", ["OIDC session — HMAC cookie, 7d", "read-only vault viewer + ops hub", "pinned to the owner sub, else 403"])}
${box(330, 430, 260, 100, "gateway :8090", ["OAuth resource server (§4.3)", "4 meta-tools · policy · audit chain", "scope step-up · confirm · rate cap"])}
${box(620, 430, 220, 100, "stdio pool", ["one MCP client per upstream", "scrubbed env, neutral cwd", "down server ≠ down gateway"])}
${box(620, 570, 220, 70, "brain-mcp", ["recall · expand · note · pin", "ingest · search · timeline"])}
${box(870, 570, 240, 70, "other MCP servers", ["roster: private servers.yaml", "pattern, not a fixed list (§4.2)"])}
${box(330, 570, 260, 70, "core runtime", ["traverse · pack · recall (§5)", "BM25 via FTS5 — no embeddings"])}
${box(330, 660, 260, 60, "consolidator — single writer", ["episodes → nodes · quarantine · trust"])}
${box(40, 570, 260, 150, "vault — /data/vault", ["nested git repo — never in the", "public code repo (§9.1)", "nodes/ typed edges · episodes/", "_index/brain.db — SQLite FTS5", "secrets/ — envelope-encrypted refs"])}
${box(870, 652, 240, 74, "systemd timers", ["batch consolidate", "nightly vault push · cert renew"])}

${grp(20, 770, 440, 140, "GITHUB")}
${box(40, 800, 400, 95, "mars-flat/brain (public) + brain-vault (private)", ["push to main → Actions — OIDC, zero stored keys", "→ GHCR image → az run-command → doctor gate,", "rollback on red · private remote holds the vault"])}
${box(490, 770, 320, 140, "OpenAI API — gpt-5.6-luna", ["extraction + consolidation calls", "structured outputs, batched cadence (§5.8)", "billed outside Azure — dashboard", "usage limit is the control (§7)"])}
${box(840, 770, 320, 140, "Azure cost guard", ["budgets CAD: 110 tripwire · 180 shutdown", "· 2000 annual credit cap", "at 100% of 180 → action group →", "Stop-AllVMs runbook · no hard cap exists (§3.2)"])}

${flow("M 160 155 V 240", "MCP + login", 60, 205)}
${flow("M 360 155 V 240", "HTTPS", 370, 205)}
${flow("M 498 155 V 185 H 10 V 830 H 40", "clone ⇄ private remote", 30, 180, true)}
${flow("M 580 95 H 620", "sign in", 566, 88, true)}
${flow("M 300 285 H 330")}
${flow("M 570 285 H 600")}
${flow("M 880 285 H 910")}
${flow("M 990 330 V 358 H 170 V 430", "else → console", 180, 353)}
${flow("M 1060 330 V 384 H 480 V 430", "/mcp → gateway", 490, 380)}
${flow("M 890 170 V 372 H 460 V 430", "token verify (JWKS)", 640, 367, true)}
${flow("M 590 480 H 620")}
${flow("M 730 530 V 570")}
${flow("M 840 480 H 990 V 570", "spawn", 950, 475)}
${flow("M 620 605 H 590")}
${flow("M 330 605 H 300", "reads", 302, 598)}
${flow("M 170 530 V 570", "reads (RO)", 180, 555)}
${flow("M 700 640 V 690 H 590", "ingest queue", 620, 682)}
${flow("M 330 690 H 300", "ONLY writer", 226, 685)}
${flow("M 240 770 V 730", "deploys", 248, 755)}
${flow("M 170 720 V 800", "nightly push", 180, 760, true)}
${flow("M 520 720 V 770", "extraction", 530, 750)}
${flow("M 1000 770 V 730", "stops VMs at cap", 1010, 755, true)}

<text class="al" x="20" y="945">solid = request/data path · dashed = auth, git sync, or cost control · §N = architecture/ chapter refs</text>
</svg>`;

  return page(
    "architecture",
    `<div class="arch">
      <style>${ARCH_STYLE}</style>
      <h1>architecture</h1>
      <p class="muted">the whole system, one picture. deep dives live in <code>architecture/</code> in the code repo — § numbers here are its stable section refs.</p>
      <div class="svgwrap">${svg}</div>
      <p class="muted">the short version: everything runs on one Azure VM nobody can route to except over the owner's tailnet, even though its name is public DNS.
      Caddy terminates TLS for two loopback services — the console (this page) and the MCP gateway — both trusting the same Auth0 tenant, pinned to one human.
      The vault is the brain: plain markdown in its own private git repo, indexed to SQLite, written by exactly one process, and mirrored nightly to GitHub.
      Deploys ride push-to-main through OIDC with a doctor-gated rollback; a budget guillotine deallocates every VM if spend ever runs away.</p>
    </div>`,
    { authed: true, wide: true },
  );
}
