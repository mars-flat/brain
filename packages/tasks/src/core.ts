/**
 * Recurrence core (§16.2): pure state transitions over one task row and its
 * append-only event log. No I/O, no clock — `now` is always a parameter —
 * so every rule here is property-testable (§8.3) and byte-deterministic.
 * The one piece of environment is the zone, passed in: a date-only task
 * is pinned to local noon, and only Intl knows where noon is.
 *
 * The owner's rules, verbatim in code: the next occurrence is scheduled
 * only when the current one is closed (completed or cancelled); a late task
 * does nothing — no second instance, no pile-up; recurring until explicit
 * opt-out. Consequence: a task has at most one open occurrence, ever, so
 * there is no occurrence table — the row IS the open occurrence.
 */

import { DAY_MS, localDate, noonOf } from "./time.ts";

export const ANCHORS = ["completion", "due"] as const;
export type Anchor = (typeof ANCHORS)[number];

export const STATUSES = ["open", "retired"] as const;
export type TaskStatus = (typeof STATUSES)[number];

export const CLOSE_KINDS = ["completed", "cancelled"] as const;
export type CloseKind = (typeof CLOSE_KINDS)[number];

export const EVENT_KINDS = [
  "created",
  "completed",
  "cancelled",
  "rolled",
  "rescheduled",
  "edited",
  "retired",
  "reopened",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface Task {
  id: string;
  title: string;
  notes: string;
  /** Recurrence interval in ms; null = one-off (retires on close unless told otherwise). */
  intervalMs: number | null;
  /** Where the next occurrence is measured from (§16.2). */
  anchor: Anchor;
  status: TaskStatus;
  /** Unix ms. Non-null exactly when status is open — the one open occurrence. */
  dueAt: number | null;
  /** False = due on a day, not at a time; dueAt is then pinned to local noon. */
  hasTime: boolean;
  createdAt: number;
  updatedAt: number;
  /** When the last occurrence was closed (completed or cancelled). */
  lastClosedAt: number | null;
  /** Closes so far: completions + cancellations. */
  closes: number;
}

export interface TaskEvent {
  taskId: string;
  at: number;
  kind: EventKind;
  detail: Record<string, unknown>;
}

export interface CreateInput {
  title: string;
  notes?: string;
  intervalMs?: number | null;
  anchor?: Anchor;
  /** Unix ms. Default: now + interval (now + 1 day for a one-off). */
  dueAt?: number;
  /** Default false: a day, not a time (owner's call, 2026-09-18). */
  hasTime?: boolean;
}

export interface CloseOptions {
  /** Schedule again? Default: yes whenever the task has an interval — opt-out, not opt-in. */
  repeat?: boolean;
  /** Manual placement of the next occurrence (unix ms; today or later). */
  nextDueAt?: number;
  /** Whether the manual placement carries a time of day. Default: as the task. */
  nextHasTime?: boolean;
}

export interface EditPatch {
  title?: string;
  notes?: string;
  intervalMs?: number | null;
  anchor?: Anchor;
}

export interface Transition {
  task: Task;
  /** Zero events means nothing changed — callers skip the write. */
  events: TaskEvent[];
}

/** A rule violation the caller can show the user; anything else is a bug. */
export class TaskError extends Error {}

const TITLE_MAX = 200;
const NOTES_MAX = 4000;

function assertTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new TaskError("title is required");
  if (t.length > TITLE_MAX) throw new TaskError(`title too long (${TITLE_MAX} max)`);
  return t;
}

function assertNotes(notes: string | undefined): string {
  const n = (notes ?? "").trim();
  if (n.length > NOTES_MAX) throw new TaskError(`notes too long (${NOTES_MAX} max)`);
  return n;
}

function assertInterval(ms: number | null | undefined): number | null {
  if (ms == null) return null;
  if (!Number.isInteger(ms) || ms <= 0)
    throw new TaskError("interval must be a positive whole number of milliseconds");
  return ms;
}

function assertAnchor(anchor: string | undefined): Anchor {
  const a = anchor ?? "completion";
  if (!(ANCHORS as readonly string[]).includes(a))
    throw new TaskError(`anchor must be one of ${ANCHORS.join(", ")}`);
  return a as Anchor;
}

function assertInstant(ms: number, what: string): number {
  if (!Number.isFinite(ms) || ms < 0) throw new TaskError(`${what} is not a valid instant`);
  return Math.floor(ms);
}

/** A date-only occurrence lives at local noon; a timed one is exactly where it was put. */
function pin(at: number, hasTime: boolean, tz: string): number {
  return hasTime ? at : noonOf(at, tz);
}

/** Timed: strictly after now. Date-only: today or later — the day is the unit. */
export function isFuture(at: number, hasTime: boolean, now: number, tz: string): boolean {
  return hasTime ? at > now : localDate(at, tz) >= localDate(now, tz);
}

export function createTask(input: CreateInput, now: number, id: string, tz = "UTC"): Transition {
  const title = assertTitle(input.title);
  const notes = assertNotes(input.notes);
  const intervalMs = assertInterval(input.intervalMs);
  const anchor = assertAnchor(input.anchor);
  const hasTime = input.hasTime ?? false;
  const dueAt = pin(
    assertInstant(input.dueAt ?? now + (intervalMs ?? DAY_MS), "due date"),
    hasTime,
    tz,
  );
  const task: Task = {
    id,
    title,
    notes,
    intervalMs,
    anchor,
    status: "open",
    dueAt,
    hasTime,
    createdAt: now,
    updatedAt: now,
    lastClosedAt: null,
    closes: 0,
  };
  return {
    task,
    events: [
      {
        taskId: id,
        at: now,
        kind: "created",
        detail: { title, notes, intervalMs, anchor, dueAt, hasTime },
      },
    ],
  };
}

/** The next occurrence for a recurring task, per its anchor (§16.2). */
export function nextDue(task: Task, now: number, tz = "UTC"): number {
  if (task.intervalMs == null)
    throw new TaskError(
      "a one-off task has no next occurrence — pass a next due date or set an interval",
    );
  if (task.anchor === "completion" || task.dueAt == null)
    return pin(now + task.intervalMs, task.hasTime, tz);
  // Due-anchored: keep the cadence phase, but never land in the past — a
  // task late by several intervals advances to the FIRST future slot
  // (§16.2, question T-3). One pile-up-free step, never one per missed slot.
  let next = task.dueAt + task.intervalMs;
  if (next <= now) next += (Math.floor((now - next) / task.intervalMs) + 1) * task.intervalMs;
  return pin(next, task.hasTime, tz);
}

/**
 * Close the open occurrence as completed or cancelled, then either roll the
 * task to its next occurrence (the default whenever it has an interval) or
 * retire it. Both outcomes are two events at the same instant: the close,
 * then what became of the task.
 */
export function closeTask(
  task: Task,
  kind: CloseKind,
  opts: CloseOptions,
  now: number,
  tz = "UTC",
): Transition {
  if (task.status !== "open" || task.dueAt == null) throw new TaskError("task is not open");
  if (!(CLOSE_KINDS as readonly string[]).includes(kind))
    throw new TaskError(`close kind must be one of ${CLOSE_KINDS.join(", ")}`);
  const closed: TaskEvent = {
    taskId: task.id,
    at: now,
    kind,
    detail: { dueAt: task.dueAt, lateMs: Math.max(0, now - task.dueAt) },
  };
  const base: Task = { ...task, lastClosedAt: now, closes: task.closes + 1, updatedAt: now };
  const repeat = opts.repeat ?? task.intervalMs != null;
  if (!repeat) {
    return {
      task: { ...base, status: "retired", dueAt: null },
      events: [closed, { taskId: task.id, at: now, kind: "retired", detail: { reason: kind } }],
    };
  }
  let next: number;
  let manual = false;
  let hasTime = task.hasTime;
  if (opts.nextDueAt != null) {
    hasTime = opts.nextHasTime ?? task.hasTime;
    next = pin(assertInstant(opts.nextDueAt, "next due date"), hasTime, tz);
    if (!isFuture(next, hasTime, now, tz))
      throw new TaskError("the next occurrence must be in the future");
    manual = true;
  } else {
    next = nextDue(task, now, tz);
  }
  return {
    task: { ...base, dueAt: next, hasTime },
    events: [
      closed,
      {
        taskId: task.id,
        at: now,
        kind: "rolled",
        detail: { from: task.dueAt, to: next, anchor: task.anchor, manual, hasTime },
      },
    ],
  };
}

export function rescheduleTask(
  task: Task,
  dueAt: number,
  hasTime: boolean | undefined,
  now: number,
  tz = "UTC",
): Transition {
  if (task.status !== "open" || task.dueAt == null) throw new TaskError("task is not open");
  const ht = hasTime ?? task.hasTime;
  const to = pin(assertInstant(dueAt, "due date"), ht, tz);
  if (to === task.dueAt && ht === task.hasTime) return { task, events: [] };
  return {
    task: { ...task, dueAt: to, hasTime: ht, updatedAt: now },
    events: [
      {
        taskId: task.id,
        at: now,
        kind: "rescheduled",
        detail: { from: task.dueAt, to, hasTime: ht },
      },
    ],
  };
}

/** Edits never move the open occurrence — that is what reschedule is for. */
export function editTask(task: Task, patch: EditPatch, now: number): Transition {
  const next: Task = { ...task };
  const changed: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const t = assertTitle(patch.title);
    if (t !== task.title) {
      next.title = t;
      changed.title = t;
    }
  }
  if (patch.notes !== undefined) {
    const n = assertNotes(patch.notes);
    if (n !== task.notes) {
      next.notes = n;
      changed.notes = n;
    }
  }
  if (patch.intervalMs !== undefined) {
    const i = assertInterval(patch.intervalMs);
    if (i !== task.intervalMs) {
      next.intervalMs = i;
      changed.intervalMs = i;
    }
  }
  if (patch.anchor !== undefined) {
    const a = assertAnchor(patch.anchor);
    if (a !== task.anchor) {
      next.anchor = a;
      changed.anchor = a;
    }
  }
  if (Object.keys(changed).length === 0) return { task, events: [] };
  next.updatedAt = now;
  return {
    task: next,
    events: [{ taskId: task.id, at: now, kind: "edited", detail: { patch: changed } }],
  };
}

/** The explicit opt-out: no next occurrence, ever, until reopened. */
export function retireTask(task: Task, now: number): Transition {
  if (task.status !== "open") throw new TaskError("task is not open");
  return {
    task: { ...task, status: "retired", dueAt: null, updatedAt: now },
    events: [{ taskId: task.id, at: now, kind: "retired", detail: { reason: "manual" } }],
  };
}

export function reopenTask(
  task: Task,
  dueAt: number | undefined,
  hasTime: boolean | undefined,
  now: number,
  tz = "UTC",
): Transition {
  if (task.status !== "retired") throw new TaskError("task is not retired");
  const ht = hasTime ?? task.hasTime;
  const to = pin(assertInstant(dueAt ?? now + (task.intervalMs ?? DAY_MS), "due date"), ht, tz);
  return {
    task: { ...task, status: "open", dueAt: to, hasTime: ht, updatedAt: now },
    events: [{ taskId: task.id, at: now, kind: "reopened", detail: { to, hasTime: ht } }],
  };
}

/**
 * Replay the event log into the row it describes. The store's invariant
 * (§16.2, tested by property): `foldEvents(events(id))` equals `get(id)` —
 * the log is not a decoration, it is a second derivation of the truth.
 * Tag changes ride `edited` events too but touch no row column.
 */
export function foldEvents(events: TaskEvent[]): Task | null {
  let t: Task | null = null;
  for (const e of events) {
    const d = e.detail;
    if (e.kind === "created") {
      t = {
        id: e.taskId,
        title: String(d.title ?? ""),
        notes: String(d.notes ?? ""),
        intervalMs: (d.intervalMs as number | null | undefined) ?? null,
        anchor: (d.anchor as Anchor | undefined) ?? "completion",
        status: "open",
        dueAt: d.dueAt as number,
        // Events written before the field existed (schema v1) were all timed.
        hasTime: (d.hasTime as boolean | undefined) ?? true,
        createdAt: e.at,
        updatedAt: e.at,
        lastClosedAt: null,
        closes: 0,
      };
      continue;
    }
    if (!t) throw new TaskError(`event ${e.kind} before creation of ${e.taskId}`);
    switch (e.kind) {
      case "completed":
      case "cancelled":
        t = { ...t, lastClosedAt: e.at, closes: t.closes + 1, updatedAt: e.at };
        break;
      case "rolled":
      case "rescheduled":
        t = {
          ...t,
          dueAt: d.to as number,
          hasTime: (d.hasTime as boolean | undefined) ?? t.hasTime,
          updatedAt: e.at,
        };
        break;
      case "edited":
        t = { ...t, ...((d.patch as Partial<Task> | undefined) ?? {}), updatedAt: e.at };
        break;
      case "retired":
        t = { ...t, status: "retired", dueAt: null, updatedAt: e.at };
        break;
      case "reopened":
        t = {
          ...t,
          status: "open",
          dueAt: d.to as number,
          hasTime: (d.hasTime as boolean | undefined) ?? t.hasTime,
          updatedAt: e.at,
        };
        break;
      default:
        throw new TaskError(`unknown event kind ${String(e.kind)}`);
    }
  }
  return t;
}

// ── intervals as humans write them ────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: DAY_MS,
  day: DAY_MS,
  days: DAY_MS,
  w: 7 * DAY_MS,
  wk: 7 * DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
};

/** "10d", "2 weeks", "12h" → ms; "", "none", "one-off" → null. */
export function parseInterval(text: string | null | undefined): number | null {
  const s = (text ?? "").trim().toLowerCase();
  if (!s || s === "none" || s === "one-off" || s === "once" || s === "0") return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(s);
  const unit = m ? UNIT_MS[m[2] as string] : undefined;
  if (!m || !unit) throw new TaskError(`unreadable interval "${text}" — try 10d, 2w, 12h, or none`);
  const ms = Math.round(Number(m[1]) * unit);
  if (ms <= 0) throw new TaskError("interval must be positive");
  return ms;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

export function formatInterval(ms: number | null): string {
  if (ms == null) return "one-off";
  const WEEK = 7 * DAY_MS;
  if (ms % WEEK === 0) return plural(ms / WEEK, "week");
  if (ms % DAY_MS === 0) return plural(ms / DAY_MS, "day");
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour");
  return `${ms} ms`;
}

// ── tags (§16.2): user-named labels, plus derived ones that cannot be edited ──

/** The derived interval tag: "every 1 week", or "one-off". Also the chip text. */
export function intervalTag(intervalMs: number | null): string {
  return intervalMs == null ? "one-off" : `every ${formatInterval(intervalMs)}`;
}

/** The interval and status of a task render as tags too; these names are reserved. */
export function isReservedTagName(name: string): boolean {
  const s = name.trim().toLowerCase();
  return s === "open" || s === "retired" || s === "one-off" || /^every\s/.test(s);
}

const TAG_MAX = 40;

/** Trimmed, single-spaced, 1–40 chars, not a derived tag's name. */
export function normalizeTagName(name: string): string {
  const s = name.trim().replace(/\s+/g, " ");
  if (!s) throw new TaskError("tag name is required");
  if (s.length > TAG_MAX) throw new TaskError(`tag name too long (${TAG_MAX} max)`);
  if (isReservedTagName(s))
    throw new TaskError(`"${s}" is a built-in tag (intervals and statuses are tags already)`);
  return s;
}
