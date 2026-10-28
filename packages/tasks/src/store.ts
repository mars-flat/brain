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
import {
  type DismissReason,
  type DuplicateLookup,
  findDuplicate,
  foldIntoProposal,
  isStale,
  markAccepted,
  markDismissed,
  markRestored,
  newProposal,
  type Proposal,
  type ProposalKind,
  type ProposalSource,
  type ProposalSourceRow,
  type ProposalStatus,
  type ProposeInput,
  type ProposeResult,
  validatePropose,
} from "./proposals.ts";
import { DAY_MS, dayBounds, localDate } from "./time.ts";

export const SCHEMA_VERSION = 3;

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
-- Proposed tasks (§16.8, schema v3): a second list, not tasks. task_id is
-- deliberately NOT a foreign key — purge nulls it rather than failing.
CREATE TABLE IF NOT EXISTS task_proposals (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL CHECK (kind IN ('university', 'job', 'subscription', 'other')),
  entity         TEXT NOT NULL,
  entity_norm    TEXT NOT NULL,
  thread_key     TEXT,
  due_at         INTEGER,
  has_time       INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL,
  confidence     REAL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed')),
  dismiss_reason TEXT CHECK (dismiss_reason IS NULL OR dismiss_reason IN ('owner', 'stale', 'duplicate')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  task_id        TEXT,
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK ((status = 'dismissed') = (dismiss_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS task_proposals_status ON task_proposals (status, created_at);
CREATE INDEX IF NOT EXISTS task_proposals_entity ON task_proposals (entity_norm, status);
CREATE INDEX IF NOT EXISTS task_proposals_thread ON task_proposals (thread_key);
-- Every message that fed a proposal, folds included: the message-key net.
CREATE TABLE IF NOT EXISTS proposal_sources (
  dedupe_key  TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES task_proposals(id),
  subject     TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proposal_sources_proposal ON proposal_sources (proposal_id);
`;

/** v1 → v2 (2026-09-18): date-only tasks, tags, and the purge carve-out. */
function migrateV1(db: Database): void {
  db.exec("ALTER TABLE tasks ADD COLUMN has_time INTEGER NOT NULL DEFAULT 1");
  db.exec("DROP TRIGGER IF EXISTS task_events_no_delete");
  db.exec(SCHEMA);
  db.query("UPDATE tasks_meta SET value = ? WHERE key = 'schema_version'").run("2");
}

/** v2 → v3 (2026-10-28): the proposals tables. Additive — every statement is IF NOT EXISTS. */
function migrateV2(db: Database): void {
  db.exec(SCHEMA);
  db.query("UPDATE tasks_meta SET value = ? WHERE key = 'schema_version'").run("3");
}

/** The chain: each step takes the file one version forward; a v1 file runs both. */
const MIGRATIONS: Record<number, (db: Database) => void> = { 1: migrateV1, 2: migrateV2 };

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
  } else if (version === SCHEMA_VERSION) {
    db.exec(SCHEMA);
  } else if (version >= 1 && version < SCHEMA_VERSION) {
    db.transaction(() => {
      for (let v = version; v < SCHEMA_VERSION; v++) (MIGRATIONS[v] as (db: Database) => void)(db);
    })();
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

/** An occurrence closed today (§16.4's done column): the event, and the task as it is now. */
export interface Closed {
  task: Task;
  at: number;
  kind: CloseKind;
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

export type ProposalFilter = ProposalStatus | "all";

export interface ProposalListOptions {
  kind?: ProposalKind;
  /** Only rows resolved at or after this instant (unix ms). */
  resolvedSince?: number;
}

interface ProposalRow {
  id: string;
  title: string;
  notes: string;
  kind: ProposalKind;
  entity: string;
  entity_norm: string;
  thread_key: string | null;
  due_at: number | null;
  has_time: number;
  source: string;
  confidence: number | null;
  status: ProposalStatus;
  dismiss_reason: DismissReason | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  task_id: string | null;
}

const proposalFromRow = (r: ProposalRow): Proposal => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  kind: r.kind,
  entity: r.entity,
  entityNorm: r.entity_norm,
  threadKey: r.thread_key,
  dueAt: r.due_at,
  hasTime: r.has_time !== 0,
  source: JSON.parse(r.source) as ProposalSource,
  confidence: r.confidence,
  status: r.status,
  dismissReason: r.dismiss_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  resolvedAt: r.resolved_at,
  taskId: r.task_id,
});

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
      // A proposal that became this task keeps its history; the pointer goes.
      this.db.query("UPDATE task_proposals SET task_id = NULL WHERE task_id = ?").run(id);
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

  /**
   * Occurrences closed during the LOCAL day of now (§16.4): the done column
   * of the board. Read straight from the event log — "done" and "skipped"
   * are events, not states (§16.2) — newest first, each with the task as
   * it stands now (rolled to its next due, or retired). A purged task has
   * no events left, so nothing here can dangle.
   */
  closedToday(tz = this.tz): Closed[] {
    const { start, end } = dayBounds(this.now(), tz);
    const rows = this.db
      .query(
        `SELECT task_id, at, kind, detail FROM task_events
         WHERE kind IN ('completed', 'cancelled') AND at >= ? AND at < ?
         ORDER BY at DESC, id DESC`,
      )
      .all(start, end) as EventRow[];
    const out: Closed[] = [];
    for (const r of rows) {
      const task = this.get(r.task_id);
      if (task) out.push({ task, at: r.at, kind: r.kind as CloseKind });
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

  // ── proposals (§16.8) ─────────────────────────────────────────────────

  /** Pending newest first; resolved ones most recently resolved first. */
  proposals(filter: ProposalFilter = "pending", opts: ProposalListOptions = {}): Proposal[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter !== "all") {
      where.push("status = ?");
      args.push(filter);
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.resolvedSince != null) {
      where.push("resolved_at >= ?");
      args.push(opts.resolvedSince);
    }
    const sql = `SELECT * FROM task_proposals${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(resolved_at, created_at) DESC, created_at DESC, id ASC`;
    return (this.db.query(sql).all(...args) as ProposalRow[]).map(proposalFromRow);
  }

  proposal(id: string): Proposal | null {
    if (!ID_RE.test(id)) return null;
    const row = this.db
      .query("SELECT * FROM task_proposals WHERE id = ?")
      .get(id) as ProposalRow | null;
    return row ? proposalFromRow(row) : null;
  }

  proposalSources(id: string): ProposalSourceRow[] {
    const rows = this.db
      .query(
        "SELECT proposal_id, dedupe_key, subject, received_at FROM proposal_sources WHERE proposal_id = ? ORDER BY received_at ASC, dedupe_key ASC",
      )
      .all(id) as Array<{
      proposal_id: string;
      dedupe_key: string;
      subject: string;
      received_at: number;
    }>;
    return rows.map((r) => ({
      proposalId: r.proposal_id,
      dedupeKey: r.dedupe_key,
      subject: r.subject,
      receivedAt: r.received_at,
    }));
  }

  proposalCounts(): Record<ProposalStatus, number> {
    const rows = this.db
      .query("SELECT status, COUNT(*) AS c FROM task_proposals GROUP BY status")
      .all() as Array<{ status: ProposalStatus; c: number }>;
    const out: Record<ProposalStatus, number> = { pending: 0, accepted: 0, dismissed: 0 };
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  /**
   * Add to the proposed list, or discover it is already there. Never errors
   * on a duplicate: the result says what it matched and why, so the caller
   * can log it and the audit can show it. One transaction, so two callers
   * racing on the same key cannot both create (the key is a primary key).
   */
  propose(input: ProposeInput): ProposeResult {
    const now = this.now();
    const c = validatePropose(input);
    const tx = this.db.transaction((): ProposeResult => {
      const keyRow = this.db
        .query("SELECT proposal_id FROM proposal_sources WHERE dedupe_key = ?")
        .get(c.dedupeKey) as { proposal_id: string } | null;
      const found: DuplicateLookup = {
        byKey: keyRow ? this.proposal(keyRow.proposal_id) : null,
        byThread: c.threadKey
          ? (
              this.db
                .query(
                  "SELECT * FROM task_proposals WHERE thread_key = ? ORDER BY created_at DESC, id ASC",
                )
                .all(c.threadKey) as ProposalRow[]
            ).map(proposalFromRow)
          : [],
        byEntity: (
          this.db
            .query(
              "SELECT * FROM task_proposals WHERE entity_norm = ? ORDER BY created_at DESC, id ASC",
            )
            .all(c.entityNorm) as ProposalRow[]
        ).map(proposalFromRow),
      };
      const verdict = findDuplicate(c, found, now);
      if (verdict?.action === "duplicate")
        return { outcome: "duplicate", reason: verdict.reason, proposal: verdict.row };
      if (verdict?.action === "fold") {
        const folded = foldIntoProposal(verdict.row, c, now, this.tz);
        this.writeProposal(folded);
        this.addSource(folded.id, c, now);
        return { outcome: "folded", proposal: folded };
      }
      const p = newProposal(c, now, this.newId());
      this.writeProposal(p);
      this.addSource(p.id, c, now);
      return { outcome: "created", proposal: p };
    });
    return tx();
  }

  /**
   * The human's yes: the ordinary create, every rule intact, and the row
   * flipped to accepted — one transaction, so a refused create leaves the
   * proposal exactly as it was.
   */
  acceptProposal(
    id: string,
    input: Partial<CreateInput> & { tags?: string[] } = {},
  ): { task: Task; proposal: Proposal } {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const p = this.proposal(id);
      if (!p) throw new NotFound(`no proposal ${id}`);
      if (p.status !== "pending") throw new TaskError(`proposal is ${p.status}, not pending`);
      const task = this.create({
        title: input.title ?? p.title,
        notes: input.notes ?? p.notes,
        intervalMs: input.intervalMs ?? null,
        anchor: input.anchor,
        dueAt: input.dueAt ?? p.dueAt ?? undefined,
        hasTime: input.hasTime ?? (input.dueAt == null ? p.hasTime : undefined),
        tags: input.tags,
      });
      const accepted = markAccepted(p, task.id, now);
      this.writeProposal(accepted);
      return { task, proposal: accepted };
    });
    return tx();
  }

  dismissProposal(id: string, reason: DismissReason = "owner"): Proposal {
    return this.applyProposal(id, (p, now) => markDismissed(p, reason, now));
  }

  restoreProposal(id: string): Proposal {
    return this.applyProposal(id, (p, now) => markRestored(p, now));
  }

  /** The manual trim (Q16): dismiss every pending proposal older than `days`. Returns how many. */
  dismissStaleProposals(days = 7): number {
    const now = this.now();
    const tx = this.db.transaction(() => {
      let n = 0;
      for (const p of this.proposals("pending")) {
        if (!isStale(p, now, days)) continue;
        this.writeProposal(markDismissed(p, "stale", now));
        n++;
      }
      return n;
    });
    return tx();
  }

  private applyProposal(id: string, fn: (p: Proposal, now: number) => Proposal): Proposal {
    const now = this.now();
    const tx = this.db.transaction(() => {
      const p = this.proposal(id);
      if (!p) throw new NotFound(`no proposal ${id}`);
      const next = fn(p, now);
      this.writeProposal(next);
      return next;
    });
    return tx();
  }

  private addSource(
    proposalId: string,
    c: { dedupeKey: string; subject: string; receivedAt: number | null },
    now: number,
  ): void {
    this.db
      .query(
        "INSERT INTO proposal_sources (dedupe_key, proposal_id, subject, received_at) VALUES (?, ?, ?, ?)",
      )
      .run(c.dedupeKey, proposalId, c.subject, c.receivedAt ?? now);
  }

  private writeProposal(p: Proposal): void {
    this.db
      .query(
        `INSERT INTO task_proposals (id, title, notes, kind, entity, entity_norm, thread_key, due_at, has_time, source, confidence, status, dismiss_reason, created_at, updated_at, resolved_at, task_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, notes = excluded.notes, kind = excluded.kind,
           entity = excluded.entity, entity_norm = excluded.entity_norm, thread_key = excluded.thread_key,
           due_at = excluded.due_at, has_time = excluded.has_time, source = excluded.source,
           confidence = excluded.confidence, status = excluded.status, dismiss_reason = excluded.dismiss_reason,
           updated_at = excluded.updated_at, resolved_at = excluded.resolved_at, task_id = excluded.task_id`,
      )
      .run(
        p.id,
        p.title,
        p.notes,
        p.kind,
        p.entity,
        p.entityNorm,
        p.threadKey,
        p.dueAt,
        p.hasTime ? 1 : 0,
        JSON.stringify(p.source),
        p.confidence,
        p.status,
        p.dismissReason,
        p.createdAt,
        p.updatedAt,
        p.resolvedAt,
        p.taskId,
      );
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
