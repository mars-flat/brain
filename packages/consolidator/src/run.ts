/**
 * The single-writer consolidation run (§5.7):
 *
 *   lease → (skip if already consolidated) → extract → resolve → RESERVE →
 *   plan → validate in memory → write → git commit → mark done → reindex → ack
 *
 * Crash-safety comes from ordering: everything destructive happens after
 * validation, the ledger row lands with the same run that wrote the files,
 * and an interrupted run just re-leases — resolution then finds the
 * already-written nodes and the plan degenerates to a no-op (idempotency).
 * Reservation conflicts nack with backoff: by the retry, the winner has
 * committed and this episode's candidates resolve to existing nodes.
 * The advisory run lock makes "single writer" structural even if two
 * processes race (§5.7 property 1).
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrainStore, loadVault, parseNote, rebuild, renderNote } from "@brain/brainstore";
import type { EpisodeEnvelope, NodeFrontmatter } from "@brain/contracts";
import { validateEpisode } from "@brain/contracts";
import {
  type EdgeAddition,
  type ExistingNodeRef,
  planMerge,
  type Resolution,
  resolveCandidate,
} from "@brain/core";
import { SqliteQueue } from "@brain/queue-sqlite";
import { ExtractionPending, type Extractor } from "./extract.ts";
import { writeQuarantinedCandidate } from "./quarantine.ts";
import {
  acquireRunLock,
  alreadyConsolidated,
  ensureConsolidatorTables,
  markConsolidated,
  ReservationConflict,
  releaseReservations,
  reserveIds,
} from "./tables.ts";

export interface QueuedEpisode {
  episodeId: string;
  basename: string;
}

export interface ConsolidatorOptions {
  vaultPath: string;
  db: Database;
  extractor: Extractor;
  clock?: () => Date;
  /** git commit per run (§5.7 property 4). Disable only in tests. */
  gitCommit?: boolean;
  maxAttempts?: number;
  batchSize?: number;
}

export interface ProcessedEpisode {
  episodeId: string;
  basename: string;
  newNodes: string[];
  edgeAdditions: number;
  statusChanges: number;
  quarantined: number;
  warnings: string[];
}

export interface RunReport {
  locked: boolean;
  processed: ProcessedEpisode[];
  skipped: string[];
  /** Batch extraction in flight (§5.8) — re-queued fresh, not a failure. */
  waiting: string[];
  retried: Array<{ episodeId: string; reason: string }>;
  deadLettered: Array<{ episodeId: string; reason: string }>;
}

export async function runConsolidator(opts: ConsolidatorOptions): Promise<RunReport> {
  const clock = opts.clock ?? (() => new Date());
  const maxAttempts = opts.maxAttempts ?? 3;
  const report: RunReport = {
    locked: false,
    processed: [],
    skipped: [],
    waiting: [],
    retried: [],
    deadLettered: [],
  };

  ensureConsolidatorTables(opts.db);
  const release = acquireRunLock(opts.db, crypto.randomUUID(), 10 * 60_000);
  if (!release) {
    report.locked = true;
    return report;
  }

  try {
    const queue = new SqliteQueue<QueuedEpisode>(opts.db, () => clock().getTime());
    const leased = await queue.lease(opts.batchSize ?? 10, 5 * 60_000);

    for (const lease of leased) {
      const { episodeId, basename } = lease.item;
      if (alreadyConsolidated(opts.db, episodeId)) {
        report.skipped.push(episodeId);
        await queue.ack(lease.leaseId);
        continue;
      }
      try {
        const outcome = await consolidateOne(opts, clock, episodeId, basename);
        report.processed.push(outcome);
        await queue.ack(lease.leaseId);
      } catch (err) {
        if (err instanceof ExtractionPending) {
          // Not a failure: ack the lease and re-enqueue fresh so the attempt
          // counter never dead-letters an episode whose batch is merely slow.
          report.waiting.push(episodeId);
          await queue.ack(lease.leaseId);
          await queue.enqueue({ episodeId, basename });
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        releaseReservations(opts.db, episodeId);
        if (lease.attempt >= maxAttempts) {
          deadLetter(opts.vaultPath, basename, episodeId, reason, clock());
          markConsolidated(opts.db, episodeId, basename, clock().toISOString(), 0, 0);
          report.deadLettered.push({ episodeId, reason });
          await queue.ack(lease.leaseId);
        } else {
          const backoffMs = err instanceof ReservationConflict ? 50 : 1000 * 2 ** lease.attempt;
          report.retried.push({ episodeId, reason });
          await queue.nack(lease.leaseId, backoffMs);
        }
      }
    }
  } finally {
    release();
  }
  return report;
}

async function consolidateOne(
  opts: ConsolidatorOptions,
  clock: () => Date,
  episodeId: string,
  basename: string,
): Promise<ProcessedEpisode> {
  const { vaultPath, db } = opts;
  const now = clock();
  const today = now.toISOString().slice(0, 10);

  // Fresh index so resolution sees the latest committed state.
  const vault = loadVault(vaultPath);
  rebuild(db, vault);
  const store = new BrainStore(db);

  const episode = loadEnvelope(vaultPath, basename);
  if (episode.episode_id !== episodeId)
    throw new Error(
      `envelope ${basename}.json carries ${episode.episode_id}, queue says ${episodeId}`,
    );

  const graph = store.loadGraph();
  const existingIds = new Set(graph.nodes.keys());
  const episodeBasenames = new Set(vault.episodes.map((e) => e.basename));

  // ── extract ───────────────────────────────────────────────────────────
  const candidates = await opts.extractor.extract(episode, {
    nodeCount: existingIds.size,
    existingIds: [...existingIds].sort().slice(0, 400),
  });

  // ── resolve (§5.7: exact → FTS5 → trigram) ────────────────────────────
  const refs = store.nodeRefs();
  const refById = new Map(refs.map((r) => [r.id, r]));
  const aliasIndex = new Map<string, string[]>();
  for (const r of refs) {
    for (const a of r.aliases) {
      const key = a.toLowerCase();
      aliasIndex.set(key, [...(aliasIndex.get(key) ?? []), r.id].sort());
    }
  }
  // Foreign in-flight reservations are deliberately NOT in this set: a
  // colliding hint must hit the reservation conflict and retry (§5.7) —
  // suffixing around an unwritten node would mint the very duplicate the
  // reservation exists to prevent. Post-commit retries resolve against the
  // real node instead.
  const taken = new Set<string>([...existingIds, ...episodeBasenames]);
  const resolutions: Resolution[] = [];
  for (const cand of candidates) {
    const fts = store
      .seedSearch([cand.title, ...cand.aliases].join(" "), 5, [cand.type])
      .map((h) => refById.get(h.id))
      .filter((r): r is ExistingNodeRef => r !== undefined);
    const r = resolveCandidate(
      { idHint: cand.id_hint, title: cand.title, aliases: cand.aliases, type: cand.type },
      refById,
      aliasIndex,
      fts,
      taken,
    );
    if (r.kind === "new") taken.add(r.id);
    resolutions.push(r);
  }

  // ── reserve (§5.7: ATOMIC — conflict throws, caller nacks) ────────────
  const newIds = resolutions.flatMap((r) => (r.kind === "new" ? [r.id] : []));
  reserveIds(db, newIds, episodeId, now.toISOString());

  // ── plan ──────────────────────────────────────────────────────────────
  const plan = planMerge(candidates, resolutions, {
    today,
    episodeBasename: basename,
    trust: episode.trust,
    pinnedIds: new Set(graph.pins.map((p) => p.nodeId)),
    existingIds,
    aliasToId: new Map(
      [...aliasIndex]
        .filter(([, ids]) => ids.length === 1)
        .map(([a, ids]) => [a, ids[0] as string]),
    ),
    existingEdgeKeys: new Set(graph.edges.map((e) => `${e.from} ${e.rel} ${e.to}`)),
  });

  // ── validate every planned write in memory BEFORE touching disk ───────
  const fileWrites = new Map<string, string>();
  for (const n of plan.newNodes) {
    const rendered = renderNote(n.fm, n.body);
    const back = parseNote(rendered);
    if (!back.ok)
      throw new Error(`planned node ${n.fm.id} fails validation: ${back.errors.join("; ")}`);
    fileWrites.set(join(vaultPath, "nodes", n.fm.type, `${n.fm.id}.md`), rendered);
  }
  const edits = groupEdits(plan.edgeAdditions, plan.statusChanges);
  for (const [nodeId, edit] of edits) {
    const row = store.nodeFile(nodeId);
    if (!row) {
      plan.warnings.push(`edit target ${nodeId} vanished — skipped`);
      continue;
    }
    const absolute = join(vaultPath, row);
    const parsed = parseNote(readFileSync(absolute, "utf8"));
    if (!parsed.ok) throw new Error(`cannot edit ${nodeId}: ${parsed.errors.join("; ")}`);
    const fm = applyEdit(parsed.value.frontmatter, edit, today);
    const rendered = renderNote(fm, parsed.value.body);
    const back = parseNote(rendered);
    if (!back.ok)
      throw new Error(`edited node ${nodeId} fails validation: ${back.errors.join("; ")}`);
    fileWrites.set(absolute, rendered);
  }

  // ── write ─────────────────────────────────────────────────────────────
  for (const [path, content] of fileWrites) {
    const dir = join(path, "..");
    if (!existsSync(dir)) Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(path, content);
  }
  let quarantined = 0;
  for (const q of plan.quarantined) {
    writeQuarantinedCandidate(vaultPath, q, basename, today, episode.trust);
    quarantined++;
  }
  appendLog(
    vaultPath,
    `- ${now.toISOString()} ${basename} (${episodeId}): +${plan.newNodes.length} nodes, ` +
      `+${plan.edgeAdditions.length} edges, ${plan.statusChanges.length} superseded, ${quarantined} quarantined`,
  );

  // ── commit + ledger + reindex (§5.7 property 4) ───────────────────────
  if (opts.gitCommit ?? true) {
    gitCommitVault(
      vaultPath,
      `consolidate ${basename}: +${plan.newNodes.length} nodes, +${plan.edgeAdditions.length} edges, ${quarantined} quarantined`,
    );
  }
  markConsolidated(db, episodeId, basename, now.toISOString(), plan.newNodes.length, quarantined);
  releaseReservations(db, episodeId);
  rebuild(db, loadVault(vaultPath));

  return {
    episodeId,
    basename,
    newNodes: plan.newNodes.map((n) => n.fm.id),
    edgeAdditions: plan.edgeAdditions.length,
    statusChanges: plan.statusChanges.length,
    quarantined,
    warnings: plan.warnings,
  };
}

function loadEnvelope(vaultPath: string, basename: string): EpisodeEnvelope {
  const [y, m] = [basename.slice(0, 4), basename.slice(5, 7)];
  const path = join(vaultPath, "episodes", y, m, `${basename}.json`);
  const verdict = validateEpisode(JSON.parse(readFileSync(path, "utf8")));
  if (!verdict.ok) throw new Error(`stored envelope ${path} invalid: ${verdict.errors.join("; ")}`);
  return verdict.value;
}

interface NodeEdit {
  additions: EdgeAddition[];
  supersede: boolean;
}

function groupEdits(
  additions: EdgeAddition[],
  statusChanges: Array<{ nodeId: string; to: "superseded" }>,
): Map<string, NodeEdit> {
  const out = new Map<string, NodeEdit>();
  const get = (id: string): NodeEdit => {
    const existing = out.get(id) ?? { additions: [], supersede: false };
    out.set(id, existing);
    return existing;
  };
  for (const a of additions) get(a.nodeId).additions.push(a);
  for (const s of statusChanges) get(s.nodeId).supersede = true;
  return out;
}

function applyEdit(fm: NodeFrontmatter, edit: NodeEdit, today: string): NodeFrontmatter {
  const next: NodeFrontmatter = { ...fm, updated: today };
  for (const a of edit.additions) {
    const link = `[[${a.target}]]`;
    if (a.rel === "sources") {
      const sources = next.sources ?? [];
      if (!sources.includes(link)) next.sources = [...sources, link];
    } else {
      const list = next[a.rel] ?? [];
      if (!list.includes(link)) next[a.rel] = [...list, link];
    }
  }
  if (edit.supersede) next.status = "superseded";
  return next;
}

function appendLog(vaultPath: string, line: string): void {
  const path = join(vaultPath, "log.md");
  const prefix = existsSync(path) ? readFileSync(path, "utf8") : "# Consolidation log\n\n";
  writeFileSync(path, `${prefix}${line}\n`);
}

function deadLetter(
  vaultPath: string,
  basename: string,
  episodeId: string,
  reason: string,
  now: Date,
): void {
  const dir = join(vaultPath, "quarantine");
  Bun.spawnSync(["mkdir", "-p", dir]);
  writeFileSync(
    join(dir, `failed-${basename}.md`),
    `# Failed consolidation: ${basename}\n\n- episode: ${episodeId}\n- at: ${now.toISOString()}\n- reason: ${reason}\n\nThe episode file is untouched under episodes/; fix the cause and re-enqueue with \`brain ingest\`.\n`,
  );
}

export function gitCommitVault(vaultPath: string, message: string): void {
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: vaultPath });
  if (status.stdout.toString().trim() === "") return;
  Bun.spawnSync(["git", "add", "-A"], { cwd: vaultPath });
  const commit = Bun.spawnSync(["git", "commit", "-q", "-m", message], { cwd: vaultPath });
  if (commit.exitCode !== 0)
    throw new Error(`vault git commit failed: ${commit.stderr.toString().trim()}`);
}
