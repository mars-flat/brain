/**
 * Batched consolidation (P5, §12 Q4): the cadence stages an upload on one
 * tick and creates its batch on the next (§5.8 staging — fresh uploads
 * aren't reliably visible to the provider's batch backend), waits without
 * burning §5.7 retry attempts, consolidates when the batch lands, and
 * bounds a permanently failing episode at three submissions before the
 * normal dead-letter path takes it.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVault, openDb } from "@brain/brainstore";
import type {
  BatchItem,
  BatchItemResult,
  BatchModelClient,
  BatchStatus,
  CompletionResult,
  EpisodeEnvelope,
} from "@brain/contracts";
import { SqliteQueue } from "@brain/queue-sqlite";
import {
  ensureConsolidatorTables,
  ingestEpisode,
  type QueuedEpisode,
  runBatchCycle,
  ulid,
} from "../src/index.ts";

// Advancing clock: each cycle is one 15-minute cadence tick, so §5.7 nack
// backoffs actually elapse (a frozen clock would hide nacked items forever).
let nowMs = new Date("2026-08-27T20:00:00Z").getTime();
const CLOCK = () => new Date(nowMs);

function mkVault(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-batch-"));
  for (const d of ["nodes/decision", "episodes", "pins", "quarantine"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  return root;
}

let epCounter = 100;
function envelope(content: string): EpisodeEnvelope {
  epCounter++;
  const iso = "2026-08-27T19:00:00Z";
  return {
    schema_version: 1,
    episode_id: `ep_${ulid(new Date(1750000000000 + epCounter * 60000))}`,
    principal: "owner",
    surface: "cli",
    harness: "claude-code",
    trust: "high",
    started_at: iso,
    ended_at: iso,
    turns: [{ seq: 0, kind: "message", role: "user", content, ts: iso }],
    labels: ["session"],
  };
}

function extractionResult(candidates: unknown[]): CompletionResult {
  return {
    content: JSON.stringify({ candidates }),
    parsed: { candidates },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

class FakeBatchClient implements BatchModelClient {
  uploads: Array<{ id: string; items: BatchItem[] }> = [];
  submissions: Array<{ id: string; items: BatchItem[] }> = [];
  /** Fail the next N createBatch calls (the fresh-upload race, provider-side). */
  failCreates = 0;
  private statuses = new Map<string, BatchStatus>();

  complete(): Promise<CompletionResult> {
    throw new Error("batch mode never calls sync complete");
  }

  uploadBatch(items: BatchItem[]): Promise<string> {
    const id = `upload_${this.uploads.length + 1}`;
    this.uploads.push({ id, items });
    return Promise.resolve(id);
  }

  createBatch(uploadId: string): Promise<string> {
    if (this.failCreates > 0) {
      this.failCreates--;
      throw new Error("Cannot find file, or organization does not have access");
    }
    const up = this.uploads.find((u) => u.id === uploadId);
    if (!up) throw new Error(`unknown upload ${uploadId}`);
    const id = `batch_${this.submissions.length + 1}`;
    this.submissions.push({ id, items: up.items });
    this.statuses.set(id, { status: "running" });
    return Promise.resolve(id);
  }

  pollBatch(batchId: string): Promise<BatchStatus> {
    const s = this.statuses.get(batchId);
    if (!s) throw new Error(`unknown batch ${batchId}`);
    return Promise.resolve(s);
  }

  finish(batchId: string, mapper: (item: BatchItem) => BatchItemResult): void {
    const sub = this.submissions.find((s) => s.id === batchId);
    if (!sub) throw new Error(`unknown batch ${batchId}`);
    this.statuses.set(batchId, { status: "complete", items: sub.items.map(mapper) });
  }

  failWhole(batchId: string, error: string): void {
    this.statuses.set(batchId, { status: "failed", error });
  }
}

async function setup(content: string) {
  const vault = mkVault();
  const db: Database = openDb(join(vault, "_index", "brain.db"));
  ensureConsolidatorTables(db);
  const queue = new SqliteQueue<QueuedEpisode>(db, () => CLOCK().getTime());
  const episode = envelope(content);
  await ingestEpisode(vault, queue, episode, new Set());
  const model = new FakeBatchClient();
  const cycle = () => {
    nowMs += 15 * 60_000;
    return runBatchCycle({ vaultPath: vault, db, model, clock: CLOCK, gitCommit: false });
  };
  return { vault, db, episode, model, cycle };
}

const CANDIDATE = {
  type: "concept",
  title: "Batch cycle fact",
  id_hint: "batch-cycle-fact",
  aliases: [],
  tags: [],
  summary: "A fact extracted through the Batch API path.",
  detail: "",
  confidence: "high",
  edges: [],
};

describe("batched consolidation (§12 Q4)", () => {
  test("stages once, waits across many cycles without dead-lettering, consolidates when done", async () => {
    const { vault, episode, model, cycle } = await setup("we decided something durable");

    // Tick 1 uploads only — the batch must NOT be created on a fresh upload.
    const first = await cycle();
    expect(first.staged).toEqual([episode.episode_id]);
    expect(first.promoted).toEqual([]);
    expect(first.run.waiting).toEqual([episode.episode_id]);
    expect(first.run.deadLettered).toEqual([]);
    expect(model.submissions.length).toBe(0);

    // Tick 2 promotes the aged upload into a batch.
    const second = await cycle();
    expect(second.promoted).toEqual([{ uploadId: "upload_1", batchId: "batch_1" }]);
    expect(second.staged).toEqual([]);

    // The batch is slow. Five more cycles: still waiting, never resubmitted,
    // never dead-lettered — pending must not burn §5.7 attempts.
    for (let i = 0; i < 5; i++) {
      const r = await cycle();
      expect(r.staged).toEqual([]);
      expect(r.run.waiting).toEqual([episode.episode_id]);
      expect(r.run.deadLettered).toEqual([]);
    }
    expect(model.uploads.length).toBe(1);
    expect(model.submissions.length).toBe(1);

    model.finish("batch_1", (item) => ({
      customId: item.customId,
      ok: true,
      result: extractionResult([CANDIDATE]),
    }));
    const done = await cycle();
    expect(done.collected).toEqual([{ batchId: "batch_1", ok: 1, failed: 0 }]);
    expect(done.run.processed[0]?.newNodes).toEqual(["batch-cycle-fact"]);
    expect(existsSync(join(vault, "nodes", "concept", "batch-cycle-fact.md"))).toBe(true);

    // Nothing left: no queue items, no new uploads.
    const idle = await cycle();
    expect(idle.run.processed).toEqual([]);
    expect(idle.staged).toEqual([]);
  });

  test("the extraction request is the sync request, verbatim", async () => {
    const { model, cycle } = await setup("same prompt either way");
    await cycle();
    const req = model.uploads[0]?.items[0]?.request;
    expect(req?.effort).toBe("medium");
    expect(req?.responseSchema).toBeDefined();
    expect(req?.messages[0]?.role).toBe("system");
    expect(req?.messages[1]?.content).toContain("same prompt either way");
  });

  test("a failing item resubmits at most three times, then dead-letters via §5.7", async () => {
    const { vault, episode, model, cycle } = await setup("this one always fails");

    for (let round = 1; round <= 3; round++) {
      await cycle(); // stages upload_{round}
      await cycle(); // promotes it to batch_{round}
      expect(model.submissions.length).toBe(round);
      model.finish(`batch_${round}`, (item) => ({
        customId: item.customId,
        ok: false,
        error: "model exploded",
      }));
    }

    // Fail cap reached: no more submissions, real error → retries → dead-letter.
    const reports = [];
    for (let i = 0; i < 4; i++) reports.push(await cycle());
    expect(model.submissions.length).toBe(3);
    const dead = reports.flatMap((r) => r.run.deadLettered);
    expect(dead.length).toBe(1);
    expect(dead[0]?.episodeId).toBe(episode.episode_id);
    expect(dead[0]?.reason).toContain("batch extraction failed 3×");
    const failedMarker = join(vault, "quarantine");
    expect(existsSync(failedMarker)).toBe(true);
    // Queue drained — the episode is out of the system except its dead-letter.
    const after = await cycle();
    expect(after.run.waiting).toEqual([]);
    expect(after.run.deadLettered).toEqual([]);
  });

  test("a whole-batch failure re-stages the episodes and surfaces the error", async () => {
    const { episode, model, cycle } = await setup("infra hiccup");
    await cycle(); // stage upload_1
    await cycle(); // promote to batch_1
    model.failWhole("batch_1", "quota exceeded");
    const r = await cycle();
    // Collected the failure (error visible, not a silent 0/0), re-staged
    // in the same cycle.
    expect(r.collected[0]?.batchId).toBe("batch_1");
    expect(r.collected[0]?.error).toBe("quota exceeded");
    expect(r.staged).toEqual([episode.episode_id]);
    await cycle(); // promote to batch_2
    expect(model.submissions.length).toBe(2);

    model.finish("batch_2", (item) => ({
      customId: item.customId,
      ok: true,
      result: extractionResult([CANDIDATE]),
    }));
    const done = await cycle();
    expect(done.run.processed[0]?.newNodes).toEqual(["batch-cycle-fact"]);
  });

  test("whole-batch failures never dead-letter: items were never attempted", async () => {
    const { model, cycle } = await setup("platform incident");
    // Two item-level failures first — the cap is two-thirds spent.
    for (let round = 1; round <= 2; round++) {
      await cycle(); // stage
      await cycle(); // promote
      model.finish(`batch_${round}`, (item) => ({
        customId: item.customId,
        ok: false,
        error: "model exploded",
      }));
    }
    // A long platform incident: every batch fails whole, far past the
    // item cap. The episode must stay pending, not dead-letter — and the
    // infra failure clears the item-fail count (no evidence against the
    // episode itself).
    for (let round = 3; round <= 8; round++) {
      const r1 = await cycle(); // collect the failure, re-stage
      const r2 = await cycle(); // promote
      expect(r1.run.deadLettered).toEqual([]);
      expect(r2.run.deadLettered).toEqual([]);
      expect(model.submissions.length).toBe(round);
      model.failWhole(`batch_${round}`, "Cannot find file, or organization does not have access");
    }
    // Incident over: the episode consolidates as if nothing happened.
    await cycle(); // collect the last failure, re-stage
    await cycle(); // promote to batch_9
    model.finish("batch_9", (item) => ({
      customId: item.customId,
      ok: true,
      result: extractionResult([CANDIDATE]),
    }));
    const done = await cycle();
    expect(done.run.processed[0]?.newNodes).toEqual(["batch-cycle-fact"]);
    expect(done.run.deadLettered).toEqual([]);
  });

  test("redelivered episodes stay idempotent through the batch path", async () => {
    const { vault, db, episode, model, cycle } = await setup("only once");
    await cycle(); // stage
    await cycle(); // promote
    model.finish("batch_1", (item) => ({
      customId: item.customId,
      ok: true,
      result: extractionResult([CANDIDATE]),
    }));
    await cycle();

    // The same episode re-enqueued (hook retry after success).
    const queue = new SqliteQueue<QueuedEpisode>(db, () => CLOCK().getTime());
    await ingestEpisode(
      vault,
      queue,
      episode,
      new Set(loadVault(vault).episodes.map((e) => e.basename)),
    );
    const again = await cycle();
    expect(again.run.skipped).toEqual([episode.episode_id]);
    expect(again.staged).toEqual([]);
    expect(model.uploads.length).toBe(1);
  });

  test("a fresh upload is never promoted in its own cycle, only once aged (§5.8 staging)", async () => {
    const { model, cycle } = await setup("fresh files aren't visible to the batch backend yet");
    const first = await cycle();
    expect(first.staged.length).toBe(1);
    expect(first.promoted).toEqual([]);
    expect(model.submissions.length).toBe(0);
    const second = await cycle();
    expect(second.promoted[0]?.batchId).toBe("batch_1");
  });

  test("a failed batch-create keeps the staged upload and retries next tick", async () => {
    const { episode, model, cycle } = await setup("the race outlasts one tick");
    await cycle(); // stage upload_1
    model.failCreates = 1;
    const blocked = await cycle();
    expect(blocked.promoted[0]?.uploadId).toBe("upload_1");
    expect(blocked.promoted[0]?.batchId).toBeUndefined();
    expect(blocked.promoted[0]?.error).toContain("Cannot find file");
    expect(blocked.run.waiting).toEqual([episode.episode_id]);
    expect(blocked.run.deadLettered).toEqual([]);
    // Next tick retries the SAME upload — never a re-upload, which would
    // reset the age that is the mitigation.
    const retried = await cycle();
    expect(retried.promoted[0]).toEqual({ uploadId: "upload_1", batchId: "batch_1" });
    expect(model.uploads.length).toBe(1);
  });
});
