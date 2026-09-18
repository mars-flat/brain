/**
 * The store's structural guarantees (§16.3): the database enforces the one
 * open occurrence, the log is append-only by trigger, two processes can
 * share the file, and a schema mismatch is a migration gate — never a
 * "delete and rebuild" (this is source of truth).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskError } from "../src/core.ts";
import { NotFound, openTasksDb, TaskStore } from "../src/store.ts";
import { DAY_MS } from "../src/time.ts";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);

describe("schema guarantees", () => {
  test("an open task without a due date, or a retired one with, is unrepresentable", () => {
    const db = openTasksDb(":memory:");
    const store = new TaskStore(db, () => T0);
    const t = store.create({ title: "x", intervalMs: DAY_MS });
    expect(() => db.query("UPDATE tasks SET due_at = NULL WHERE id = ?").run(t.id)).toThrow();
    expect(() => db.query("UPDATE tasks SET status = 'retired' WHERE id = ?").run(t.id)).toThrow();
  });

  test("the event log rejects updates and deletes", () => {
    const db = openTasksDb(":memory:");
    const store = new TaskStore(db, () => T0);
    store.create({ title: "x", intervalMs: DAY_MS });
    expect(() => db.query("UPDATE task_events SET kind = 'edited'").run()).toThrow(/append-only/);
    expect(() => db.query("DELETE FROM task_events").run()).toThrow(/append-only/);
  });

  test("file stores run in WAL mode and are visible across handles", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-"));
    const path = join(dir, "nested", "tasks.db"); // mkdir -p is the store's job
    const a = new TaskStore(openTasksDb(path), () => T0);
    const b = new TaskStore(openTasksDb(path), () => T0 + DAY_MS);
    expect((a.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    const t = a.create({ title: "shared", intervalMs: DAY_MS });
    expect(b.get(t.id)?.title).toBe("shared");
    b.close(t.id, "completed");
    expect(a.get(t.id)?.closes).toBe(1);
    expect(a.get(t.id)?.dueAt).toBe(T0 + 2 * DAY_MS);
  });

  test("a schema version mismatch is a migration gate, not a rebuild hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-"));
    const path = join(dir, "tasks.db");
    const db = openTasksDb(path);
    db.query("UPDATE tasks_meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openTasksDb(path)).toThrow(/migrate it, never delete it/);
  });
});

describe("lookups", () => {
  test("unknown ids are NotFound on mutation and null on read; hostile ids never reach SQL", () => {
    const store = new TaskStore(openTasksDb(":memory:"), () => T0);
    expect(store.get("nope")).toBeNull();
    expect(store.get("../etc/passwd")).toBeNull();
    expect(() => store.retire("nope")).toThrow(NotFound);
    expect(() => store.retire("nope")).toThrow(TaskError);
  });

  test("counts and list filters", () => {
    const store = new TaskStore(openTasksDb(":memory:"), () => T0);
    const a = store.create({ title: "a", intervalMs: DAY_MS, dueAt: T0 + 2 * DAY_MS });
    const b = store.create({ title: "b", intervalMs: DAY_MS, dueAt: T0 + DAY_MS });
    store.create({ title: "c", intervalMs: null, dueAt: T0 + 3 * DAY_MS });
    store.retire(a.id);
    expect(store.counts()).toEqual({ open: 2, retired: 1 });
    expect(store.list("open").map((t) => t.title)).toEqual(["b", "c"]); // soonest first
    expect(store.list("retired").map((t) => t.title)).toEqual(["a"]);
    expect(store.list("all")).toHaveLength(3);
    expect(store.get(b.id)?.dueAt).toBe(T0 + DAY_MS);
  });
});

describe("attention buckets follow the LOCAL day", () => {
  test("overdue / today / upcoming / later in a real zone", () => {
    // 2026-09-17T23:30Z is Sep 17 19:30 in Toronto but already Sep 18 in Tokyo.
    const now = Date.UTC(2026, 8, 17, 23, 30);
    const store = new TaskStore(openTasksDb(":memory:"), () => now);
    store.create({ title: "late", intervalMs: DAY_MS, dueAt: Date.UTC(2026, 8, 16, 12) });
    store.create({ title: "tonight", intervalMs: DAY_MS, dueAt: Date.UTC(2026, 8, 18, 1) });
    store.create({ title: "soon", intervalMs: DAY_MS, dueAt: now + 2 * DAY_MS });
    store.create({ title: "far", intervalMs: DAY_MS, dueAt: now + 30 * DAY_MS });
    const toronto = store.attention("America/Toronto", 3);
    expect(toronto.overdue.map((t) => t.title)).toEqual(["late"]);
    expect(toronto.today.map((t) => t.title)).toEqual(["tonight"]); // 01:00Z = 21:00 local, same day
    expect(toronto.upcoming.map((t) => t.title)).toEqual(["soon"]);
    expect(toronto.later.map((t) => t.title)).toEqual(["far"]);
    const tokyo = store.attention("Asia/Tokyo", 3);
    expect(tokyo.overdue.map((t) => t.title)).toEqual(["late"]);
    expect(tokyo.today.map((t) => t.title)).toEqual(["tonight"]); // now is already Sep 18 there
  });
});
