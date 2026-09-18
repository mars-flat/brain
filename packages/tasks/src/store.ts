/**
 * The tasks store (§16.3): its own SQLite file, never the vault. Source of
 * truth, not a cache — nothing rebuilds it, so the schema version is a
 * migration gate, not a "delete and regenerate" hint. WAL + busy_timeout
 * because two processes share the file: the console (the human's write
 * path) and the tasks MCP upstream (every Claude surface's).
 *
 * Every mutation is one transaction: read the row, run the pure transition
 * (core.ts), write the row, append its events. The event table is
 * append-only by trigger — the log is what makes "rescheduled four times"
 * answerable, and what a later projection into the brain would read.
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

export const SCHEMA_VERSION = 1;

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
CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
`;

export function openTasksDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const row = db.query("SELECT value FROM tasks_meta WHERE key = 'schema_version'").get() as {
    value: string;
  } | null;
  if (!row) {
    db.query("INSERT INTO tasks_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(
      `tasks.db schema_version ${row.value} != ${SCHEMA_VERSION} — this store is source of truth, not a cache (§16.3): migrate it, never delete it`,
    );
  }
  return db;
}

export class NotFound extends TaskError {}

export type ListFilter = TaskStatus | "all";

export interface Attention {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  later: Task[];
}

interface Row {
  id: string;
  title: string;
  notes: string;
  interval_ms: number | null;
  anchor: Anchor;
  status: TaskStatus;
  due_at: number | null;
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
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastClosedAt: r.last_closed_at,
  closes: r.closes,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class TaskStore {
  constructor(
    readonly db: Database,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  list(filter: ListFilter = "open"): Task[] {
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
    return rows.map(fromRow);
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

  create(input: CreateInput): Task {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const t = createTask(input, now, this.newId());
      this.write(t);
      return t.task;
    });
    return tx();
  }

  close(id: string, kind: CloseKind, opts: CloseOptions = {}): Task {
    return this.apply(id, (task, now) => closeTask(task, kind, opts, now));
  }

  reschedule(id: string, dueAt: number): Task {
    return this.apply(id, (task, now) => rescheduleTask(task, dueAt, now));
  }

  update(id: string, patch: EditPatch): Task {
    return this.apply(id, (task, now) => editTask(task, patch, now));
  }

  retire(id: string): Task {
    return this.apply(id, (task, now) => retireTask(task, now));
  }

  reopen(id: string, dueAt?: number): Task {
    return this.apply(id, (task, now) => reopenTask(task, dueAt, now));
  }

  /**
   * What needs attention (§16.4): open tasks bucketed by LOCAL day in `tz`.
   * Overdue = due on an earlier day; today = due today (before or after
   * now); upcoming = within the horizon; later = the rest.
   */
  attention(tz: string, horizonDays = 3): Attention {
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
        `INSERT INTO tasks (id, title, notes, interval_ms, anchor, status, due_at, created_at, updated_at, last_closed_at, closes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, notes = excluded.notes, interval_ms = excluded.interval_ms,
           anchor = excluded.anchor, status = excluded.status, due_at = excluded.due_at,
           updated_at = excluded.updated_at, last_closed_at = excluded.last_closed_at,
           closes = excluded.closes`,
      )
      .run(
        x.id,
        x.title,
        x.notes,
        x.intervalMs,
        x.anchor,
        x.status,
        x.dueAt,
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
