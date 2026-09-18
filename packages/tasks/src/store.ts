/**
 * The tasks store (§16.3): its own SQLite file, never the vault. Source of
 * truth, not a cache — nothing rebuilds it, so the schema version is a
 * migration gate with real migrations, never "delete and regenerate". WAL
 * + busy_timeout because two processes share the file: the console (the
 * human's write path) and the tasks MCP upstream (every Claude surface's).
 *
 * Every mutation is one transaction: read the row, run the pure transition
 * (core.ts), write the row, append its events. The event table is
 * append-only by trigger, with one carve-out: permanently deleting a
 * RETIRED task (a purge) removes the task and its own log together — the
 * trigger admits deletes only while that task's purge is in flight.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Anchor,
  type CloseKind,
  type CloseOptions,
  type CreateInput,
  closeTask,
  createTask,
  type EditPatch,
  type EventKind,
  editTask,
  intervalTag,
  normalizeTagName,
  reopenTask,
  rescheduleTask,
  retireTask,
  type Task,
  TaskError,
  type TaskEvent,
  type TaskStatus,
  type Transition,
} from "./core.ts";
import { DAY_MS, localDate } from "./time.ts";

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  interval_ms    INTEGER,
  anchor         TEXT NOT NULL CHECK (anchor IN ('completion', 'due')),
  status         TEXT NOT NULL CHECK (status IN ('open', 'retired')),
  due_at         INTEGER,
  has_time       INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_closed_at INTEGER,
  closes         INTEGER NOT NULL DEFAULT 0,
  -- The one-open-occurrence rule, enforced by the database itself (§16.2).
  CHECK ((status = 'open') = (due_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tasks_open_due ON tasks (status, due_at);
CREATE TABLE IF NOT EXISTS task_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  at      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, id);
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
-- A purge in flight, keyed by task: the only state in which that task's
-- events may be deleted. Rows live for the duration of one transaction.
CREATE TABLE IF NOT EXISTS task_purges (task_id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_events_no_delete_v2 BEFORE DELETE ON task_events
WHEN NOT EXISTS (SELECT 1 FROM task_purges WHERE task_id = OLD.task_id)
BEGIN SELECT RAISE(ABORT, 'task_events is append-only — only purging a retired task removes its log'); END;
`;

/** v1 → v2 (2026-09-18): date-only tasks, tags, and the purge carve-out. */
function migrateV1(db: Database): void {
  db.exec("ALTER TABLE tasks ADD COLUMN has_time INTEGER NOT NULL DEFAULT 1");
  db.exec("DROP TRIGGER IF EXISTS task_events_no_delete");
  db.exec(SCHEMA);
  db.query("UPDATE tasks_meta SET value = ? WHERE key = 'schema_version'").run("2");
}

export function openTasksDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS tasks_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.query("SELECT value FROM tasks_meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  const version = row ? Number(row.value) : null;
  if (version === null) {
    db.exec(SCHEMA);
    db.query("INSERT INTO tasks_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  } else if (version === 1) {
    db.transaction(() => migrateV1(db))();
  } else if (version === SCHEMA_VERSION) {
    db.exec(SCHEMA);
  } else {
    throw new Error(
      `tasks.db schema_version ${version} != ${SCHEMA_VERSION} — this store is source of truth, not a cache (§16.3): migrate it, never delete it`,
    );
  }
  return db;
}

export class NotFound extends TaskError {}

export type ListFilter = TaskStatus | "all";

export interface ListOptions {
  /** A user tag's name, or a derived one ("every 1 week", "one-off", "open", "retired"). */
  tag?: string;
}

export interface Attention {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  later: Task[];
}

export interface Tag {
  id: number;
  name: string;
  /** Tasks carrying it. */
  count: number;
}

export interface SystemTag {
  name: string;
  kind: "interval" | "status";
  count: number;
}

interface Row {
  id: string;
  title: string;
  notes: string;
  interval_ms: number | null;
  anchor: Anchor;
  status: TaskStatus;
  due_at: number | null;
  has_time: number;
  created_at: number;
  updated_at: number;
  last_closed_at: number | null;
  closes: number;
}

interface EventRow {
  task_id: string;
  at: number;
  kind: EventKind;
  detail: string;
}

const fromRow = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  intervalMs: r.interval_ms,
  anchor: r.anchor,
  status: r.status,
  dueAt: r.due_at,
  hasTime: r.has_time !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastClosedAt: r.last_closed_at,
  closes: r.closes,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export class TaskStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
    /** The zone date-only tasks are pinned in and days are counted in (§16.3). */
    readonly tz: string = "UTC",
  ) {}

  list(filter: ListFilter = "open", opts: ListOptions = {}): Task[] {
    const rows =
      filter === "all"
        ? (this.db
            .query("SELECT * FROM tasks ORDER BY status ASC, due_at ASC, updated_at DESC, id ASC")
            .all() as Row[])
        : filter === "open"
          ? (this.db
              .query("SELECT * FROM tasks WHERE status = 'open' ORDER BY due_at ASC, id ASC")
              .all() as Row[])
          : (this.db
              .query(
                "SELECT * FROM tasks WHERE status = 'retired' ORDER BY updated_at DESC, id ASC",
              )
              .all() as Row[]);
    const tasks = rows.map(fromRow);
    const tag = opts.tag?.trim();
    if (!tag) return tasks;
    const lower = tag.toLowerCase();
    if (lower === "open" || lower === "retired") return tasks.filter((t) => t.status === lower);
    if (lower === "one-off" || lower.startsWith("every "))
      return tasks.filter((t) => intervalTag(t.intervalMs).toLowerCase() === lower);
    const byTask = this.tagsFor(tasks.map((t) => t.id));
    return tasks.filter((t) => (byTask.get(t.id) ?? []).some((n) => n.toLowerCase() === lower));
  }

  get(id: string): Task | null {
    if (!ID_RE.test(id)) return null;
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
    return row ? fromRow(row) : null;
  }

  /** The full log for one task, oldest first. */
  events(id: string): TaskEvent[] {
    const rows = this.db
      .query("SELECT task_id, at, kind, detail FROM task_events WHERE task_id = ? ORDER BY id ASC")
      .all(id) as EventRow[];
    return rows.map((r) => ({
      taskId: r.task_id,
      at: r.at,
      kind: r.kind,
      detail: JSON.parse(r.detail) as Record<string, unknown>,
    }));
  }

  counts(): { open: number; retired: number } {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status")
      .all() as Array<{ status: TaskStatus; c: number }>;
    const out = { open: 0, retired: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  create(input: CreateInput & { tags?: string[] }): Task {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const t = createTask(input, now, this.newId(), this.tz);
      const names = input.tags ? this.resolveTags(input.tags) : [];
      if (names.length) (t.events[0] as TaskEvent).detail.tags = names.map((n) => n.name);
      this.write(t);
      for (const n of names)
        this.db.query("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)").run(t.task.id, n.id);
      return t.task;
    });
    return tx();
  }

  close(id: string, kind: CloseKind, opts: CloseOptions = {}): Task {
    return this.apply(id, (task, now) => closeTask(task, kind, opts, now, this.tz));
  }

  reschedule(id: string, dueAt: number, hasTime?: boolean): Task {
    return this.apply(id, (task, now) => rescheduleTask(task, dueAt, hasTime, now, this.tz));
  }

  update(id: string, patch: EditPatch): Task {
    return this.apply(id, (task, now) => editTask(task, patch, now));
  }

  retire(id: string): Task {
    return this.apply(id, (task, now) => retireTask(task, now));
  }

  reopen(id: string, dueAt?: number, hasTime?: boolean): Task {
    return this.apply(id, (task, now) => reopenTask(task, dueAt, hasTime, now, this.tz));
  }

  /**
   * Permanently delete a RETIRED task with its history and tag links. The
   * only path that removes event rows; an open task must be retired first.
   */
  purge(id: string): void {
    const tx = this.db.transaction(() => {
      const task = this.get(id);
      if (!task) throw new NotFound(`no task ${id}`);
      if (task.status !== "retired") throw new TaskError("only a retired task can be deleted");
      this.db.query("INSERT INTO task_purges (task_id) VALUES (?)").run(id);
      this.db.query("DELETE FROM task_tags WHERE task_id = ?").run(id);
      this.db.query("DELETE FROM task_events WHERE task_id = ?").run(id);
      this.db.query("DELETE FROM tasks WHERE id = ?").run(id);
      this.db.query("DELETE FROM task_purges WHERE task_id = ?").run(id);
    });
    tx();
  }

  /**
   * What needs attention (§16.4): open tasks bucketed by LOCAL day in the
   * store's zone. Overdue = due on an earlier day; today = due today
   * (before or after now); upcoming = within the horizon; later = the rest.
   */
  attention(horizonDays = 3, tz = this.tz): Attention {
    const now = this.now();
    const today = localDate(now, tz);
    const horizon = now + horizonDays * DAY_MS;
    const out: Attention = { overdue: [], today: [], upcoming: [], later: [] };
    for (const t of this.list("open")) {
      const due = t.dueAt as number;
      const day = localDate(due, tz);
      if (day < today) out.overdue.push(t);
      else if (day === today) out.today.push(t);
      else if (due <= horizon) out.upcoming.push(t);
      else out.later.push(t);
    }
    return out;
  }

  // ── tags ──────────────────────────────────────────────────────────────

  /** User tags with usage counts, alphabetical. */
  tags(): Tag[] {
    return this.db
      .query(
        `SELECT t.id, t.name, COUNT(tt.task_id) AS count
         FROM tags t LEFT JOIN task_tags tt ON tt.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE ASC`,
      )
      .all() as Tag[];
  }

  /** Derived tags: every interval in use and both statuses, with counts. Read-only. */
  systemTags(): SystemTag[] {
    const all = this.list("all");
    const intervals = new Map<string, number>();
    const status = { open: 0, retired: 0 };
    for (const t of all) {
      const name = intervalTag(t.intervalMs);
      intervals.set(name, (intervals.get(name) ?? 0) + 1);
      status[t.status] += 1;
    }
    const out: SystemTag[] = [...intervals]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, kind: "interval", count }));
    out.push({ name: "open", kind: "status", count: status.open });
    out.push({ name: "retired", kind: "status", count: status.retired });
    return out;
  }

  createTag(name: string): Tag {
    const n = normalizeTagName(name);
    if (this.tagByName(n)) throw new TaskError(`tag "${n}" already exists`);
    const row = this.db
      .query("INSERT INTO tags (name, created_at) VALUES (?, ?) RETURNING id, name")
      .get(n, this.now()) as { id: number; name: string };
    return { ...row, count: 0 };
  }

  renameTag(id: number, name: string): Tag {
    const n = normalizeTagName(name);
    const existing = this.tagByName(n);
    if (existing && existing.id !== id) throw new TaskError(`tag "${n}" already exists`);
    const res = this.db.query("UPDATE tags SET name = ? WHERE id = ?").run(n, id);
    if (res.changes === 0) throw new NotFound(`no tag ${id}`);
    return this.tags().find((t) => t.id === id) as Tag;
  }

  /** Removes the tag from every task it was on. Derived tags cannot be deleted — they are not rows. */
  deleteTag(id: number): void {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM task_tags WHERE tag_id = ?").run(id);
      const res = this.db.query("DELETE FROM tags WHERE id = ?").run(id);
      if (res.changes === 0) throw new NotFound(`no tag ${id}`);
    });
    tx();
  }

  tagsOf(id: string): string[] {
    return this.tagsFor([id]).get(id) ?? [];
  }

  /** User tag names per task, alphabetical, for a batch of ids. */
  tagsFor(ids: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const rows = this.db
      .query(
        `SELECT tt.task_id, t.name FROM task_tags tt JOIN tags t ON t.id = tt.tag_id
         WHERE tt.task_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name COLLATE NOCASE ASC`,
      )
      .all(...ids) as Array<{ task_id: string; name: string }>;
    for (const r of rows) out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.name]);
    return out;
  }

  /** Replace a task's user tags. Every name must already exist — the tag list is managed elsewhere. */
  setTags(id: string, names: string[]): string[] {
    const now = this.now();
    const tx = this.db.transaction(() => {
      if (!this.get(id)) throw new NotFound(`no task ${id}`);
      const wanted = this.resolveTags(names);
      const current = this.tagsOf(id);
      const next = wanted.map((t) => t.name);
      if (sameSet(current, next)) return current;
      this.db.query("DELETE FROM task_tags WHERE task_id = ?").run(id);
      for (const t of wanted)
        this.db.query("INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)").run(id, t.id);
      this.db.query("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, id);
      this.db
        .query("INSERT INTO task_events (task_id, at, kind, detail) VALUES (?, ?, 'edited', ?)")
        .run(id, now, JSON.stringify({ tags: next.slice().sort() }));
      return next;
    });
    return tx();
  }

  private tagByName(name: string): { id: number; name: string } | null {
    return this.db.query("SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE").get(name) as {
      id: number;
      name: string;
    } | null;
  }

  private resolveTags(names: string[]): Array<{ id: number; name: string }> {
    const seen = new Set<string>();
    const out: Array<{ id: number; name: string }> = [];
    for (const raw of names) {
      const n = raw.trim();
      if (!n || seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      const row = this.tagByName(n);
      if (!row) throw new TaskError(`no such tag "${n}" — create it in the tags section first`);
      out.push(row);
    }
    return out;
  }

  private apply(id: string, fn: (task: Task, now: number) => Transition): Task {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const task = this.get(id);
      if (!task) throw new NotFound(`no task ${id}`);
      const t = fn(task, now);
      if (t.events.length === 0) return task;
      this.write(t);
      return t.task;
    });
    return tx();
  }

  private write(t: Transition): void {
    const x = t.task;
    this.db
      .query(
        `INSERT INTO tasks (id, title, notes, interval_ms, anchor, status, due_at, has_time, created_at, updated_at, last_closed_at, closes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, notes = excluded.notes, interval_ms = excluded.interval_ms,
           anchor = excluded.anchor, status = excluded.status, due_at = excluded.due_at,
           has_time = excluded.has_time, updated_at = excluded.updated_at,
           last_closed_at = excluded.last_closed_at, closes = excluded.closes`,
      )
      .run(
        x.id,
        x.title,
        x.notes,
        x.intervalMs,
        x.anchor,
        x.status,
        x.dueAt,
        x.hasTime ? 1 : 0,
        x.createdAt,
        x.updatedAt,
        x.lastClosedAt,
        x.closes,
      );
    const ins = this.db.query(
      "INSERT INTO task_events (task_id, at, kind, detail) VALUES (?, ?, ?, ?)",
    );
    for (const e of t.events) ins.run(e.taskId, e.at, e.kind, JSON.stringify(e.detail));
  }
}
