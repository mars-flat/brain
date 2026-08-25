/**
 * The P2 done-when invariants (§8.3, §5.7):
 *   Idempotent consolidation — same episode twice → zero new nodes (both
 *   the ledger flavor and the same-content-new-id flavor).
 *   Reservation — overlapping episodes never create duplicate ids; a
 *   reservation conflict retries rather than corrupting; the run lock
 *   makes single-writer structural.
 *   Plus: trust gating, low-confidence + ambiguity quarantine, pin
 *   survival, supersedes flow, git commit per run, ingest guards,
 *   dead-lettering.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore, loadVault, openDb, parseNote, rebuild, renderNote } from "@brain/brainstore";
import type { EpisodeEnvelope, NodeFrontmatter } from "@brain/contracts";
import { SqliteQueue } from "@brain/queue-sqlite";
import {
  ensureConsolidatorTables,
  ingestEpisode,
  MarkerExtractor,
  type QueuedEpisode,
  releaseReservations,
  reserveIds,
  runConsolidator,
  ulid,
  writePin,
} from "../src/index.ts";

const CLOCK = () => new Date("2026-08-25T20:00:00Z");

function mkVault(git = false): string {
  const root = mkdtempSync(join(tmpdir(), "brain-consolidator-"));
  for (const d of ["nodes/decision", "episodes", "pins", "quarantine"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  if (git) {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], { cwd: root });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: root });
  }
  return root;
}

function writeNode(root: string, fm: NodeFrontmatter, body = ""): void {
  mkdirSync(join(root, "nodes", fm.type), { recursive: true });
  writeFileSync(join(root, "nodes", fm.type, `${fm.id}.md`), renderNote(fm, body));
}

let epCounter = 0;
function envelope(content: string[], over: Partial<EpisodeEnvelope> = {}): EpisodeEnvelope {
  epCounter++;
  return {
    schema_version: 1,
    episode_id: `ep_${ulid(new Date(1750000000000 + epCounter * 60000))}`,
    principal: "owner",
    surface: "cli",
    harness: "claude-code",
    trust: "high",
    started_at: "2026-08-25T19:00:00Z",
    ended_at: "2026-08-25T19:30:00Z",
    turns: content.map((c, i) => ({
      seq: i,
      kind: "message" as const,
      role: "user" as const,
      content: c,
      ts: "2026-08-25T19:00:01Z",
    })),
    labels: [`test-${epCounter}`],
    ...over,
  };
}

interface Harness {
  root: string;
  db: Database;
  queue: SqliteQueue<QueuedEpisode>;
}

function harness(git = false): Harness {
  const root = mkVault(git);
  const db = openDb(join(root, "_index", "brain.db"));
  ensureConsolidatorTables(db);
  return { root, db, queue: new SqliteQueue<QueuedEpisode>(db, () => CLOCK().getTime()) };
}

async function ingestAndRun(h: Harness, ep: EpisodeEnvelope, git = false) {
  const basenames = new Set(loadVault(h.root).episodes.map((e) => e.basename));
  await ingestEpisode(h.root, h.queue, ep, basenames);
  return runConsolidator({
    vaultPath: h.root,
    db: h.db,
    extractor: new MarkerExtractor(),
    clock: CLOCK,
    gitCommit: git,
  });
}

function nodeIds(root: string): string[] {
  const db = openDb(":memory:");
  rebuild(db, loadVault(root));
  return new BrainStore(db).nodeRefs().map((r) => r.id);
}

describe("consolidation happy path", () => {
  test("markers become linked, schema-valid nodes; ledger and log written", async () => {
    const h = harness();
    const report = await ingestAndRun(
      h,
      envelope([
        '@node decision "Ship the beta on Fridays" summary:"Beta releases go out Friday afternoons so weekend usage surfaces issues before the Monday sync." tags:process edge:about=release-cadence',
        '@node concept "Release cadence" id:release-cadence summary:"How often and when releases happen — the rhythm the team plans around."',
      ]),
    );
    expect(report.processed.length).toBe(1);
    const p = report.processed[0];
    expect(p?.newNodes.sort()).toEqual(["release-cadence", "ship-the-beta-on-fridays"]);
    const file = join(h.root, "nodes", "decision", "ship-the-beta-on-fridays.md");
    const parsed = parseNote(readFileSync(file, "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.frontmatter.about).toEqual(["[[release-cadence]]"]);
      expect(parsed.value.frontmatter.sources?.[0]).toContain("2026-08-25");
    }
    expect(readFileSync(join(h.root, "log.md"), "utf8")).toContain("+2 nodes");
    expect(h.queue.size()).toBe(0);
  });
});

describe("idempotent consolidation (§8.3)", () => {
  test("same episode enqueued twice → second run skips via ledger, zero new nodes", async () => {
    const h = harness();
    const ep = envelope(['@node concept "Only once" summary:"A single durable fact."']);
    const r1 = await ingestAndRun(h, ep);
    expect(r1.processed.length).toBe(1);
    // Same envelope again: ingest dedupes the file, the queue gets a second
    // item, and the ledger short-circuits it.
    const r2 = await ingestAndRun(h, ep);
    expect(r2.processed.length).toBe(0);
    expect(r2.skipped).toEqual([ep.episode_id]);
    expect(nodeIds(h.root).filter((id) => id === "only-once").length).toBe(1);
  });

  test("identical content under a NEW episode id → resolves to existing, zero new nodes", async () => {
    const h = harness();
    const content = [
      '@node concept "Deep fact" id:deep-fact summary:"The same durable fact both times."',
    ];
    await ingestAndRun(h, envelope(content));
    const r2 = await ingestAndRun(h, envelope(content));
    expect(r2.processed.length).toBe(1);
    expect(r2.processed[0]?.newNodes).toEqual([]);
    expect(nodeIds(h.root).filter((id) => id.startsWith("deep-fact")).length).toBe(1);
    // The re-mention added provenance, nothing else.
    const parsed = parseNote(
      readFileSync(join(h.root, "nodes", "concept", "deep-fact.md"), "utf8"),
    );
    if (parsed.ok) expect(parsed.value.frontmatter.sources?.length).toBe(2);
  });
});

describe("reservation + single writer (§8.3)", () => {
  test("overlapping episodes in one queue never duplicate an id", async () => {
    const h = harness();
    const mk = () =>
      envelope([
        '@node concept "Shared idea" id:shared-idea summary:"Both episodes mention this."',
      ]);
    const basenames = new Set(loadVault(h.root).episodes.map((e) => e.basename));
    await ingestEpisode(h.root, h.queue, mk(), basenames);
    const basenames2 = new Set(loadVault(h.root).episodes.map((e) => e.basename));
    await ingestEpisode(h.root, h.queue, mk(), basenames2);
    const report = await runConsolidator({
      vaultPath: h.root,
      db: h.db,
      extractor: new MarkerExtractor(),
      clock: CLOCK,
      gitCommit: false,
    });
    expect(report.processed.length).toBe(2);
    expect(nodeIds(h.root).filter((id) => id.startsWith("shared-idea")).length).toBe(1);
  });

  test("a foreign reservation forces retry, not corruption; released → succeeds", async () => {
    const h = harness();
    reserveIds(h.db, ["contested-id"], "ep_SOMEOTHEREPISODE0000000000", CLOCK().toISOString());
    const ep = envelope([
      '@node concept "Contested id" id:contested-id summary:"Wants a reserved id."',
    ]);
    const r1 = await ingestAndRun(h, ep);
    expect(r1.processed.length).toBe(0);
    expect(r1.retried.length).toBe(1);
    expect(r1.retried[0]?.reason).toContain("reserved");
    releaseReservations(h.db, "ep_SOMEOTHEREPISODE0000000000");
    // Nacked with tiny backoff; lease again after it becomes visible.
    await new Promise((r) => setTimeout(r, 60));
    const r2 = await runConsolidator({
      vaultPath: h.root,
      db: h.db,
      extractor: new MarkerExtractor(),
      clock: () => new Date(CLOCK().getTime() + 120),
      gitCommit: false,
    });
    expect(r2.processed.length).toBe(1);
  });

  test("the run lock refuses a second concurrent writer", async () => {
    const h = harness();
    const { acquireRunLock } = await import("../src/tables.ts");
    const release = acquireRunLock(h.db, "someone-else", 60_000);
    expect(release).not.toBeNull();
    const report = await runConsolidator({
      vaultPath: h.root,
      db: h.db,
      extractor: new MarkerExtractor(),
      clock: CLOCK,
      gitCommit: false,
    });
    expect(report.locked).toBe(true);
    release?.();
  });
});

describe("quarantine, trust, pins (§5.7, §6.5)", () => {
  test("medium trust → everything quarantines, nothing enters nodes/", async () => {
    const h = harness();
    const r = await ingestAndRun(
      h,
      envelope(
        ['@node preference "Loves quiet mornings" summary:"Planted or real? Review first."'],
        {
          trust: "medium",
          surface: "discord",
        },
      ),
    );
    expect(r.processed[0]?.newNodes).toEqual([]);
    expect(r.processed[0]?.quarantined).toBe(1);
    const qFiles = readdirSync(join(h.root, "quarantine"));
    expect(qFiles.length).toBe(1);
    const parsed = parseNote(readFileSync(join(h.root, "quarantine", qFiles[0] as string), "utf8"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.frontmatter.provenance).toBe("untrusted");
    expect(nodeIds(h.root)).toEqual([]);
  });

  test("low confidence quarantines even at high trust", async () => {
    const h = harness();
    const r = await ingestAndRun(
      h,
      envelope(['@node concept "Maybe a fact" confidence:low summary:"The model was guessing."']),
    );
    expect(r.processed[0]?.quarantined).toBe(1);
    expect(nodeIds(h.root)).toEqual([]);
  });

  test("near-but-not-identical titles quarantine as ambiguous instead of guessing", async () => {
    const h = harness();
    writeNode(h.root, {
      id: "weekly-review-ritual",
      type: "concept",
      title: "The weekly review ritual",
      created: "2026-01-01",
      updated: "2026-01-01",
      status: "active",
      summary: "Sunday planning session.",
    });
    const r = await ingestAndRun(
      h,
      envelope([
        '@node concept "The weekly review rituals habit" summary:"Similar but not the same words."',
      ]),
    );
    expect(r.processed[0]?.quarantined).toBe(1);
    const qFiles = readdirSync(join(h.root, "quarantine"));
    expect(readFileSync(join(h.root, "quarantine", qFiles[0] as string), "utf8")).toContain(
      "ambiguous",
    );
  });

  test("a pin blocks superseding its node — the change quarantines (§5.7)", async () => {
    const h = harness();
    writeNode(h.root, {
      id: "protected-decision",
      type: "decision",
      title: "The protected decision",
      created: "2026-01-01",
      updated: "2026-01-01",
      status: "active",
      summary: "Pinned truth.",
    });
    writePin(
      h.root,
      "protected-decision",
      "This stays as stated.",
      "owner correction",
      CLOCK(),
      false,
    );
    const r = await ingestAndRun(
      h,
      envelope([
        '@node decision "A new overriding decision" summary:"Tries to replace the pinned one." edge:supersedes=protected-decision',
      ]),
    );
    expect(r.processed[0]?.quarantined).toBe(1);
    expect(r.processed[0]?.newNodes).toEqual([]);
    const parsed = parseNote(
      readFileSync(join(h.root, "nodes", "decision", "protected-decision.md"), "utf8"),
    );
    if (parsed.ok) expect(parsed.value.frontmatter.status).toBe("active");
  });

  test("supersedes against an unpinned node flips its status and links the chain", async () => {
    const h = harness();
    writeNode(h.root, {
      id: "old-way",
      type: "decision",
      title: "The old way of doing it",
      created: "2026-01-01",
      updated: "2026-01-01",
      status: "active",
      summary: "What we used to do.",
    });
    const r = await ingestAndRun(
      h,
      envelope([
        '@node decision "The new way" id:new-way summary:"Replaces the old approach entirely after the retro." edge:supersedes=old-way',
      ]),
    );
    expect(r.processed[0]?.newNodes).toEqual(["new-way"]);
    const oldParsed = parseNote(
      readFileSync(join(h.root, "nodes", "decision", "old-way.md"), "utf8"),
    );
    if (oldParsed.ok) expect(oldParsed.value.frontmatter.status).toBe("superseded");
    const newParsed = parseNote(
      readFileSync(join(h.root, "nodes", "decision", "new-way.md"), "utf8"),
    );
    if (newParsed.ok) expect(newParsed.value.frontmatter.supersedes).toEqual(["[[old-way]]"]);
  });
});

describe("git commit per run (§5.7)", () => {
  test("each successful run lands exactly one vault commit", async () => {
    const h = harness(true);
    Bun.spawnSync(["git", "add", "-A"], { cwd: h.root });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: h.root });
    await ingestAndRun(
      h,
      envelope(['@node concept "Committed fact" summary:"Audit trail exists."']),
      true,
    );
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: h.root }).stdout.toString();
    expect(log.split("\n").filter(Boolean).length).toBe(2);
    expect(log).toContain("consolidate");
  });
});

describe("ingest guards", () => {
  test("untrusted, oversized, and malformed envelopes are refused", async () => {
    const h = harness();
    const basenames = new Set<string>();
    await expect(
      ingestEpisode(h.root, h.queue, envelope(["hi"], { trust: "untrusted" }), basenames),
    ).rejects.toThrow(/untrusted/);
    const huge = envelope(["x".repeat(900_000)]);
    await expect(ingestEpisode(h.root, h.queue, huge, basenames)).rejects.toThrow(/exceeds/);
    await expect(ingestEpisode(h.root, h.queue, { nope: true }, basenames)).rejects.toThrow(
      /invalid episode/,
    );
    expect(h.queue.size()).toBe(0);
  });
});

describe("dead-lettering", () => {
  test("a persistently failing episode dead-letters with a quarantine note after max attempts", async () => {
    const h = harness();
    const ep = envelope(['@node concept "Never lands" summary:"Extractor explodes."']);
    const basenames = new Set<string>();
    await ingestEpisode(h.root, h.queue, ep, basenames);
    const exploding = {
      extract: () => Promise.reject(new Error("model unavailable")),
    };
    const report = await runConsolidator({
      vaultPath: h.root,
      db: h.db,
      extractor: exploding,
      clock: CLOCK,
      gitCommit: false,
      maxAttempts: 1,
    });
    expect(report.deadLettered.length).toBe(1);
    const qFiles = readdirSync(join(h.root, "quarantine"));
    expect(qFiles.some((f) => f.startsWith("failed-"))).toBe(true);
    expect(h.queue.size()).toBe(0);
    // And the ledger stops it from ever re-processing.
    const again = await runConsolidator({
      vaultPath: h.root,
      db: h.db,
      extractor: new MarkerExtractor(),
      clock: CLOCK,
      gitCommit: false,
    });
    expect(again.processed.length).toBe(0);
  });
});

describe("pins integrate with recall", () => {
  test("a written pin is indexed and rides along at full tier", async () => {
    const h = harness();
    writeNode(h.root, {
      id: "pinned-topic",
      type: "concept",
      title: "A pinned topic with distinctive vocabulary",
      aliases: ["zanzibar protocol"],
      created: "2026-01-01",
      updated: "2026-08-01",
      status: "active",
      summary: "Something the owner corrected once and for all.",
    });
    for (let i = 0; i < 5; i++) {
      writeNode(h.root, {
        id: `filler-${i}`,
        type: "concept",
        title: `Filler ${i}`,
        created: "2026-01-01",
        updated: "2026-01-01",
        status: "active",
        summary: `Filler node ${i}.`,
      });
    }
    writePin(h.root, "pinned-topic", "The correction text.", "test", CLOCK(), false);
    const db = openDb(":memory:");
    rebuild(db, loadVault(h.root));
    const { recall } = await import("@brain/core");
    const out = recall(new BrainStore(db), { query: "zanzibar protocol" }, CLOCK());
    expect(out.result.pack).toContain("📌 PIN: The correction text.");
  });
});
