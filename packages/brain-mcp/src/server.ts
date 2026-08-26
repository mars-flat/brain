/**
 * The brain MCP server (§5.10). Read tools serve from the derived index,
 * refreshed lazily when vault files change; write tools go through the
 * single-writer consolidator — brain.note NEVER writes the graph directly.
 *
 * Uses the SDK's low-level Server API with plain JSON Schemas so the
 * advertised tool surface stays byte-controlled (§4.4 budgets care).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, loadVault, openDb, rebuild } from "@brain/brainstore";
import {
  type Extractor,
  ensureConsolidatorTables,
  ingestEpisode,
  LlmExtractor,
  MarkerExtractor,
  type QueuedEpisode,
  runConsolidator,
  ulid,
  writePin,
} from "@brain/consolidator";
import type { EdgeRecord, EpisodeEnvelope, RenderTier } from "@brain/contracts";
import { EDGE_RELATIONS, NODE_TYPES } from "@brain/contracts";
import { recall } from "@brain/core";
import { OpenAiModelClient } from "@brain/model-openai";
import { SqliteQueue } from "@brain/queue-sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.1.0";

export interface BrainMcpOptions {
  vaultPath: string;
  clock?: () => Date;
  /** Override extraction (tests MUST inject MarkerExtractor — never the paid API). */
  extractor?: Extractor;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "recall",
    description:
      "Graph memory retrieval: BM25 seeds + weighted traversal packed under a token budget. Returns a context pack; low-ranked nodes appear as stubs you can expand.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        budget_tokens: { type: "integer", minimum: 200, default: 4000 },
        hops: { type: "integer", minimum: 1, maximum: 5, default: 3 },
        types: { type: "array", items: { enum: [...NODE_TYPES] } },
        seeds: { type: "array", items: { type: "string" }, description: "node ids" },
        as_of: { type: "string", description: "YYYY-MM-DD time travel" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "expand",
    description: "Promote nodes from stub/summary to fuller renders by id.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1 },
        tier: { enum: ["full", "summary", "stub"], default: "full" },
      },
      required: ["ids"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "neighbors",
    description: "Subgraph edge list around a node.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        rels: { type: "array", items: { enum: [...EDGE_RELATIONS] } },
        depth: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "note",
    description:
      "Capture a memory. Enqueues for the single-writer consolidator (never writes the graph directly) and runs it. Free text, or precise @node marker lines.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        links: { type: "array", items: { type: "string" }, description: "related node ids" },
        type: { enum: [...NODE_TYPES] },
      },
      required: ["text"],
    },
  },
  {
    name: "pin",
    description: "Pin a correction to a node. Pins survive all future generation.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        correction: { type: "string" },
        reason: { type: "string" },
      },
      required: ["node_id", "correction", "reason"],
    },
  },
  {
    name: "timeline",
    description: "Episodes, chronological. Optional label/basename filter and date bounds.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "trace",
    description: "Provenance chain: the episodes a node was derived from.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" } },
      required: ["node_id"],
    },
    annotations: { readOnlyHint: true },
  },
];

export function buildBrainServer(opts: BrainMcpOptions): Server {
  const clock = opts.clock ?? (() => new Date());
  const db = openDb(join(opts.vaultPath, "_index", "brain.db"));
  ensureConsolidatorTables(db);
  const store = new BrainStore(db);

  let lastRebuild = 0;
  const newestMtime = (): number => {
    let newest = 0;
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.startsWith(".")) continue;
        const full = join(dir, e);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else newest = Math.max(newest, st.mtimeMs);
      }
    };
    for (const d of ["nodes", "episodes", "pins"]) walk(join(opts.vaultPath, d));
    return newest;
  };
  const ensureFresh = () => {
    if (newestMtime() > lastRebuild) {
      rebuild(db, loadVault(opts.vaultPath));
      lastRebuild = clock().getTime();
    }
  };

  const extractor = (): Extractor => {
    if (opts.extractor) return opts.extractor;
    const key = process.env.OPENAI_API_KEY;
    return key ? new LlmExtractor(new OpenAiModelClient(key)) : new MarkerExtractor();
  };

  const server = new Server({ name: "brain", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const text = (payload: unknown, textOut?: string) => ({
      content: [{ type: "text" as const, text: textOut ?? JSON.stringify(payload, null, 2) }],
      structuredContent: payload as Record<string, unknown>,
    });

    switch (req.params.name) {
      case "recall": {
        ensureFresh();
        const out = recall(
          store,
          {
            query: String(args.query ?? ""),
            budget_tokens: args.budget_tokens as number | undefined,
            hops: args.hops as number | undefined,
            types: args.types as never,
            seeds: args.seeds as string[] | undefined,
            as_of: args.as_of as string | undefined,
          },
          clock(),
        );
        store.bumpSalience(out.fullTier, clock().toISOString());
        return text(out.result, out.result.pack || "(no matching memory)");
      }
      case "expand": {
        ensureFresh();
        const ids = (args.ids as string[]) ?? [];
        const tier = ((args.tier as RenderTier) ?? "full") satisfies RenderTier;
        const graph = store.loadGraph();
        const bodies = tier === "full" ? store.getBodies(ids) : new Map<string, string>();
        const renders: Array<{ id: string; tier: RenderTier; content: string }> = [];
        const missing: string[] = [];
        for (const id of ids) {
          const n = graph.nodes.get(id);
          if (!n) {
            missing.push(id);
            continue;
          }
          const head = `${n.type}/${n.id} — ${n.title}`;
          const content =
            tier === "stub"
              ? head
              : tier === "summary"
                ? `${head}\n${n.summary}`
                : `${head}\n${n.summary}\n\n${bodies.get(id) ?? ""}`.trimEnd();
          renders.push({ id, tier, content });
        }
        return text({ renders, missing });
      }
      case "neighbors": {
        ensureFresh();
        const id = String(args.id ?? "");
        const rels = args.rels as EdgeRecord["rel"][] | undefined;
        const depth = Math.min(Number(args.depth ?? 1), 3);
        const seen = new Set<string>([id]);
        let frontier = [id];
        const edges: EdgeRecord[] = [];
        const edgeKeys = new Set<string>();
        for (let d = 0; d < depth; d++) {
          const next: string[] = [];
          for (const cur of frontier) {
            for (const e of store.edgesTouching(cur)) {
              if (rels && !rels.includes(e.rel)) continue;
              const key = `${e.from} ${e.rel} ${e.to}`;
              if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push(e);
              }
              const other = e.from === cur ? e.to : e.from;
              if (!seen.has(other)) {
                seen.add(other);
                next.push(other);
              }
            }
          }
          frontier = next;
        }
        return text({ edges });
      }
      case "note": {
        const now = clock();
        const iso = now.toISOString().replace(/\.\d+Z$/, "Z");
        const noteText = String(args.text ?? "");
        const links = (args.links as string[] | undefined) ?? [];
        const episode: EpisodeEnvelope = {
          schema_version: 1,
          episode_id: `ep_${ulid(now)}`,
          principal: "owner",
          surface: "cli",
          harness: "brain-mcp",
          trust: "high",
          started_at: iso,
          ended_at: iso,
          turns: [
            {
              seq: 0,
              kind: "message",
              role: "user",
              content: links.length ? `${noteText}\n\n(related: ${links.join(", ")})` : noteText,
              ts: iso,
            },
          ],
          labels: ["note"],
        };
        const queue = new SqliteQueue<QueuedEpisode>(db, () => clock().getTime());
        const basenames = new Set(loadVault(opts.vaultPath).episodes.map((e) => e.basename));
        const ingest = await ingestEpisode(opts.vaultPath, queue, episode, basenames);
        const report = await runConsolidator({
          vaultPath: opts.vaultPath,
          db,
          extractor: extractor(),
          clock,
        });
        lastRebuild = clock().getTime();
        return text({
          pending_id: ingest.episodeId,
          processed: report.processed,
          retried: report.retried,
        });
      }
      case "pin": {
        const pin = writePin(
          opts.vaultPath,
          String(args.node_id ?? ""),
          String(args.correction ?? ""),
          String(args.reason ?? ""),
          clock(),
        );
        rebuild(db, loadVault(opts.vaultPath));
        lastRebuild = clock().getTime();
        return text({ pin_id: pin.pinId });
      }
      case "timeline": {
        ensureFresh();
        const q = args.query ? String(args.query).toLowerCase() : null;
        const episodes = store
          .episodes({ from: args.from as string | undefined, to: args.to as string | undefined })
          .filter(
            (e) =>
              !q ||
              e.episode_id.toLowerCase().includes(q) ||
              e.labels.some((l) => l.toLowerCase().includes(q)),
          );
        return text({ episodes });
      }
      case "trace": {
        ensureFresh();
        const nodeId = String(args.node_id ?? "");
        const sources = store.nodeSources(nodeId);
        const episodes = sources.length ? store.episodes({ basenames: sources }) : [];
        const edges = store.edgesTouching(nodeId).filter((e) => e.rel === "derived_from");
        return text({ node_id: nodeId, episodes, edges });
      }
      default:
        throw new Error(`unknown tool: ${req.params.name}`);
    }
  });

  return server;
}
