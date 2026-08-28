/**
 * The ops hub (W1.4): links + live status for everything behind the brain.
 * Every tile degrades gracefully — an unreachable source renders as a
 * warning, never a broken page. Tile data is cached briefly so a dashboard
 * refresh never hammers upstream APIs.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrainStore } from "@brain/brainstore";
import type { ConsoleConfig, ExpiryItem, VaultConsoleConfig } from "./config.ts";
import { esc, page } from "./html.ts";
import { serviceCards, tokenRows } from "./services.ts";

interface Tile {
  title: string;
  html: string;
  cls?: "ok" | "warn" | "bad";
}

const cache = new Map<string, { at: number; value: Tile }>();

async function cached(key: string, ttlMs: number, make: () => Promise<Tile>): Promise<Tile> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await make().catch(
    (e): Tile => ({
      title: key,
      html: `<span class="bad">unavailable: ${esc(e instanceof Error ? e.message : String(e)).slice(0, 120)}</span>`,
      cls: "bad",
    }),
  );
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function gatewayTile(cfg: ConsoleConfig): Promise<Tile> {
  return cached("gateway", 30_000, async () => {
    const started = Date.now();
    const res = await fetch(cfg.gatewayPrmUrl, { signal: AbortSignal.timeout(5000) });
    const prm = (await res.json()) as { resource?: string; authorization_servers?: string[] };
    const ms = Date.now() - started;
    return {
      title: "gateway",
      html: `<span class="ok">healthy</span> · ${ms}ms<br>
        <span class="muted">resource:</span> ${esc(prm.resource ?? "?")}<br>
        <span class="muted">issuer:</span> ${esc(prm.authorization_servers?.[0] ?? "?")}`,
      cls: "ok",
    };
  });
}

function vaultTile(store: BrainStore, vaultPath: string): Tile {
  const counts = store.counts();
  const git = Bun.spawnSync(["git", "-C", vaultPath, "log", "-1", "--format=%h %cr — %s"]);
  const last = git.exitCode === 0 ? git.stdout.toString().trim() : "(no git info)";
  const push = Bun.spawnSync(["git", "-C", vaultPath, "log", "-1", "--format=%cr", "origin/main"]);
  const pushed = push.exitCode === 0 ? push.stdout.toString().trim() : "never";
  return {
    title: "vault",
    html: `${counts.nodes} nodes · ${counts.edges} edges · ${counts.episodes} episodes · ${counts.pins} pins<br>
      <span class="muted">last commit:</span> ${esc(last.slice(0, 90))}<br>
      <span class="muted">remote as of:</span> ${esc(pushed)}`,
    cls: "ok",
  };
}

function consolidationTile(db: Database): Tile {
  const q = (sql: string): number => {
    try {
      return (db.query(sql).get() as { n: number } | null)?.n ?? 0;
    } catch {
      return 0;
    }
  };
  const queued = q("SELECT COUNT(*) AS n FROM queue_items");
  const batches = q("SELECT COUNT(*) AS n FROM extraction_batches WHERE status = 'running'");
  const awaiting = q(
    "SELECT COUNT(*) AS n FROM extraction_requests WHERE candidates_json IS NULL AND error IS NULL",
  );
  const cls = queued > 10 ? "warn" : "ok";
  return {
    title: "consolidation (§5.8)",
    html: `<span class="${cls}">${queued} queued</span> · ${batches} batch${batches === 1 ? "" : "es"} in flight · ${awaiting} awaiting extraction`,
    cls,
  };
}

async function deployTile(): Promise<Tile> {
  return cached("deploy", 120_000, async () => {
    const res = await fetch(
      "https://api.github.com/repos/mars-flat/brain/actions/workflows/deploy.yml/runs?per_page=1",
      { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = (await res.json()) as {
      workflow_runs?: Array<{
        conclusion: string | null;
        status: string;
        updated_at: string;
        head_sha: string;
      }>;
    };
    const run = data.workflow_runs?.[0];
    if (!run) return { title: "last deploy", html: `<span class="muted">no runs</span>` };
    const good = run.conclusion === "success";
    return {
      title: "last deploy",
      html: `<span class="${good ? "ok" : "bad"}">${esc(run.conclusion ?? run.status)}</span>
        · ${esc(run.head_sha.slice(0, 7))} · <span class="muted">${esc(run.updated_at)}</span>`,
      cls: good ? "ok" : "bad",
    };
  });
}

export function expiryTile(expiries: ExpiryItem[], now = new Date()): Tile {
  if (expiries.length === 0)
    return { title: "credential expiries", html: `<span class="muted">none configured</span>` };
  const { html, worst } = tokenRows(expiries, now);
  return { title: "credential expiries", html: `<ul class="plain">${html}</ul>`, cls: worst };
}

/**
 * The MCP servers behind the gateway (§4.2): roster from the same private
 * `config/servers.yaml` the gateway reads, live status from its internal
 * /healthz/upstreams (never routed by the edge). A server in the roster
 * that the gateway doesn't report means the gateway needs a restart to
 * pick up config; the reverse means config drift the other way.
 */
async function mcpSection(cfg: ConsoleConfig): Promise<string> {
  interface UpstreamHealth {
    name: string;
    status: string;
    tool_count: number;
    last_error: string | null;
  }
  let roster: Array<{ name: string; command?: string; args?: string[] }> = [];
  try {
    const file = join(cfg.vaultPath, "config", "servers.yaml");
    if (existsSync(file)) {
      const raw = Bun.YAML.parse(readFileSync(file, "utf8")) as {
        servers?: Array<{ name: string; command?: string; args?: string[] }>;
      } | null;
      roster = raw?.servers ?? [];
    }
  } catch {}

  let health = new Map<string, UpstreamHealth>();
  let healthErr: string | null = null;
  try {
    const res = await fetch(cfg.gatewayHealthUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as UpstreamHealth[];
    health = new Map(list.map((s) => [s.name, s]));
  } catch (e) {
    healthErr = e instanceof Error ? e.message : String(e);
  }

  const names = [...new Set([...roster.map((r) => r.name), ...health.keys()])].sort();
  const rows = names
    .map((name) => {
      const r = roster.find((x) => x.name === name);
      const h = health.get(name);
      const status = h
        ? h.status === "up"
          ? `<span class="ok">up</span>`
          : `<span class="bad">down</span>`
        : `<span class="warn">${healthErr ? "unknown" : "not loaded"}</span>`;
      const runs = r ? esc([r.command ?? "", ...(r.args ?? [])].join(" ").slice(0, 60)) : "";
      const err = h?.last_error ? `<span class="bad">${esc(h.last_error.slice(0, 80))}</span>` : "";
      return `<tr><td>${esc(name)}</td><td>${status}</td>
        <td>${h ? h.tool_count : "?"}</td><td class="muted">${runs}</td><td>${err}</td></tr>`;
    })
    .join("");
  const note = healthErr
    ? `<p class="warn">gateway status unavailable: ${esc(healthErr.slice(0, 100))} — roster shown from config</p>`
    : "";
  return `<div class="card">${note}
    ${names.length ? `<table class="slim"><tr><th>server</th><th>status</th><th>tools</th><th>runs</th><th>last error</th></tr>${rows}</table>` : `<p class="muted">no upstream servers configured</p>`}
  </div>`;
}

export async function dashboardPage(
  cfg: ConsoleConfig,
  vaultCfg: VaultConsoleConfig,
  store: BrainStore,
  db: Database,
  sub: string,
): Promise<string> {
  const tiles: Tile[] = [
    await gatewayTile(cfg),
    vaultTile(store, cfg.vaultPath),
    consolidationTile(db),
    await deployTile(),
    expiryTile(vaultCfg.expiries),
  ];
  const tileHtml = tiles
    .map((t) => `<div class="card"><h3>${esc(t.title)}</h3>${t.html}</div>`)
    .join("");

  const groups = new Map<string, typeof vaultCfg.links>();
  for (const l of vaultCfg.links) {
    const g = l.group ?? "tools";
    groups.set(g, [...(groups.get(g) ?? []), l]);
  }
  const linkHtml = [...groups.entries()]
    .map(
      ([g, links]) =>
        `<div class="card"><h3>${esc(g)}</h3><ul class="plain">${links
          .map(
            (l) =>
              `<li><a href="${esc(l.url)}" rel="noreferrer">${esc(l.title)}</a>${l.note ? ` <span class="muted">— ${esc(l.note)}</span>` : ""}</li>`,
          )
          .join("")}</ul></div>`,
    )
    .join("");

  const svcHtml = await serviceCards(vaultCfg.services, cfg.issuer);
  const mcpHtml = await mcpSection(cfg);

  return page(
    "dashboard",
    `<h1>dashboard</h1>
     <p class="muted">signed in as ${esc(sub)}</p>
     <div class="grid">${tileHtml}</div>
     <h2>services</h2>
     <div class="grid">${svcHtml || `<p class="muted">no services configured — add a services: section to config/console.yaml in the vault</p>`}</div>
     <h2>mcp servers</h2>
     ${mcpHtml}
     <h2>links</h2>
     <div class="grid">${linkHtml || `<p class="muted">no links configured — add config/console.yaml to the vault</p>`}</div>`,
    { authed: true, wide: true },
  );
}
