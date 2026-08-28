/**
 * Gateway call analytics (W1.7): a mini-Datadog section on the dashboard —
 * stat tiles, hourly outcome bars, top tools, latency percentiles, and the
 * latest calls, all over the trailing 7 days. The source is the same
 * hash-chained `_index/audit.jsonl` the gateway appends (§4.2): the console
 * parses lines and renders; it never verifies the chain (that's the
 * gateway's proof machinery) and never writes. Reading the file directly
 * means the panel keeps working while the gateway itself is down — which
 * is exactly when you want it. 7 days is the VIEW window, not a retention
 * policy: the chain stays append-only so deletions remain provable.
 *
 * Charts are server-rendered inline SVG/HTML themed by the page's CSS
 * variables (the CSP admits no chart library). The ok/error/blocked trio
 * is CVD-validated against both surfaces (dataviz six-checks, 2026-08-28);
 * identity never rides color alone — legend labels, per-bucket titles, and
 * the latest-calls table carry it too.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { esc } from "./html.ts";

interface AuditEvent {
  type: string;
  principal: string;
  surface: string;
  urn: string;
  kind?: string;
  effect?: string;
  outcome?: string;
  ms?: number;
  argsDigest?: string;
}

interface Row {
  ts: number;
  e: AuditEvent;
}

const WINDOW_HOURS = 7 * 24;
const HOUR_MS = 3_600_000;

function parseWindow(path: string, now: number): Row[] {
  const rows: Row[] = [];
  const floor = now - WINDOW_HOURS * HOUR_MS;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { ts?: string; event?: AuditEvent };
      const ts = Date.parse(parsed.ts ?? "");
      if (!parsed.event || Number.isNaN(ts) || ts < floor || ts > now) continue;
      rows.push({ ts, e: parsed.event });
    } catch {
      // A torn or foreign line degrades to "not shown", never to a broken page.
    }
  }
  // Append order is *usually* chronological; sort so it's guaranteed.
  return rows.sort((a, b) => a.ts - b.ts);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(Math.ceil((p / 100) * sorted.length), sorted.length) - 1] as number;
}

function rel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** ok / error / blocked per bucket — blocked = policy denials + rate limit. */
type Bucket = { ok: number; err: number; blk: number };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourlyBars(buckets: Bucket[], start: number): { svg: string; max: number } {
  const pitch = 5;
  const barW = 3;
  const plotH = 60;
  const base = 66;
  const width = buckets.length * pitch + 4;
  const max = Math.max(1, ...buckets.map((b) => b.ok + b.err + b.blk));
  const parts: string[] = [];
  for (const [i, b] of buckets.entries()) {
    const t = start + i * HOUR_MS;
    const x = 2 + i * pitch;
    if (new Date(t).getUTCHours() === 0) {
      const d = new Date(t);
      parts.push(
        `<line x1="${x - 1}" y1="4" x2="${x - 1}" y2="${base}" stroke="var(--line)" stroke-width="1"/>`,
        `<text x="${x + 2}" y="${base + 12}" fill="var(--muted)" font-size="9">${DAYS[d.getUTCDay()]} ${d.getUTCDate()}</text>`,
      );
    }
    const total = b.ok + b.err + b.blk;
    if (total === 0) continue;
    const label = `${new Date(t).toISOString().slice(0, 13)}:00Z — ${b.ok} ok · ${b.err} error · ${b.blk} blocked`;
    // 1px surface gaps between stacked segments; ≥1px per non-empty count.
    const segs: string[] = [];
    let y = base;
    for (const [n, color] of [
      [b.ok, "var(--a-ok)"],
      [b.err, "var(--a-err)"],
      [b.blk, "var(--a-blk)"],
    ] as const) {
      if (n === 0) continue;
      const h = Math.max(1, Math.round((n / max) * plotH));
      y -= h;
      segs.push(`<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}"/>`);
      y -= 1;
    }
    // The transparent hit rect makes the whole column hoverable, not just the bar.
    parts.push(
      `<g><title>${esc(label)}</title><rect x="${x - 1}" y="0" width="${pitch}" height="${base}" fill="transparent"/>${segs.join("")}</g>`,
    );
  }
  return {
    svg: `<div class="scroll"><svg viewBox="0 0 ${width} 82" style="width:100%;min-width:44rem;height:auto;display:block" role="img" aria-label="gateway calls per hour, last 7 days">${parts.join("")}</svg></div>`,
    max,
  };
}

export function auditSection(vaultPath: string, now = new Date()): string {
  const path = join(vaultPath, "_index", "audit.jsonl");
  if (!existsSync(path))
    return `<div class="card"><p class="muted">no audit log yet at <code>_index/audit.jsonl</code> — the gateway writes it on its first call.</p></div>`;

  const nowMs = now.getTime();
  const rows = parseWindow(path, nowMs);

  // Bucket outcomes by hour. "Executed" = the upstream actually ran.
  const start = nowMs - WINDOW_HOURS * HOUR_MS;
  const buckets: Bucket[] = Array.from({ length: WINDOW_HOURS }, () => ({
    ok: 0,
    err: 0,
    blk: 0,
  }));
  const perTool = new Map<string, { calls: number; errs: number; ms: number[] }>();
  const kinds = new Map<string, string>(); // urn|digest → kind, from decision lines
  const durations: number[] = [];
  let ok = 0;
  let err = 0;
  let denied = 0;
  let limited = 0;

  for (const { ts, e } of rows) {
    const b = buckets[Math.min(Math.floor((ts - start) / HOUR_MS), WINDOW_HOURS - 1)] as Bucket;
    if (e.type === "decision" && e.kind) kinds.set(`${e.urn}|${e.argsDigest ?? ""}`, e.kind);
    const tool = () => {
      const t = perTool.get(e.urn) ?? { calls: 0, errs: 0, ms: [] };
      perTool.set(e.urn, t);
      return t;
    };
    if (e.type === "call") {
      ok++;
      b.ok++;
      const t = tool();
      t.calls++;
      if (typeof e.ms === "number") {
        t.ms.push(e.ms);
        durations.push(e.ms);
      }
    } else if (e.type === "error") {
      err++;
      b.err++;
      const t = tool();
      t.calls++;
      t.errs++;
      if (typeof e.ms === "number") {
        t.ms.push(e.ms);
        durations.push(e.ms);
      }
    } else if (e.type === "decision" && e.effect === "deny") {
      denied++;
      b.blk++;
      tool().calls++;
    } else if (e.type === "rate_limited") {
      limited++;
      b.blk++;
    }
  }

  const executed = ok + err;
  if (executed + denied + limited === 0)
    return `<div class="card"><p class="muted">no gateway calls in the last 7 days.</p></div>`;

  durations.sort((a, b) => a - b);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const errPct = executed ? Math.round((err / executed) * 100) : 0;

  const stats = `<div class="stats">
    <div class="card stat"><div class="n">${executed}</div><div class="l">calls executed · 7d</div></div>
    <div class="card stat"><div class="n${err ? " bad" : ""}">${err}</div><div class="l">errors · ${errPct}% of executed</div></div>
    <div class="card stat"><div class="n${denied + limited ? " warn" : ""}">${denied + limited}</div><div class="l">blocked · ${denied} denied, ${limited} rate-limited</div></div>
    <div class="card stat"><div class="n">${p50 ?? "–"} / ${p95 ?? "–"}</div><div class="l">latency ms · p50 / p95</div></div>
  </div>`;

  const bars = hourlyBars(buckets, start);
  const legend = `<div class="legend">
    <span><i style="background:var(--a-ok)"></i>ok</span>
    <span><i style="background:var(--a-err)"></i>error</span>
    <span><i style="background:var(--a-blk)"></i>blocked (denied / rate-limited)</span>
    <span style="margin-left:auto">max ${bars.max}/h</span>
  </div>`;

  const top = [...perTool.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 8);
  const maxCalls = Math.max(1, ...top.map(([, t]) => t.calls));
  const toolRows = top
    .map(([urn, t]) => {
      t.ms.sort((a, b) => a - b);
      return `<tr><td><code>${esc(urn)}</code></td>
        <td><div class="tbar"><i style="width:${Math.round((t.calls / maxCalls) * 100)}%"></i></div></td>
        <td class="num">${t.calls}</td>
        <td class="num${t.errs ? " bad" : ""}">${t.errs}</td>
        <td class="num">${percentile(t.ms, 50) ?? "–"}</td>
        <td class="num">${percentile(t.ms, 95) ?? "–"}</td></tr>`;
    })
    .join("");

  const OUTCOME: Record<string, (e: AuditEvent) => string> = {
    call: () => `<span class="ok">ok</span>`,
    error: (e) => `<span class="bad" title="${esc((e.outcome ?? "").slice(0, 160))}">error</span>`,
    decision: () => `<span class="bad">denied</span>`,
    rate_limited: () => `<span class="warn">rate-limited</span>`,
    confirm_issued: () => `<span class="muted">confirm?</span>`,
    confirm_spent: () => `<span class="muted">confirmed</span>`,
  };
  const latest = rows
    .filter(({ e }) => e.type !== "decision" || e.effect === "deny")
    .slice(-20)
    .reverse()
    .map(({ ts, e }) => {
      const kind = e.kind ?? kinds.get(`${e.urn}|${e.argsDigest ?? ""}`);
      return `<tr><td class="muted" title="${new Date(ts).toISOString()}">${rel(ts, nowMs)}</td>
        <td><code>${esc(e.urn)}</code></td>
        <td class="muted">${esc(kind ?? "")}</td>
        <td>${(OUTCOME[e.type] ?? (() => esc(e.type)))(e)}</td>
        <td class="num">${typeof e.ms === "number" ? e.ms : ""}</td>
        <td class="muted" title="${esc(e.principal)}">${esc(e.surface)}</td></tr>`;
    })
    .join("");

  return `<style>
    #audit { --a-ok:#2a78d6; --a-err:#b3402e; --a-blk:#1baf7a; }
    @media (prefers-color-scheme: dark) { #audit { --a-ok:#3987e5; --a-err:#e66767; --a-blk:#199e70; } }
    #audit .stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(11rem,1fr)); gap:.7rem; }
    #audit .stat .n { font-size:1.7rem; font-weight:700; line-height:1.2; }
    #audit .stat .l { color:var(--muted); font-size:.78rem; }
    #audit .legend { display:flex; gap:1.1rem; font-size:.78rem; color:var(--muted); margin:.7rem 0 .1rem; }
    #audit .legend i { display:inline-block; width:.62rem; height:.62rem; border-radius:2px; margin-right:.35rem; }
    #audit .tbar { background:var(--line); border-radius:3px; height:.55rem; min-width:5rem; overflow:hidden; }
    #audit .tbar i { display:block; height:100%; background:var(--accent); border-radius:3px; }
    #audit td.num, #audit th.num { text-align:right; font-variant-numeric:tabular-nums; }
    #audit .half { display:grid; grid-template-columns:repeat(auto-fit,minmax(24rem,1fr)); gap:.7rem; }
  </style>
  <div id="audit">
    ${stats}
    <div class="card">${legend}${bars.svg}</div>
    <div class="half">
      <div class="card"><h3>top tools</h3><div class="scroll"><table class="slim">
        <tr><th>tool</th><th></th><th class="num">calls</th><th class="num">errors</th><th class="num">p50 ms</th><th class="num">p95 ms</th></tr>
        ${toolRows}</table></div></div>
      <div class="card"><h3>latest calls</h3><div class="scroll"><table class="slim">
        <tr><th>when</th><th>tool</th><th>kind</th><th>result</th><th class="num">ms</th><th>surface</th></tr>
        ${latest}</table></div></div>
    </div>
  </div>`;
}
