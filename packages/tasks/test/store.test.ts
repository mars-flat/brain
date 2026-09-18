/**
 * The store's structural guarantees (§16.3): the database enforces the one
 * open occurrence, the log is append-only by trigger except through a
 * purge, two processes can share the file, a v1 file migrates in place,
 * and a schema mismatch is a migration gate — never a "delete and rebuild"
 * (this is source of truth). Plus tags: managed as a list, assigned by
 * name, derived ones read-only.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskError } from "../src/core.ts";
import { NotFound, openTasksDb, SCHEMA_VERSION, TaskStore } from "../src/store.ts";
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

  test("the event log rejects updates and casual deletes", () => {
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
    const t = a.create({ title: "shared", intervalMs: DAY_MS, hasTime: true });
    expect(b.get(t.id)?.title).toBe("shared");
    b.close(t.id, "completed");
    expect(a.get(t.id)?.closes).toBe(1);
    expect(a.get(t.id)?.dueAt).toBe(T0 + 2 * DAY_MS);
  });

  test("a schema version from the future is a migration gate, not a rebuild hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-"));
    const path = join(dir, "tasks.db");
    const db = openTasksDb(path);
    db.query("UPDATE tasks_meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openTasksDb(path)).toThrow(/migrate it, never delete it/);
  });

  test("a v1 file (no has_time, no tags, absolute delete trigger) migrates in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-"));
    const path = join(dir, "tasks.db");
    // The v1 schema, verbatim from 2026-09-18 — what the VM's store looked like.
    const v1 = new Database(path, { create: true });
    v1.exec(`
      CREATE TABLE tasks_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', interval_ms INTEGER,
        anchor TEXT NOT NULL CHECK (anchor IN ('completion','due')),
        status TEXT NOT NULL CHECK (status IN ('open','retired')),
        due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_closed_at INTEGER, closes INTEGER NOT NULL DEFAULT 0,
        CHECK ((status = 'open') = (due_at IS NOT NULL)));
      CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
      CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
      CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
      INSERT INTO tasks_meta VALUES ('schema_version', '1');
      INSERT INTO tasks VALUES ('old1', 'legacy', '', 604800000, 'completion', 'open', ${T0}, ${T0}, ${T0}, NULL, 0);
      INSERT INTO task_events (task_id, at, kind, detail) VALUES ('old1', ${T0}, 'created',
        '{"title":"legacy","notes":"","intervalMs":604800000,"anchor":"completion","dueAt":${T0}}');
    `);
    v1.close();

    const db = openTasksDb(path);
    const version = (
      db.query("SELECT value FROM tasks_meta WHERE key = 'schema_version'").get() as {
        value: string;
      }
    ).value;
    expect(Number(version)).toBe(SCHEMA_VERSION);
    const cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("has_time");
    const triggers = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(triggers).toContain("task_events_no_delete_v2");
    expect(triggers).not.toContain("task_events_no_delete");

    const store = new TaskStore(db, () => T0 + DAY_MS);
    const legacy = store.get("old1");
    expect(legacy?.hasTime).toBe(true); // v1 tasks were all timed
    expect(legacy?.title).toBe("legacy");
    store.retire("old1");
    store.purge("old1"); // the v2 carve-out works on migrated files
    expect(store.get("old1")).toBeNull();
    db.close();
    expect(() => openTasksDb(path)).not.toThrow(); // a second open is a plain v2 open
  });
});

describe("purge — the one path that removes history", () => {
  test("only a retired task; removes the row, its events, and its tag links; casual deletes stay blocked", () => {
    const db = openTasksDb(":memory:");
    const store = new TaskStore(db, () => T0);
    store.createTag("home");
    const t = store.create({ title: "x", intervalMs: DAY_MS, tags: ["home"] });
    expect(() => store.purge(t.id)).toThrow(/retired/);
    store.retire(t.id);
    expect(store.events(t.id).length).toBe(2);
    store.purge(t.id);
    expect(store.get(t.id)).toBeNull();
    expect(store.events(t.id)).toEqual([]);
    expect(store.tags()[0]?.count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS c FROM task_purges").get() as { c: number }).c).toBe(0);
    expect(() => store.purge(t.id)).toThrow(NotFound);
    // another task's log is untouched by the machinery
    const u = store.create({ title: "y", intervalMs: DAY_MS });
    expect(() => db.query("DELETE FROM task_events WHERE task_id = ?").run(u.id)).toThrow(
      /append-only/,
    );
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
    expect(store.get(b.id)?.dueAt).toBe(T0 + DAY_MS); // T0 is UTC noon, so the pin is a no-op
  });
});

describe("tags", () => {
  test("create / rename / delete; names unique case-insensitively; built-ins refused", () => {
    const store = new TaskStore(openTasksDb(":memory:"), () => T0);
    const home = store.createTag(" home ");
    expect(home.name).toBe("home");
    expect(() => store.createTag("HOME")).toThrow(/already exists/);
    expect(() => store.createTag("retired")).toThrow(/built-in/);
    const work = store.createTag("work");
    expect(store.tags().map((t) => t.name)).toEqual(["home", "work"]);
    expect(() => store.renameTag(work.id, "Home")).toThrow(/already exists/);
    expect(store.renameTag(work.id, "office").name).toBe("office");
    expect(() => store.renameTag(999, "x")).toThrow(NotFound);
    store.deleteTag(home.id);
    expect(store.tags().map((t) => t.name)).toEqual(["office"]);
    expect(() => store.deleteTag(home.id)).toThrow(NotFound);
  });

  test("assign by name (must exist), filter by user or derived tag, log the change", () => {
    const store = new TaskStore(openTasksDb(":memory:"), () => T0);
    store.createTag("home");
    store.createTag("errand");
    const a = store.create({ title: "a", intervalMs: 7 * DAY_MS, tags: ["home"] });
    const b = store.create({ title: "b", intervalMs: null, tags: ["home", "errand"] });
    const c = store.create({ title: "c", intervalMs: DAY_MS });
    expect(() => store.create({ title: "d", intervalMs: DAY_MS, tags: ["nope"] })).toThrow(
      /no such tag/,
    );
    expect(store.tagsOf(b.id)).toEqual(["errand", "home"]);
    expect(store.events(a.id)[0]?.detail.tags).toEqual(["home"]);
    expect(store.list("open", { tag: "home" }).map((t) => t.title)).toEqual(["b", "a"]); // soonest due first
    expect(store.list("open", { tag: "Errand" }).map((t) => t.title)).toEqual(["b"]);
    expect(store.list("open", { tag: "one-off" }).map((t) => t.title)).toEqual(["b"]);
    expect(store.list("open", { tag: "every 1 week" }).map((t) => t.title)).toEqual(["a"]);
    expect(store.list("all", { tag: "open" })).toHaveLength(3);
    expect(store.list("all", { tag: "retired" })).toHaveLength(0);
    expect(store.tags().map((t) => [t.name, t.count])).toEqual([
      ["errand", 1],
      ["home", 2],
    ]);
    // replace the set: logged as an edited event that touches no row column
    const before = store.events(c.id).length;
    expect(store.setTags(c.id, ["errand"])).toEqual(["errand"]);
    expect(store.setTags(c.id, ["errand"])).toEqual(["errand"]); // no-op
    expect(store.events(c.id).length).toBe(before + 1);
    expect(store.events(c.id).at(-1)?.detail).toEqual({ tags: ["errand"] });
    expect(store.tagsFor([a.id, b.id, c.id]).get(c.id)).toEqual(["errand"]);
    expect(store.systemTags()).toEqual([
      { name: "every 1 day", kind: "interval", count: 1 },
      { name: "every 1 week", kind: "interval", count: 1 },
      { name: "one-off", kind: "interval", count: 1 },
      { name: "open", kind: "status", count: 3 },
      { name: "retired", kind: "status", count: 0 },
    ]);
  });
});

describe("attention buckets follow the LOCAL day", () => {
  test("overdue / today / upcoming / later in a real zone", () => {
    // 2026-09-17T23:30Z is Sep 17 19:30 in Toronto but already Sep 18 in Tokyo.
    const now = Date.UTC(2026, 8, 17, 23, 30);
    const store = new TaskStore(openTasksDb(":memory:"), () => now);
    const timed = { hasTime: true };
    store.create({ title: "late", intervalMs: DAY_MS, dueAt: Date.UTC(2026, 8, 16, 12), ...timed });
    store.create({
      title: "tonight",
      intervalMs: DAY_MS,
      dueAt: Date.UTC(2026, 8, 18, 1),
      ...timed,
    });
    store.create({ title: "soon", intervalMs: DAY_MS, dueAt: now + 2 * DAY_MS, ...timed });
    store.create({ title: "far", intervalMs: DAY_MS, dueAt: now + 30 * DAY_MS, ...timed });
    const toronto = store.attention(3, "America/Toronto");
    expect(toronto.overdue.map((t) => t.title)).toEqual(["late"]);
    expect(toronto.today.map((t) => t.title)).toEqual(["tonight"]); // 01:00Z = 21:00 local, same day
    expect(toronto.upcoming.map((t) => t.title)).toEqual(["soon"]);
    expect(toronto.later.map((t) => t.title)).toEqual(["far"]);
    const tokyo = store.attention(3, "Asia/Tokyo");
    expect(tokyo.overdue.map((t) => t.title)).toEqual(["late"]);
    expect(tokyo.today.map((t) => t.title)).toEqual(["tonight"]); // now is already Sep 18 there
  });
});
