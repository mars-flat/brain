/**
 * Proposed tasks (§16.8): the pure nets and transitions, then the store
 * around them — the three exact duplicate nets across every status and
 * dismiss reason, folding, the entity windows, accept as one transaction,
 * purge nulling the pointer, the stale trim, and the v2 → v3 migration on a
 * verbatim v2 file (plus a v1 file crossing both steps).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskError } from "../src/core.ts";
import {
  findDuplicate,
  foldIntoProposal,
  isStale,
  markAccepted,
  markDismissed,
  markRestored,
  newProposal,
  normalizeEntity,
  type Proposal,
  type ProposeCandidate,
  similarTaskHint,
  validatePropose,
} from "../src/proposals.ts";
import { openTasksDb, SCHEMA_VERSION, TaskStore } from "../src/store.ts";
import { DAY_MS } from "../src/time.ts";

const TZ = "America/Toronto";
const T0 = Date.UTC(2026, 9, 28, 12, 0, 0); // 2026-10-28 08:00 Toronto

function mkStore(now: () => number = () => T0, path = ":memory:") {
  let n = 0;
  return new TaskStore(openTasksDb(path), now, () => `p${++n}`, TZ);
}

const gmail = (msg: string, extra: Record<string, unknown> = {}) => ({
  kind: "gmail",
  account: "g-test",
  from: "LEARN <noreply@learn.invalid>",
  subject: `A3 posted ${msg}`,
  received_at: T0 - DAY_MS,
  ...extra,
});

const input = (over: Record<string, unknown> = {}) => ({
  title: "CS 348 A3 due",
  kind: "university" as const,
  entity: "CS348 A3",
  dedupeKey: "gmail:g-test:m1",
  threadKey: "gmail:g-test:t1",
  source: gmail("m1"),
  dueAt: T0 + 5 * DAY_MS,
  confidence: 0.8,
  ...over,
});

describe("validation and normalization", () => {
  test("entity normalizes to lowercase alphanumerics with single spaces", () => {
    expect(normalizeEntity("  CS-348 / A3!! ")).toBe("cs348a3");
    expect(normalizeEntity("CS348 A3")).toBe("cs348a3");
    expect(normalizeEntity("Netflix")).toBe("netflix");
    expect(normalizeEntity("***")).toBe("");
  });

  test("every required field is enforced; the title and notes rules are the task rules", () => {
    expect(() => validatePropose(input({ title: "  " }))).toThrow(TaskError);
    expect(() => validatePropose(input({ kind: "chore" }))).toThrow(/kind must be/);
    expect(() => validatePropose(input({ entity: "!!" }))).toThrow(/entity is required/);
    expect(() => validatePropose(input({ dedupeKey: "" }))).toThrow(/dedupe_key is required/);
    expect(() => validatePropose(input({ source: { account: "x" } }))).toThrow(/source/);
    expect(() => validatePropose(input({ confidence: 1.5 }))).toThrow(/confidence/);
    expect(() => validatePropose(input({ dueAt: -1 }))).toThrow(/instant/);
    expect(() => validatePropose(input({ notes: "x".repeat(4001) }))).toThrow(/notes too long/);
    const c = validatePropose(input({ threadKey: "" }));
    expect(c.threadKey).toBeNull();
    expect(c.subject).toBe("A3 posted m1");
    expect(c.receivedAt).toBe(T0 - DAY_MS);
    expect(c.hasTime).toBe(false);
  });
});

describe("the duplicate nets (pure)", () => {
  const c: ProposeCandidate = validatePropose(input());
  const row = (over: Partial<Proposal>): Proposal => ({
    ...newProposal(c, T0 - 2 * DAY_MS, "old"),
    ...over,
  });
  const empty = { byKey: null, byThread: [], byEntity: [] };

  test("nothing found → null", () => {
    expect(findDuplicate(c, empty, T0)).toBeNull();
  });

  test("the message key wins over everything, whatever the row's status", () => {
    for (const status of ["pending", "accepted", "dismissed"] as const) {
      const r = row({
        status,
        resolvedAt: status === "pending" ? null : T0 - DAY_MS,
        dismissReason: status === "dismissed" ? "stale" : null,
      });
      const v = findDuplicate(c, { byKey: r, byThread: [], byEntity: [] }, T0);
      expect(v).toMatchObject({ net: "key", action: "duplicate", reason: "key" });
    }
  });

  test("thread: pending folds, accepted and owner-dismissed suppress, stale and duplicate dismissals are ignored", () => {
    const pending = row({});
    expect(findDuplicate(c, { ...empty, byThread: [pending] }, T0)).toMatchObject({
      net: "thread",
      action: "fold",
    });
    const accepted = row({ status: "accepted", resolvedAt: T0 - 400 * DAY_MS, taskId: "t1" });
    expect(findDuplicate(c, { ...empty, byThread: [accepted] }, T0)).toMatchObject({
      action: "duplicate",
      reason: "accepted",
    });
    const owner = row({ status: "dismissed", dismissReason: "owner", resolvedAt: T0 - DAY_MS });
    expect(findDuplicate(c, { ...empty, byThread: [owner] }, T0)).toMatchObject({
      action: "duplicate",
      reason: "dismissed",
    });
    for (const dismissReason of ["stale", "duplicate"] as const) {
      const r = row({ status: "dismissed", dismissReason, resolvedAt: T0 - DAY_MS });
      expect(findDuplicate(c, { ...empty, byThread: [r] }, T0)).toBeNull();
    }
  });

  test("entity: same verdicts, but accepted/owner-dismissed expire per kind (60d; 90d for subscriptions)", () => {
    const accepted = (ago: number) =>
      row({ status: "accepted", resolvedAt: T0 - ago, taskId: "t1" });
    expect(findDuplicate(c, { ...empty, byEntity: [accepted(59 * DAY_MS)] }, T0)).toMatchObject({
      net: "entity",
      reason: "accepted",
    });
    expect(findDuplicate(c, { ...empty, byEntity: [accepted(61 * DAY_MS)] }, T0)).toBeNull();
    const sub = validatePropose(input({ kind: "subscription", entity: "netflix" }));
    const subRow = (ago: number): Proposal => ({
      ...newProposal(sub, T0 - ago, "s"),
      status: "dismissed",
      dismissReason: "owner",
      resolvedAt: T0 - ago,
    });
    expect(findDuplicate(sub, { ...empty, byEntity: [subRow(89 * DAY_MS)] }, T0)).toMatchObject({
      reason: "dismissed",
    });
    expect(findDuplicate(sub, { ...empty, byEntity: [subRow(91 * DAY_MS)] }, T0)).toBeNull();
    // Pending never expires.
    expect(findDuplicate(c, { ...empty, byEntity: [row({})] }, T0)).toMatchObject({
      action: "fold",
    });
  });

  test("order: key, then thread rows in order, then entity rows", () => {
    const stale = row({ status: "dismissed", dismissReason: "stale", resolvedAt: T0 - DAY_MS });
    const pending = row({ id: "p" });
    const accepted = row({ id: "a", status: "accepted", resolvedAt: T0 - DAY_MS, taskId: "t" });
    const v = findDuplicate(
      c,
      { byKey: null, byThread: [stale, pending], byEntity: [accepted] },
      T0,
    );
    expect(v).toMatchObject({ net: "thread", action: "fold", row: { id: "p" } });
  });
});

describe("transitions (pure)", () => {
  const c = validatePropose(input());
  const p = newProposal(c, T0, "p1");

  test("fold appends one line, keeps the later due date, bumps, and respects the notes cap", () => {
    const follow = validatePropose(
      input({
        dedupeKey: "gmail:g-test:m2",
        dueAt: T0 + 9 * DAY_MS,
        confidence: 0.5,
        source: gmail("m2", { subject: "A3 deadline extended", received_at: T0 }),
      }),
    );
    const f = foldIntoProposal(p, follow, T0 + 1000, TZ);
    expect(f.notes).toBe("also: A3 deadline extended · 2026-10-28");
    expect(f.dueAt).toBe(T0 + 9 * DAY_MS);
    expect(f.confidence).toBe(0.8);
    expect(f.updatedAt).toBe(T0 + 1000);
    const earlier = validatePropose(input({ dedupeKey: "k3", dueAt: T0 + DAY_MS }));
    expect(foldIntoProposal(f, earlier, T0 + 2000, TZ).dueAt).toBe(T0 + 9 * DAY_MS);
    const full = { ...p, notes: "x".repeat(3990) };
    expect(foldIntoProposal(full, follow, T0, TZ).notes).toBe(full.notes);
    expect(() => foldIntoProposal({ ...p, status: "accepted" }, follow, T0, TZ)).toThrow(TaskError);
  });

  test("accept / dismiss / restore only from the states that allow them", () => {
    const a = markAccepted(p, "task9", T0 + 1);
    expect(a).toMatchObject({ status: "accepted", taskId: "task9", resolvedAt: T0 + 1 });
    expect(() => markAccepted(a, "x", T0)).toThrow(/accepted, not pending/);
    const d = markDismissed(p, "owner", T0 + 2);
    expect(d).toMatchObject({ status: "dismissed", dismissReason: "owner" });
    expect(() => markDismissed(p, "whim" as never, T0)).toThrow(/dismiss reason/);
    expect(markRestored(d, T0 + 3)).toMatchObject({
      status: "pending",
      dismissReason: null,
      resolvedAt: null,
    });
    expect(() => markRestored(a, T0)).toThrow(/accepted, not dismissed/);
  });

  test("stale is pending and at least N days old", () => {
    expect(isStale(p, T0 + 7 * DAY_MS, 7)).toBe(true);
    expect(isStale(p, T0 + 7 * DAY_MS - 1, 7)).toBe(false);
    expect(isStale(markDismissed(p, "owner", T0), T0 + 30 * DAY_MS, 7)).toBe(false);
  });

  test("the hint needs two shared non-stopword tokens and decides nothing", () => {
    const task = (id: string, title: string) =>
      ({ id, title }) as unknown as import("../src/core.ts").Task;
    const open = [task("1", "Pay tuition fees"), task("2", "CS 348 A3 due"), task("3", "Dentist")];
    expect(similarTaskHint("A3 — CS348 — due Friday", open)?.id).toBeUndefined(); // "cs348" ≠ "cs","348"
    expect(similarTaskHint("CS 348 assignment 3 (A3)", open)?.id).toBe("2");
    expect(similarTaskHint("Pay the tuition", open)?.id).toBe("1"); // pay + tuition
    expect(similarTaskHint("Pay rent", open)).toBeNull(); // one shared token is not enough
    expect(similarTaskHint("the of and", open)).toBeNull();
  });
});

describe("the store", () => {
  test("propose creates, folds on thread, folds on entity across accounts, and reports key duplicates", () => {
    const s = mkStore();
    const r1 = s.propose(input());
    expect(r1.outcome).toBe("created");
    expect(s.proposalSources(r1.proposal.id).map((x) => x.dedupeKey)).toEqual(["gmail:g-test:m1"]);
    // Same thread, new message → fold.
    const r2 = s.propose(
      input({
        dedupeKey: "gmail:g-test:m2",
        title: "A3 deadline extended",
        source: gmail("m2", { subject: "A3 deadline extended", received_at: T0 }),
      }),
    );
    expect(r2.outcome).toBe("folded");
    expect(r2.proposal.id).toBe(r1.proposal.id);
    expect(r2.proposal.notes).toContain("also: A3 deadline extended");
    expect(s.proposalSources(r1.proposal.id)).toHaveLength(2);
    // Same entity, other account, other thread → fold.
    const r3 = s.propose(
      input({
        dedupeKey: "gmail:g-other:m9",
        threadKey: "gmail:g-other:t9",
        entity: "cs-348 a3",
        source: gmail("m9", { account: "g-other" }),
      }),
    );
    expect(r3.outcome).toBe("folded");
    // The folded message's key is remembered: re-sending it is a key duplicate, not a second fold.
    const r4 = s.propose(input({ dedupeKey: "gmail:g-other:m9", threadKey: null }));
    expect(r4).toMatchObject({ outcome: "duplicate", reason: "key" });
    expect(s.proposalSources(r1.proposal.id)).toHaveLength(3);
    expect(s.proposals("pending")).toHaveLength(1);
    expect(s.proposalCounts()).toEqual({ pending: 1, accepted: 0, dismissed: 0 });
  });

  test("proposals never leak into tasks: list, due, counts", () => {
    const s = mkStore();
    s.propose(input());
    expect(s.list("all")).toHaveLength(0);
    expect(s.attention(3)).toEqual({ overdue: [], today: [], upcoming: [], later: [] });
    expect(s.counts()).toEqual({ open: 0, retired: 0 });
  });

  test("accept creates the task with every rule intact and flips the row in one transaction", () => {
    const s = mkStore();
    const { proposal } = s.propose(input()) as { proposal: Proposal };
    // A refused create (next date in the past) leaves the proposal pending.
    expect(() => s.acceptProposal(proposal.id, { intervalMs: 7 * DAY_MS, dueAt: -5 })).toThrow(
      TaskError,
    );
    expect(s.proposal(proposal.id)?.status).toBe("pending");
    expect(s.list("open")).toHaveLength(0);
    const r = s.acceptProposal(proposal.id, { intervalMs: null });
    expect(r.task.title).toBe("CS 348 A3 due");
    expect(r.task.dueAt).not.toBeNull();
    expect(r.task.hasTime).toBe(false);
    expect(r.proposal).toMatchObject({ status: "accepted", taskId: r.task.id });
    expect(() => s.acceptProposal(proposal.id, { intervalMs: null })).toThrow(
      /accepted, not pending/,
    );
    // Now the thread and the entity suppress, naming the task.
    expect(s.propose(input({ dedupeKey: "k2" }))).toMatchObject({
      outcome: "duplicate",
      reason: "accepted",
      proposal: { taskId: r.task.id },
    });
    // Purging that task nulls the pointer; the proposal row survives.
    s.retire(r.task.id);
    s.purge(r.task.id);
    expect(s.proposal(proposal.id)).toMatchObject({ status: "accepted", taskId: null });
  });

  test("dismiss by the owner suppresses; restore un-suppresses; stale dismissals never suppress", () => {
    const s = mkStore();
    const { proposal } = s.propose(input()) as { proposal: Proposal };
    s.dismissProposal(proposal.id);
    expect(s.propose(input({ dedupeKey: "k2" }))).toMatchObject({
      outcome: "duplicate",
      reason: "dismissed",
    });
    s.restoreProposal(proposal.id);
    expect(s.propose(input({ dedupeKey: "k3" })).outcome).toBe("folded");
    s.dismissProposal(proposal.id, "stale");
    const again = s.propose(input({ dedupeKey: "k4" }));
    expect(again.outcome).toBe("created");
    expect(again.proposal.id).not.toBe(proposal.id);
  });

  test("the stale trim dismisses only pending rows older than N days, as stale", () => {
    let now = T0;
    const s = mkStore(() => now);
    const a = s.propose(input()).proposal;
    now = T0 + 3 * DAY_MS;
    const b = s.propose(input({ dedupeKey: "k2", threadKey: "t2", entity: "math239 q1" })).proposal;
    now = T0 + 8 * DAY_MS;
    expect(s.dismissStaleProposals(7)).toBe(1);
    expect(s.proposal(a.id)).toMatchObject({ status: "dismissed", dismissReason: "stale" });
    expect(s.proposal(b.id)?.status).toBe("pending");
    expect(s.dismissStaleProposals(7)).toBe(0);
  });

  test("listing: pending newest first; filters by kind and status", () => {
    let now = T0;
    const s = mkStore(() => now);
    const a = s.propose(input()).proposal;
    now = T0 + 1000;
    const b = s.propose(
      input({ dedupeKey: "k2", threadKey: "t2", entity: "netflix", kind: "subscription" }),
    ).proposal;
    expect(s.proposals().map((p) => p.id)).toEqual([b.id, a.id]);
    expect(s.proposals("pending", { kind: "subscription" }).map((p) => p.id)).toEqual([b.id]);
    s.dismissProposal(a.id);
    expect(s.proposals("dismissed").map((p) => p.id)).toEqual([a.id]);
    expect(s.proposals("all")).toHaveLength(2);
    expect(s.proposal("not a real id; DROP TABLE")).toBeNull();
  });
});

describe("migrations", () => {
  const V2_SCHEMA = `
CREATE TABLE tasks_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', interval_ms INTEGER,
  anchor TEXT NOT NULL CHECK (anchor IN ('completion', 'due')),
  status TEXT NOT NULL CHECK (status IN ('open', 'retired')),
  due_at INTEGER, has_time INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_closed_at INTEGER, closes INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'open') = (due_at IS NOT NULL))
);
CREATE INDEX tasks_open_due ON tasks (status, due_at);
CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
CREATE INDEX task_events_task ON task_events (task_id, id);
CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at INTEGER NOT NULL);
CREATE TABLE task_tags (task_id TEXT NOT NULL REFERENCES tasks(id), tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (task_id, tag_id));
CREATE TABLE task_purges (task_id TEXT PRIMARY KEY);
CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER task_events_no_delete_v2 BEFORE DELETE ON task_events
WHEN NOT EXISTS (SELECT 1 FROM task_purges WHERE task_id = OLD.task_id)
BEGIN SELECT RAISE(ABORT, 'task_events is append-only — only purging a retired task removes its log'); END;
INSERT INTO tasks_meta VALUES ('schema_version', '2');
INSERT INTO tasks VALUES ('old2', 'from v2', '', NULL, 'completion', 'open', ${T0}, 0, ${T0}, ${T0}, NULL, 0);
INSERT INTO task_events (task_id, at, kind, detail) VALUES ('old2', ${T0}, 'created', '{"title":"from v2","dueAt":${T0},"hasTime":false}');
`;

  test("a verbatim v2 file migrates to v3 in place, keeping its tasks and gaining proposals", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tasks-v2-")), "tasks.db");
    const v2 = new Database(path, { create: true });
    v2.exec(V2_SCHEMA);
    v2.close();
    const db = openTasksDb(path);
    expect(
      (
        db.query("SELECT value FROM tasks_meta WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value,
    ).toBe(String(SCHEMA_VERSION));
    const s = new TaskStore(
      db,
      () => T0,
      () => "p1",
      TZ,
    );
    expect(s.get("old2")?.hasTime).toBe(false);
    expect(s.propose(input()).outcome).toBe("created");
    db.close();
    expect(openTasksDb(path)).toBeDefined(); // reopening a v3 file is a no-op
  });

  test("a v1 file crosses both steps in one transaction", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tasks-v1-")), "tasks.db");
    const v1 = new Database(path, { create: true });
    v1.exec(`
      CREATE TABLE tasks_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', interval_ms INTEGER,
        anchor TEXT NOT NULL CHECK (anchor IN ('completion', 'due')),
        status TEXT NOT NULL CHECK (status IN ('open', 'retired')),
        due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_closed_at INTEGER, closes INTEGER NOT NULL DEFAULT 0,
        CHECK ((status = 'open') = (due_at IS NOT NULL))
      );
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
      CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'append-only'); END;
      INSERT INTO tasks_meta VALUES ('schema_version', '1');
      INSERT INTO tasks VALUES ('old1', 'from v1', '', NULL, 'completion', 'open', ${T0}, ${T0}, ${T0}, NULL, 0);
    `);
    v1.close();
    const db = openTasksDb(path);
    expect(
      (
        db.query("SELECT value FROM tasks_meta WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value,
    ).toBe("3");
    const s = new TaskStore(
      db,
      () => T0,
      () => "p1",
      TZ,
    );
    expect(s.get("old1")?.hasTime).toBe(true);
    expect(s.proposals("all")).toEqual([]);
    expect(s.propose(input()).outcome).toBe("created");
  });
});
