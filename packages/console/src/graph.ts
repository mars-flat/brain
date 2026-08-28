/**
 * The graph tab (§15.3): the vault's typed graph, force-laid-out in the
 * browser. Server side is just data + shell; the layout runs client-side
 * in graph-client.js (same-origin — the CSP stays closed to the world).
 *
 * Type colors are the validated categorical palette (dataviz skill,
 * checked against both console surfaces 2026-08-28), slots assigned to
 * types in FIXED frequency order at adoption — never re-ranked, so a
 * type keeps its hue as the vault grows. Types beyond the eight slots
 * (and any future type) wear neutral gray; identity is never color-alone
 * (hover tooltip, legend, and the index-by-type page as table view).
 */

import type { BrainStore } from "@brain/brainstore";
import { esc, page } from "./html.ts";

const SLOT: Record<string, [light: string, dark: string]> = {
  decision: ["#2a78d6", "#3987e5"],
  event: ["#eb6834", "#d95926"],
  constraint: ["#1baf7a", "#199e70"],
  project: ["#eda100", "#c98500"],
  artifact: ["#e87ba4", "#d55181"],
  entity: ["#008300", "#008300"],
  concept: ["#4a3aa7", "#9085e9"],
  preference: ["#e34948", "#e66767"],
};
const FOLD: [string, string] = ["#6f6a60", "#98928a"]; // person + future types

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 160) return flat;
  return `${flat.slice(0, 160).replace(/\s+\S*$/, "")}…`;
}

export function graphJson(store: BrainStore): string {
  const g = store.loadGraph();
  const degree = new Map<string, number>();
  const edges = g.edges.filter((e) => g.nodes.has(e.from) && g.nodes.has(e.to));
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return JSON.stringify({
    nodes: [...g.nodes.values()].map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      degree: degree.get(n.id) ?? 0,
      active: n.status === "active",
      // One-line snippet for the hover card; full text stays on the node page.
      summary: snippet(n.summary ?? ""),
    })),
    edges: edges.map((e) => ({ from: e.from, rel: e.rel, to: e.to })),
  });
}

export function graphPage(store: BrainStore): string {
  const g = store.loadGraph();
  const present = [...new Set([...g.nodes.values()].map((n) => n.type))].sort(
    (a, b) => (SLOT[b] ? 1 : 0) - (SLOT[a] ? 1 : 0) || a.localeCompare(b),
  );
  const vars = (i: 0 | 1) => present.map((t) => `--g-${t}:${(SLOT[t] ?? FOLD)[i]};`).join("");
  const chips = present
    .map(
      (t) =>
        `<button type="button" data-type="${esc(t)}" class="chip-t"><span class="dot" style="background:var(--g-${esc(t)})"></span>${esc(t)}</button>`,
    )
    .join("");

  return page(
    "graph",
    `<style>
      #graphwrap { ${vars(0)} --g-edge-out:#2a78d6; --g-edge-in:#eb6834; position:relative; }
      @media (prefers-color-scheme: dark) { #graphwrap { ${vars(1)} --g-edge-out:#3987e5; --g-edge-in:#d95926; } }
      #graph { width:100%; height:min(78vh, 60rem); min-height:24rem; display:block;
        background:var(--card); border:1px solid var(--line); border-radius:10px; cursor:grab; touch-action:none; }
      #legend { display:flex; flex-wrap:wrap; gap:.4rem; margin:.6rem 0; }
      .chip-t { display:inline-flex; align-items:center; gap:.4rem; font:inherit; font-size:.8rem;
        color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:99px;
        padding:.15rem .7rem; cursor:pointer; }
      .chip-t.off { opacity:.35; text-decoration:line-through; }
      .chip-t .dot { width:.65rem; height:.65rem; border-radius:50%; display:inline-block; }
      #tip { position:absolute; pointer-events:none; background:var(--card); border:1px solid var(--line);
        border-radius:10px; padding:.55rem .75rem; font-size:.8rem; max-width:20rem; line-height:1.45;
        box-shadow:0 4px 18px rgba(0,0,0,.16); opacity:0; transition:opacity .12s ease; }
      #tip.show { opacity:1; }
      #tip .dot { width:.6rem; height:.6rem; border-radius:50%; display:inline-block; margin-right:.4rem; }
      #tip .meta { color:var(--muted); font-size:.72rem; margin-top:.15rem; }
      #tip .sum { color:var(--muted); margin-top:.3rem; font-size:.75rem; }
      #stage { position:relative; }
      #gpanel { position:absolute; top:.6rem; right:.6rem; z-index:2; width:13.5rem;
        background:var(--card); border:1px solid var(--line); border-radius:10px;
        font-size:.78rem; box-shadow:0 2px 12px rgba(0,0,0,.10); }
      #gpanel summary { cursor:pointer; padding:.45rem .7rem; font-weight:600; color:var(--muted);
        list-style:none; user-select:none; }
      #gpanel summary::-webkit-details-marker { display:none; }
      #gpanel[open] summary { border-bottom:1px solid var(--line); }
      #gpanel .body { padding:.5rem .7rem .7rem; display:flex; flex-direction:column; gap:.45rem; }
      #gpanel .grp { font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; color:var(--accent);
        margin-top:.3rem; font-weight:600; }
      #gpanel label { display:flex; align-items:center; justify-content:space-between; gap:.5rem; color:var(--fg); }
      #gpanel input[type=range] { width:7rem; accent-color:var(--accent); }
      #gpanel input[type=checkbox] { accent-color:var(--accent); }
      #gpanel input[type=search] { width:100%; background:var(--bg); color:var(--fg);
        border:1px solid var(--line); border-radius:6px; padding:.3rem .5rem; font:inherit; }
    </style>
    <div id="graphwrap">
      <h1>graph</h1>
      <p class="muted">${g.nodes.size} nodes · ${g.edges.length} edges — drag to pan, wheel to zoom, hover to trace a node's edges
        (<span style="color:var(--g-edge-out)">outbound</span> / <span style="color:var(--g-edge-in)">inbound</span>), click a node to open it. Legend chips toggle types.</p>
      <div id="legend">${chips}</div>
      <div id="stage">
        <details id="gpanel" open>
          <summary>graph settings</summary>
          <div class="body">
            <input id="gs-search" type="search" placeholder="filter nodes…" autocomplete="off">
            <div class="grp">display</div>
            <label>arrows <input type="checkbox" id="gs-arrows"></label>
            <label>animate <input type="checkbox" id="gs-animate"></label>
            <label>node size <input type="range" id="gs-nodeSize" min="0.5" max="2" step="0.1"></label>
            <label>link width <input type="range" id="gs-linkWidth" min="0.5" max="3" step="0.1"></label>
            <label>labels <input type="range" id="gs-labels" min="0" max="2" step="0.1"></label>
            <div class="grp">forces</div>
            <label>repel <input type="range" id="gs-repel" min="0.3" max="2.5" step="0.1"></label>
            <label>link distance <input type="range" id="gs-linkDist" min="30" max="200" step="5"></label>
            <label>center pull <input type="range" id="gs-center" min="0" max="2.5" step="0.1"></label>
          </div>
        </details>
        <canvas id="graph"></canvas>
        <div id="tip" hidden><span class="dot"></span><strong></strong><div class="meta"></div><div class="sum"></div></div>
      </div>
    </div>
    <script type="module" src="/graph.js"></script>`,
    { authed: true, wide: true },
  );
}
