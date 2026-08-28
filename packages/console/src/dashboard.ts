/**
 * The ops hub (W1.4): links + live status for everything behind the brain.
 * Every tile degrades gracefully — an unreachable source renders as a
 * warning, never a broken page. Tile data is cached briefly so a dashboard
 * refresh never hammers upstream APIs.
 */

import type { Database } from "bun:sqlite";
import type { BrainStore } from "@brain/brainstore";
import type { ConsoleConfig, ExpiryItem, VaultConsoleConfig } from "./config.ts";
import { esc, page } from "./html.ts";

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
  let worst: "ok" | "warn" | "bad" = "ok";
  const rows = expiries
    .slice()
    .sort((a, b) => a.expires.localeCompare(b.expires))
    .map((e) => {
      const days = Math.floor((Date.parse(e.expires) - now.getTime()) / 86_400_000);
      const cls = days < 7 ? "bad" : days < 21 ? "warn" : "ok";
      if (cls === "bad" || (cls === "warn" && worst === "ok")) worst = cls;
      return `<li><span class="${cls}">${days < 0 ? "EXPIRED" : `${days}d`}</span>
        ${esc(e.name)} <span class="muted">${esc(e.expires)}${e.note ? ` — ${esc(e.note)}` : ""}</span></li>`;
    })
    .join("");
  return { title: "credential expiries", html: `<ul class="plain">${rows}</ul>`, cls: worst };
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

  return page(
    "dashboard",
    `<h1>dashboard</h1>
     <p class="muted">signed in as ${esc(sub)}</p>
     <div class="grid">${tileHtml}</div>
     <h2>links</h2>
     <div class="grid">${linkHtml || `<p class="muted">no links configured — add config/console.yaml to the vault</p>`}</div>`,
    { authed: true },
  );
}
