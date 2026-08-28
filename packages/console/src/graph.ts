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
      #graphwrap { ${vars(0)} position:relative; }
      @media (prefers-color-scheme: dark) { #graphwrap { ${vars(1)} } }
      #graph { width:100%; height:min(78vh, 60rem); min-height:24rem; display:block;
        background:var(--card); border:1px solid var(--line); border-radius:10px; cursor:grab; touch-action:none; }
      #legend { display:flex; flex-wrap:wrap; gap:.4rem; margin:.6rem 0; }
      .chip-t { display:inline-flex; align-items:center; gap:.4rem; font:inherit; font-size:.8rem;
        color:var(--fg); background:var(--card); border:1px solid var(--line); border-radius:99px;
        padding:.15rem .7rem; cursor:pointer; }
      .chip-t.off { opacity:.35; text-decoration:line-through; }
      .chip-t .dot { width:.65rem; height:.65rem; border-radius:50%; display:inline-block; }
      #tip { position:absolute; pointer-events:none; background:var(--card); border:1px solid var(--line);
        border-radius:8px; padding:.4rem .6rem; font-size:.8rem; max-width:22rem; box-shadow:0 2px 10px rgba(0,0,0,.12); }
    </style>
    <div id="graphwrap">
      <h1>graph</h1>
      <p class="muted">${g.nodes.size} nodes · ${g.edges.length} edges — drag to pan, wheel to zoom, hover to focus a neighborhood, click a node to open it. Legend chips toggle types.</p>
      <div id="legend">${chips}</div>
      <canvas id="graph"></canvas>
      <div id="tip" hidden></div>
    </div>
    <script type="module" src="/graph.js"></script>`,
    { authed: true, wide: true },
  );
}
