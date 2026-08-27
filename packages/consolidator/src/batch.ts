/**
 * Batched consolidation (P5, §12 Q4 / §5.8): extraction rides the Batch
 * API's flat 50% discount, and consolidation becomes a background cadence
 * instead of an inline call. One `runBatchCycle` per cadence tick:
 *
 *   collect  — poll open batches; store finished extractions
 *   drain    — runConsolidator with a stored-result extractor: episodes
 *              with results complete the normal §5.7 pipeline; the rest
 *              raise ExtractionPending (re-queued, no attempt burned) and
 *              are noted for submission
 *   submit   — one new batch for every noted episode without an open request
 *
 * The single-writer pipeline is untouched: batching swaps WHERE candidates
 * come from, never how they are resolved, reserved, or written. A batch
 * item that errors is resubmitted with its `fails` count bumped; at three
 * failed extractions the extractor raises a REAL error instead of pending,
 * which routes the episode through §5.7's normal retry → dead-letter path.
 * (Pending re-queues reset the queue's attempt counter, so the fail count
 * lives here — without it a permanently failing episode would resubmit,
 * and bill, forever.)
 */

import type { Database } from "bun:sqlite";
import type { BatchModelClient, EpisodeEnvelope } from "@brain/contracts";
import type { ExtractedCandidate } from "@brain/core";
import {
  buildExtractionRequest,
  type ExtractionContext,
  ExtractionPending,
  type Extractor,
  parseExtraction,
} from "./extract.ts";
import { type ConsolidatorOptions, type RunReport, runConsolidator } from "./run.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS extraction_batches (
  batch_id     TEXT PRIMARY KEY,
  submitted_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running'
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS extraction_requests (
  episode_id      TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  candidates_json TEXT,
  error           TEXT,
  fails           INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

/** Failed extractions per episode before the pending path gives up (§5.7). */
const MAX_EXTRACTION_FAILS = 3;

export function ensureBatchTables(db: Database): void {
  db.exec(SCHEMA);
}

/**
 * Serves stored batch extractions; records what it cannot serve so the
 * cycle can submit them. Episodes with an in-flight request stay pending.
 */
class StoredResultExtractor implements Extractor {
  readonly toSubmit = new Map<string, { episode: EpisodeEnvelope; ctx: ExtractionContext }>();

  constructor(private readonly db: Database) {}

  extract(episode: EpisodeEnvelope, ctx: ExtractionContext): Promise<ExtractedCandidate[]> {
    const row = this.db
      .query("SELECT candidates_json, error, fails FROM extraction_requests WHERE episode_id = ?")
      .get(episode.episode_id) as {
      candidates_json: string | null;
      error: string | null;
      fails: number;
    } | null;
    if (row?.candidates_json != null)
      return Promise.resolve(JSON.parse(row.candidates_json) as ExtractedCandidate[]);
    if (row?.error != null && row.fails >= MAX_EXTRACTION_FAILS)
      throw new Error(`batch extraction failed ${row.fails}×: ${row.error}`);
    // No row yet, or an errored one still under the fail cap → (re)submit.
    if (!row || row.error != null) this.toSubmit.set(episode.episode_id, { episode, ctx });
    throw new ExtractionPending(episode.episode_id);
  }
}

export interface BatchCycleOptions extends Omit<ConsolidatorOptions, "extractor"> {
  model: BatchModelClient;
  modelName?: string;
}

export interface BatchCycleReport {
  /** Batches that finished this cycle (results stored or requests cleared). */
  collected: Array<{ batchId: string; ok: number; failed: number }>;
  /** The consolidation pass over stored results. */
  run: RunReport;
  /** Episodes submitted in a new batch this cycle (empty → no batch created). */
  submitted: string[];
  batchId?: string;
}

export async function runBatchCycle(opts: BatchCycleOptions): Promise<BatchCycleReport> {
  ensureBatchTables(opts.db);
  const clock = opts.clock ?? (() => new Date());
  const report: BatchCycleReport = { collected: [], run: undefined as never, submitted: [] };

  // ── collect ─────────────────────────────────────────────────────────────
  const open = opts.db
    .query("SELECT batch_id FROM extraction_batches WHERE status = 'running'")
    .all() as Array<{ batch_id: string }>;
  for (const { batch_id } of open) {
    const status = await opts.model.pollBatch(batch_id);
    if (status.status === "running") continue;
    if (status.status === "failed") {
      // Items never attempted — mark every in-flight row failed so the next
      // drain resubmits them (bounded by the per-episode fail cap).
      opts.db
        .query(
          "UPDATE extraction_requests SET error = ?, fails = fails + 1 WHERE batch_id = ? AND candidates_json IS NULL",
        )
        .run(status.error, batch_id);
      opts.db
        .query("UPDATE extraction_batches SET status = 'failed' WHERE batch_id = ?")
        .run(batch_id);
      report.collected.push({ batchId: batch_id, ok: 0, failed: 0 });
      continue;
    }
    let ok = 0;
    let failed = 0;
    for (const item of status.items) {
      if (item.ok && item.result) {
        const candidates = parseExtraction(item.result);
        opts.db
          .query(
            "UPDATE extraction_requests SET candidates_json = ?, error = NULL WHERE episode_id = ?",
          )
          .run(JSON.stringify(candidates), item.customId);
        ok += 1;
      } else {
        opts.db
          .query("UPDATE extraction_requests SET error = ?, fails = fails + 1 WHERE episode_id = ?")
          .run(item.error ?? "unknown batch item error", item.customId);
        failed += 1;
      }
    }
    opts.db.query("UPDATE extraction_batches SET status = 'done' WHERE batch_id = ?").run(batch_id);
    report.collected.push({ batchId: batch_id, ok, failed });
  }

  // ── drain ───────────────────────────────────────────────────────────────
  const extractor = new StoredResultExtractor(opts.db);
  report.run = await runConsolidator({ ...opts, extractor, batchSize: opts.batchSize ?? 100 });
  // Served rows are consumed — the ledger owns idempotency from here.
  for (const done of report.run.processed)
    opts.db.query("DELETE FROM extraction_requests WHERE episode_id = ?").run(done.episodeId);

  // ── submit ──────────────────────────────────────────────────────────────
  if (extractor.toSubmit.size > 0) {
    const items = [...extractor.toSubmit.entries()].map(([episodeId, { episode, ctx }]) => ({
      customId: episodeId,
      request: buildExtractionRequest(episode, ctx, opts.modelName),
    }));
    const batchId = await opts.model.submitBatch(items);
    const nowIso = clock().toISOString();
    opts.db
      .query("INSERT INTO extraction_batches (batch_id, submitted_at) VALUES (?, ?)")
      .run(batchId, nowIso);
    // Resubmission keeps the fail count — that's the runaway-spend bound.
    const insert = opts.db.query(
      `INSERT INTO extraction_requests (episode_id, batch_id, candidates_json) VALUES (?, ?, NULL)
       ON CONFLICT(episode_id) DO UPDATE SET batch_id = excluded.batch_id, candidates_json = NULL, error = NULL`,
    );
    for (const episodeId of extractor.toSubmit.keys()) insert.run(episodeId, batchId);
    report.submitted = [...extractor.toSubmit.keys()];
    report.batchId = batchId;
  }

  return report;
}
