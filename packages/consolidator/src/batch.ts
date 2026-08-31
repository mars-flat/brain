/**
 * Batched consolidation (P5, §12 Q4 / §5.8): extraction rides the Batch
 * API's flat 50% discount, and consolidation becomes a background cadence
 * instead of an inline call. One `runBatchCycle` per cadence tick:
 *
 *   collect  — poll open batches; store finished extractions
 *   promote  — create the batch job for any staged upload at least one
 *              tick old (see below)
 *   drain    — runConsolidator with a stored-result extractor: episodes
 *              with results complete the normal §5.7 pipeline; the rest
 *              raise ExtractionPending (re-queued, no attempt burned) and
 *              are noted for submission
 *   stage    — upload one payload for every noted episode without an open
 *              request; its batch is created next tick
 *
 * Upload and batch creation live one tick apart because the provider's
 * batch backend lags file propagation: a batch created straight after its
 * upload can fail whole with "Cannot find file …" while the files API
 * serves that same file as processed (OpenAI platform bug, hit
 * 2026-08-28: every immediate-create batch failed for two days straight).
 * Aging the upload a full cadence tick sidesteps the race; a failed
 * create keeps the staged upload and retries next tick — re-uploading
 * would reset the very clock that is the mitigation.
 *
 * The single-writer pipeline is untouched: batching swaps WHERE candidates
 * come from, never how they are resolved, reserved, or written. A batch
 * item that errors is resubmitted with its `fails` count bumped; at three
 * failed extractions the extractor raises a REAL error instead of pending,
 * which routes the episode through §5.7's normal retry → dead-letter path.
 * (Pending re-queues reset the queue's attempt counter, so the fail count
 * lives here — without it a permanently failing episode would resubmit,
 * and bill, forever.)
 *
 * The cap counts only ITEM failures — evidence the episode itself is
 * poison. A whole-batch failure (validation, quota, platform incident)
 * never ran the episode, so it clears `fails` and the episode stays
 * pending: dead-lettering healthy memory because the discount transport
 * is down is the one unacceptable outcome. The bill-forever bound doesn't
 * apply — a failed batch bills no inference and its input upload
 * auto-expires — and the batch-level error is surfaced in the cycle
 * report so a stuck loop is visible in the journal, not silent.
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

/*
 * While status = 'staged', batch_id holds the provider UPLOAD id (the
 * batch does not exist yet); promote rewrites it to the real batch id in
 * both tables. Reusing the column keeps the schema stable — no migration,
 * and a pre-staging deployment's rows read the same way.
 */
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

/**
 * Minimum staged-upload age before its batch is created. Under the 15-min
 * cadence one tick always satisfies this; the gate exists so back-to-back
 * manual runs don't recreate the fresh-upload race the staging is for.
 */
const STAGE_MIN_AGE_MS = 10 * 60_000;

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
  /** Test seam for the staged-upload age gate; defaults to STAGE_MIN_AGE_MS. */
  stageMinAgeMs?: number;
}

export interface BatchCycleReport {
  /** Batches that finished this cycle (results stored or requests cleared). */
  collected: Array<{ batchId: string; ok: number; failed: number; error?: string }>;
  /** Staged uploads whose batch was created this cycle (or failed to be). */
  promoted: Array<{ uploadId: string; batchId?: string; error?: string }>;
  /** The consolidation pass over stored results. */
  run: RunReport;
  /** Episodes whose payload was uploaded this cycle (batch created next tick). */
  staged: string[];
  uploadId?: string;
}

export async function runBatchCycle(opts: BatchCycleOptions): Promise<BatchCycleReport> {
  ensureBatchTables(opts.db);
  const clock = opts.clock ?? (() => new Date());
  const stageMinAgeMs = opts.stageMinAgeMs ?? STAGE_MIN_AGE_MS;
  const report: BatchCycleReport = {
    collected: [],
    promoted: [],
    run: undefined as never,
    staged: [],
  };

  // ── collect ─────────────────────────────────────────────────────────────
  const open = opts.db
    .query("SELECT batch_id FROM extraction_batches WHERE status = 'running'")
    .all() as Array<{ batch_id: string }>;
  for (const { batch_id } of open) {
    const status = await opts.model.pollBatch(batch_id);
    if (status.status === "running") continue;
    if (status.status === "failed") {
      // Items never attempted — record the error so the next drain
      // resubmits them, and clear `fails`: a whole-batch failure is no
      // evidence against the episode, and counting it dead-letters
      // healthy memory during a platform incident (seen 2026-08-28).
      // The trade — an infra blip forgives up to three prior item
      // failures — costs at most three extra billed attempts.
      opts.db
        .query(
          "UPDATE extraction_requests SET error = ?, fails = 0 WHERE batch_id = ? AND candidates_json IS NULL",
        )
        .run(status.error, batch_id);
      opts.db
        .query("UPDATE extraction_batches SET status = 'failed' WHERE batch_id = ?")
        .run(batch_id);
      report.collected.push({ batchId: batch_id, ok: 0, failed: 0, error: status.error });
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

  // ── promote ─────────────────────────────────────────────────────────────
  const staged = opts.db
    .query("SELECT batch_id, submitted_at FROM extraction_batches WHERE status = 'staged'")
    .all() as Array<{ batch_id: string; submitted_at: string }>;
  for (const { batch_id: uploadId, submitted_at } of staged) {
    if (clock().getTime() - Date.parse(submitted_at) < stageMinAgeMs) continue;
    try {
      const batchId = await opts.model.createBatch(uploadId);
      opts.db
        .query("UPDATE extraction_batches SET batch_id = ?, status = 'running' WHERE batch_id = ?")
        .run(batchId, uploadId);
      opts.db
        .query("UPDATE extraction_requests SET batch_id = ? WHERE batch_id = ?")
        .run(batchId, uploadId);
      report.promoted.push({ uploadId, batchId });
    } catch (err) {
      // The upload exists and its age is the mitigation — keep the staged
      // row and retry next tick rather than re-uploading (header).
      report.promoted.push({
        uploadId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── drain ───────────────────────────────────────────────────────────────
  const extractor = new StoredResultExtractor(opts.db);
  report.run = await runConsolidator({ ...opts, extractor, batchSize: opts.batchSize ?? 100 });
  // Served rows are consumed — the ledger owns idempotency from here.
  for (const done of report.run.processed)
    opts.db.query("DELETE FROM extraction_requests WHERE episode_id = ?").run(done.episodeId);

  // ── stage ───────────────────────────────────────────────────────────────
  if (extractor.toSubmit.size > 0) {
    const items = [...extractor.toSubmit.entries()].map(([episodeId, { episode, ctx }]) => ({
      customId: episodeId,
      request: buildExtractionRequest(episode, ctx, opts.modelName),
    }));
    const uploadId = await opts.model.uploadBatch(items);
    const nowIso = clock().toISOString();
    opts.db
      .query(
        "INSERT INTO extraction_batches (batch_id, submitted_at, status) VALUES (?, ?, 'staged')",
      )
      .run(uploadId, nowIso);
    // Resubmission keeps the fail count — that's the runaway-spend bound.
    const insert = opts.db.query(
      `INSERT INTO extraction_requests (episode_id, batch_id, candidates_json) VALUES (?, ?, NULL)
       ON CONFLICT(episode_id) DO UPDATE SET batch_id = excluded.batch_id, candidates_json = NULL, error = NULL`,
    );
    for (const episodeId of extractor.toSubmit.keys()) insert.run(episodeId, uploadId);
    report.staged = [...extractor.toSubmit.keys()];
    report.uploadId = uploadId;
  }

  return report;
}
