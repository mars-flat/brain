/**
 * Proposed tasks (§16.8): a second list in the store that anything behind
 * the gateway can add to — the mail tick, a Claude session, a future
 * adapter — and that only a human promotes to a task. Pure transitions and
 * the duplicate nets live here; the store (store.ts) does the lookups and
 * the transaction around them.
 *
 * A proposal is NOT a task: no event log, never in `due`/`list`, never on
 * the board, never auto-promoted. Accepting one runs the ordinary
 * `createTask` with every rule intact; dismissing one keeps the row, because
 * the row is what stops the same thing from coming back.
 *
 * Duplicates are decided by exact identity, never by string similarity —
 * measured on real task titles, trigram Jaccard scored true duplicates at
 * 0.29 and 0.02 and a *different* assignment at 0.67 (2026-10-28). Three
 * nets: the message key (the same mail twice), the thread key (a reply or
 * reminder in the same thread), and the caller-supplied canonical entity
 * ("cs348 a3", "shopify interview", "netflix") within a window.
 */

import { assertNotes, assertTitle, type Task, TaskError } from "./core.ts";
import { DAY_MS, localDate } from "./time.ts";

export const PROPOSAL_KINDS = ["university", "job", "subscription", "other"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const DISMISS_REASONS = ["owner", "stale", "duplicate"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** Where a proposal came from. `kind` names the source family ("gmail", "session"); the rest is free. */
export type ProposalSource = { kind: string } & Record<string, unknown>;

export interface Proposal {
  id: string;
  title: string;
  notes: string;
  kind: ProposalKind;
  /** The caller's canonical identifier, as given. */
  entity: string;
  /** Lowercased, non-alphanumerics collapsed to one space — the equality key. */
  entityNorm: string;
  /** "gmail:<server>:<thread_id>" or null. */
  threadKey: string | null;
  /** The caller's guess; the human confirms it on accept. */
  dueAt: number | null;
  hasTime: boolean;
  source: ProposalSource;
  /** 0–1 from a model, null from a human. Sorts, never displays. */
  confidence: number | null;
  status: ProposalStatus;
  dismissReason: DismissReason | null;
  createdAt: number;
  /** Bumped when a follow-up folds into the row. */
  updatedAt: number;
  resolvedAt: number | null;
  /** The task an accepted proposal became; nulled if that task is purged. */
  taskId: string | null;
}

/** One message (or other unit) that fed a proposal, folds included. */
export interface ProposalSourceRow {
  proposalId: string;
  dedupeKey: string;
  subject: string;
  receivedAt: number;
}

export interface ProposeInput {
  title: string;
  kind: ProposalKind;
  entity: string;
  /** "gmail:<server>:<message_id>" or any caller-unique key. */
  dedupeKey: string;
  source: ProposalSource;
  threadKey?: string | null;
  notes?: string;
  dueAt?: number | null;
  hasTime?: boolean;
  confidence?: number | null;
}

/** The validated, normalized form of a ProposeInput. */
export interface ProposeCandidate {
  title: string;
  notes: string;
  kind: ProposalKind;
  entity: string;
  entityNorm: string;
  dedupeKey: string;
  threadKey: string | null;
  source: ProposalSource;
  dueAt: number | null;
  hasTime: boolean;
  confidence: number | null;
  /** From the source when it carries one, for the sources table and fold lines. */
  subject: string;
  receivedAt: number | null;
}

export type DuplicateReason = "key" | "accepted" | "dismissed";

export type ProposeResult =
  | { outcome: "created"; proposal: Proposal }
  | { outcome: "folded"; proposal: Proposal }
  | { outcome: "duplicate"; reason: DuplicateReason; proposal: Proposal };

const ENTITY_MAX = 120;
const KEY_MAX = 200;
const SOURCE_MAX = 2000;
export const NOTES_MAX = 4000;

/** How long an accepted or owner-dismissed row keeps suppressing its thread and entity (Q17: 3 months for subscriptions). */
export const ENTITY_WINDOW_MS: Record<ProposalKind, number> = {
  subscription: 90 * DAY_MS,
  university: 60 * DAY_MS,
  job: 60 * DAY_MS,
  other: 60 * DAY_MS,
};

/**
 * The equality key: lowercase alphanumerics only, so "CS348 A3", "cs-348 a3"
 * and "CS 348 / A3" are one entity. Spaces are dropped too — spacing is
 * exactly the kind of thing two mails disagree on.
 */
const ENTITY_ALIASES: Record<string, string> = {
  assignment: "a",
  assignments: "a",
  asst: "a",
  asgn: "a",
  homework: "hw",
  quiz: "q",
  quizzes: "q",
  tutorial: "t",
  tut: "t",
  lecture: "lec",
  project: "p",
  proj: "p",
  problem: "ps",
  set: "",
  due: "",
  deadline: "",
  the: "",
  for: "",
  of: "",
  and: "",
  updated: "",
  update: "",
  reminder: "",
};

/**
 * The equality key: lowercase alphanumerics only, so "CS348 A3", "cs-348 a3"
 * and "CS 348 / A3" are one entity, and course-work words collapse to the
 * form models most often choose — "STAT 231 Assignment 1", "stat231 asst 1"
 * and "stat231 a1" are all `stat231a1` (first live dry run, 2026-10-28:
 * one assignment spelled five ways across five mails). Spaces are dropped
 * too — spacing is exactly the kind of thing two mails disagree on.
 */
export function normalizeEntity(entity: string): string {
  return entity
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((tok) => ENTITY_ALIASES[tok] ?? tok)
    .join("");
}

function assertKey(value: unknown, what: string, required: boolean): string | null {
  if (value == null || value === "") {
    if (required) throw new TaskError(`${what} is required`);
    return null;
  }
  if (typeof value !== "string") throw new TaskError(`${what} must be a string`);
  const s = value.trim();
  if (!s) {
    if (required) throw new TaskError(`${what} is required`);
    return null;
  }
  if (s.length > KEY_MAX) throw new TaskError(`${what} too long (${KEY_MAX} max)`);
  return s;
}

export function validatePropose(input: ProposeInput): ProposeCandidate {
  const title = assertTitle(input.title ?? "");
  const notes = assertNotes(input.notes);
  if (!(PROPOSAL_KINDS as readonly string[]).includes(input.kind))
    throw new TaskError(`kind must be one of ${PROPOSAL_KINDS.join(", ")}`);
  if (typeof input.entity !== "string") throw new TaskError("entity is required");
  const entity = input.entity.trim();
  const entityNorm = normalizeEntity(entity);
  if (!entityNorm) throw new TaskError("entity is required");
  if (entity.length > ENTITY_MAX) throw new TaskError(`entity too long (${ENTITY_MAX} max)`);
  const dedupeKey = assertKey(input.dedupeKey, "dedupe_key", true) as string;
  const threadKey = assertKey(input.threadKey, "thread_key", false);
  const src = input.source;
  if (!src || typeof src !== "object" || typeof src.kind !== "string" || !src.kind.trim())
    throw new TaskError("source must be an object with a kind");
  const sourceJson = JSON.stringify(src);
  if (sourceJson.length > SOURCE_MAX) throw new TaskError(`source too large (${SOURCE_MAX} max)`);
  let dueAt: number | null = null;
  if (input.dueAt != null) {
    if (!Number.isFinite(input.dueAt) || input.dueAt < 0)
      throw new TaskError("due date is not a valid instant");
    dueAt = Math.floor(input.dueAt);
  }
  let confidence: number | null = null;
  if (input.confidence != null) {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
      throw new TaskError("confidence must be between 0 and 1");
    confidence = input.confidence;
  }
  const subject = typeof src.subject === "string" ? src.subject.trim().slice(0, 200) : "";
  const receivedAt =
    typeof src.received_at === "number" && Number.isFinite(src.received_at)
      ? Math.floor(src.received_at)
      : null;
  return {
    title,
    notes,
    kind: input.kind,
    entity,
    entityNorm,
    dedupeKey,
    threadKey,
    source: JSON.parse(sourceJson) as ProposalSource,
    dueAt,
    hasTime: input.hasTime ?? false,
    confidence,
    subject,
    receivedAt,
  };
}

/** What the store found before deciding: the key owner, thread rows, entity rows (each newest first). */
export interface DuplicateLookup {
  byKey: Proposal | null;
  byThread: Proposal[];
  byEntity: Proposal[];
}

export type DuplicateVerdict =
  | { net: "key"; action: "duplicate"; reason: "key"; row: Proposal }
  | { net: "thread" | "entity"; action: "fold"; row: Proposal }
  | {
      net: "thread" | "entity";
      action: "duplicate";
      reason: "accepted" | "dismissed";
      row: Proposal;
    };

/**
 * A pending row absorbs the newcomer (fold). An accepted row, or one the
 * OWNER dismissed, suppresses it — for a window per kind, measured from
 * resolution, on both the thread and the entity net (a long-lived thread
 * must not be silenced forever by one dismissal). A row dismissed as stale
 * or as a duplicate never suppresses — the owner never looked at it, so a
 * later reminder must come back.
 */
function verdictFor(
  row: Proposal,
  net: "thread" | "entity",
  kind: ProposalKind,
  now: number,
): DuplicateVerdict | null {
  if (row.status === "pending") return { net, action: "fold", row };
  const window = ENTITY_WINDOW_MS[kind];
  if (row.resolvedAt == null || now - row.resolvedAt > window) return null;
  if (row.status === "accepted") return { net, action: "duplicate", reason: "accepted", row };
  if (row.dismissReason === "owner") return { net, action: "duplicate", reason: "dismissed", row };
  return null;
}

export function findDuplicate(
  candidate: ProposeCandidate,
  found: DuplicateLookup,
  now: number,
): DuplicateVerdict | null {
  if (found.byKey) return { net: "key", action: "duplicate", reason: "key", row: found.byKey };
  for (const row of found.byThread) {
    const v = verdictFor(row, "thread", candidate.kind, now);
    if (v) return v;
  }
  for (const row of found.byEntity) {
    const v = verdictFor(row, "entity", candidate.kind, now);
    if (v) return v;
  }
  return null;
}

export function newProposal(c: ProposeCandidate, now: number, id: string): Proposal {
  return {
    id,
    title: c.title,
    notes: c.notes,
    kind: c.kind,
    entity: c.entity,
    entityNorm: c.entityNorm,
    threadKey: c.threadKey,
    dueAt: c.dueAt,
    hasTime: c.hasTime,
    source: c.source,
    confidence: c.confidence,
    status: "pending",
    dismissReason: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    taskId: null,
  };
}

/**
 * A follow-up merges into the pending row: one line appended to the notes,
 * a later due date wins, the row is bumped. The notes cap holds — a fold
 * that would overflow it appends nothing rather than failing the tick.
 */
export function foldIntoProposal(
  p: Proposal,
  c: ProposeCandidate,
  now: number,
  tz = "UTC",
): Proposal {
  if (p.status !== "pending") throw new TaskError("only a pending proposal can absorb a follow-up");
  const when = localDate(c.receivedAt ?? now, tz);
  const line = `also: ${c.subject || c.title} · ${when}`;
  const notes = p.notes ? `${p.notes}\n${line}` : line;
  const later = c.dueAt != null && (p.dueAt == null || c.dueAt > p.dueAt);
  return {
    ...p,
    notes: notes.length <= NOTES_MAX ? notes : p.notes,
    dueAt: later ? c.dueAt : p.dueAt,
    hasTime: later ? c.hasTime : p.hasTime,
    confidence:
      c.confidence == null
        ? p.confidence
        : p.confidence == null
          ? c.confidence
          : Math.max(p.confidence, c.confidence),
    updatedAt: now,
  };
}

export function markAccepted(p: Proposal, taskId: string, now: number): Proposal {
  if (p.status !== "pending") throw new TaskError(`proposal is ${p.status}, not pending`);
  return {
    ...p,
    status: "accepted",
    dismissReason: null,
    resolvedAt: now,
    updatedAt: now,
    taskId,
  };
}

export function markDismissed(p: Proposal, reason: DismissReason, now: number): Proposal {
  if (p.status !== "pending") throw new TaskError(`proposal is ${p.status}, not pending`);
  if (!(DISMISS_REASONS as readonly string[]).includes(reason))
    throw new TaskError(`dismiss reason must be one of ${DISMISS_REASONS.join(", ")}`);
  return { ...p, status: "dismissed", dismissReason: reason, resolvedAt: now, updatedAt: now };
}

/** Back to pending. Only a dismissed proposal can come back; an accepted one has a task. */
export function markRestored(p: Proposal, now: number): Proposal {
  if (p.status !== "dismissed") throw new TaskError(`proposal is ${p.status}, not dismissed`);
  return { ...p, status: "pending", dismissReason: null, resolvedAt: null, updatedAt: now };
}

/** Pending for longer than `days` since it was created — the manual trim's input. */
export function isStale(p: Proposal, now: number, days: number): boolean {
  return p.status === "pending" && now - p.createdAt >= days * DAY_MS;
}

// ── the accept-time hint: informational, never a decision ─────────────────

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "due",
  "task",
  "re",
  "fw",
  "fwd",
  "your",
  "my",
  "this",
  "that",
  "is",
  "it",
  "be",
  "do",
]);

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/))
    if (t.length >= 2 && !STOPWORDS.has(t)) out.add(t);
  return out;
}

/**
 * The open task sharing the most non-stopword tokens with the title, when
 * that is at least two. Shown on the accept form as "similar open task";
 * it decides nothing.
 */
export function similarTaskHint(title: string, open: Task[]): Task | null {
  const want = tokens(title);
  if (want.size === 0) return null;
  let best: Task | null = null;
  let bestN = 1;
  for (const t of open) {
    let n = 0;
    for (const tok of tokens(t.title)) if (want.has(tok)) n++;
    if (n > bestN) {
      best = t;
      bestN = n;
    }
  }
  return best;
}
