/**
 * The live vault, read-only (W1.3): everything renders straight from the
 * same files and index the consolidator writes — no rebuild step, no
 * publish step. This module NEVER writes; the single-writer stays the
 * single writer (§5.7).
 */

import type { BrainStore } from "@brain/brainstore";
import { esc, page, renderMarkdown } from "./html.ts";

const TYPE_ORDER = [
  "project",
  "decision",
  "constraint",
  "preference",
  "person",
  "entity",
  "concept",
  "artifact",
  "event",
];

export function indexPage(store: BrainStore): string {
  const counts = store.counts();
  const graph = store.loadGraph();
  const byType = new Map<string, Array<{ id: string; title: string }>>();
  for (const n of graph.nodes.values()) {
    const list = byType.get(n.type) ?? [];
    list.push({ id: n.id, title: n.title });
    byType.set(n.type, list);
  }
  const sections = TYPE_ORDER.filter((t) => byType.has(t))
    .map((t) => {
      const nodes = (byType.get(t) ?? []).sort((a, b) => a.title.localeCompare(b.title));
      const items = nodes
        .map((n) => `<li><a href="/node/${esc(n.id)}">${esc(n.title)}</a></li>`)
        .join("");
      return `<div class="card"><h3>${esc(t)} <span class="muted">${nodes.length}</span></h3><ul class="plain">${items}</ul></div>`;
    })
    .join("");
  return page(
    "brain",
    `<h1>the brain</h1>
     <p class="muted">${counts.nodes} nodes · ${counts.edges} edges · ${counts.episodes} episodes · ${counts.pins} pins — live from the vault</p>
     <div class="grid">${sections}</div>`,
    { authed: true },
  );
}

export function nodePage(store: BrainStore, id: string): string | null {
  const graph = store.loadGraph();
  const node = graph.nodes.get(id);
  if (!node) return null;
  const body = store.getBodies([id]).get(id) ?? "";
  const pins = graph.pins.filter((p) => p.nodeId === id);
  const edges = store.edgesTouching(id);
  const outbound = edges.filter((e) => e.from === id);
  const inbound = edges.filter((e) => e.to === id);
  const sources = store.nodeSources(id);

  const edgeList = (list: typeof edges, dir: "out" | "in") =>
    list
      .map((e) => {
        const other = dir === "out" ? e.to : e.from;
        const arrow = dir === "out" ? `${esc(e.rel)} →` : `← ${esc(e.rel)}`;
        return `<li><span class="muted">${arrow}</span> <a href="/node/${esc(other)}">${esc(other)}</a></li>`;
      })
      .join("");

  const pinHtml = pins
    .map(
      (p) =>
        `<div class="card"><strong>📌 pinned:</strong> ${esc((p as { correction?: string }).correction ?? "")}</div>`,
    )
    .join("");

  return page(
    node.title,
    `<p><span class="chip type">${esc(node.type)}</span>
        <span class="chip">${esc(node.status)}</span>
        <span class="chip">confidence: ${esc(node.confidence)}</span>
        <span class="chip">updated ${esc(node.updated)}</span></p>
     <h1>${esc(node.title)}</h1>
     ${pinHtml}
     <div class="card">${renderMarkdown(node.summary)}</div>
     ${body.trim() ? `<article>${renderMarkdown(body)}</article>` : ""}
     ${outbound.length ? `<h3>edges out</h3><ul class="plain">${edgeList(outbound, "out")}</ul>` : ""}
     ${inbound.length ? `<h3>edges in</h3><ul class="plain">${edgeList(inbound, "in")}</ul>` : ""}
     ${
       sources.length
         ? `<h3>provenance</h3><ul class="plain">${sources
             .map((s) => `<li class="muted">episode ${esc(s)}</li>`)
             .join("")}</ul>`
         : ""
}`,
    { authed: true },
  );
}

export function searchPage(store: BrainStore, query: string): string {
  const graph = store.loadGraph();
  const hits = query.trim() ? store.seedSearch(query, 25) : [];
  const items = hits
    .map((h) => {
      const n = graph.nodes.get(h.id);
      if (!n) return "";
      return `<div class="card"><a href="/node/${esc(n.id)}"><strong>${esc(n.title)}</strong></a>
        <span class="chip type">${esc(n.type)}</span>
        <p class="muted">${esc(n.summary.slice(0, 220))}${n.summary.length > 220 ? "…" : ""}</p></div>`;
    })
    .join("");
  return page(
    `search: ${query}`,
    `<h1>search</h1>
     <form action="/search" method="get"><input type="search" name="q" value="${esc(query)}" autofocus></form>
     ${items || `<p class="muted">${query.trim() ? "no matches." : "type something."}</p>`}`,
    { authed: true },
  );
}

export function episodesPage(store: BrainStore): string {
  const episodes = store.episodes({}).slice().reverse();
  const items = episodes
    .map(
      (e) =>
        `<div class="card"><strong>${esc(e.episode_id)}</strong>
         <span class="chip">${esc(e.surface)}</span><span class="chip">${esc(e.harness)}</span>
         <span class="muted">${esc(e.started_at)}</span>
         ${e.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</div>`,
    )
    .join("");
  return page(
    "episodes",
    `<h1>episodes</h1><p class="muted">${episodes.length} total, newest first</p>${items}`,
    { authed: true },
  );
}
