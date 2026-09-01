/**
 * Per-vault degree statistics (§5.5): hubs are defined by THIS graph's shape,
 * not by a constant that rots as the vault grows. Pure arithmetic over the
 * slice — recomputed per recall, cheap at 10^4 edges, and deterministic, so
 * nothing new enters the stored-state surface.
 */

import type { GraphSlice } from "./types.ts";

export interface DegreeStats {
  /** Undirected degree among existing nodes — traversal is bidirectional (§5.3). */
  degree: Map<string, number>;
  /** Median degree over connected nodes; 1 when the graph has no edges. */
  medianDegree: number;
  /** A node this connected is a hub: max(4, p95 of all degrees). */
  hubThreshold: number;
  hubs: Set<string>;
}

export function degreeStats(graph: GraphSlice): DegreeStats {
  const degree = new Map<string, number>();
  for (const id of graph.nodes.keys()) degree.set(id, 0);
  for (const e of graph.edges) {
    if (!graph.nodes.has(e.from) || !graph.nodes.has(e.to)) continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  const all = [...degree.values()].sort((a, b) => a - b);
  const connected = all.filter((d) => d > 0);
  const medianDegree = connected.length
    ? (connected[Math.floor((connected.length - 1) / 2)] as number)
    : 1;
  const p95 = all.length ? (all[Math.max(0, Math.ceil(all.length * 0.95) - 1)] as number) : 0;
  // The floor keeps tiny graphs hub-free: in a 10-node vault everything is
  // "top 5%" of something, and damping the whole graph is damping nothing.
  const hubThreshold = Math.max(4, p95);

  const hubs = new Set<string>();
  for (const [id, d] of degree) if (d >= hubThreshold) hubs.add(id);
  return { degree, medianDegree: Math.max(1, medianDegree), hubThreshold, hubs };
}
