/**
 * The tasks MCP server (§16.5): one stdio upstream behind the gateway, so
 * every Claude surface — laptop sessions, cloud routines, the phone — reaches
 * the same store the console writes. Low-level Server API with plain JSON
 * Schemas, like mcp-google, so the advertised surface stays byte-controlled.
 *
 * Kind classification (§4.4) rides annotations: reads carry readOnlyHint;
 * everything else falls to `write` and the policy's confirm default.
 * Nothing here is destructive — retire is reversible by reopen, and the
 * permanent delete (purge) is console-only by design.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ANCHORS,
  type Anchor,
  type CloseKind,
  formatInterval,
  parseInterval,
  type Task,
  TaskError,
  type TaskEvent,
} from "./core.ts";
import {
  PROPOSAL_KINDS,
  type Proposal,
  type ProposalKind,
  type ProposalSource,
} from "./proposals.ts";
import type { ListFilter, ProposalFilter, TaskStore } from "./store.ts";
import { describeDue, formatWhen, parseDue } from "./time.ts";

const VERSION = "0.3.0";

export interface TasksServerOptions {
  /** IANA zone for day boundaries and human renderings (§16.3). */
  tz: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const readOnly = { readOnlyHint: true };

const ID = { type: "string", description: "task id" };
const WHEN = {
  type: "string",
  description:
    "a bare date (2026-09-24) for a task due on a day with no time; a bare wall time in the server zone (2026-09-24T09:00) or ISO 8601 with offset (2026-09-24T09:00:00-04:00) for a timed one",
};
const INTERVAL = {
  type: "string",
  description: 'recurrence interval: "10d", "2w", "12h", or "none" for a one-off',
};
const ANCHOR = {
  type: "string",
  enum: [...ANCHORS],
  description:
    "where the next occurrence is measured from: completion (default) = interval after closing; due = interval after the previous due date, advancing to the first future slot when late",
};
const TAGS = {
  type: "array",
  items: { type: "string" },
  description:
    "user tag names, replacing the task's current set; every name must already exist (tags are managed in the console's tags section)",
};

const TOOLS: ToolDef[] = [
  {
    name: "list",
    description:
      'List tasks. Default: open ones, soonest due first. status=retired lists opted-out tasks; status=all lists both. tag filters by a user tag or a derived one ("every 1 week", "one-off", "open", "retired").',
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "retired", "all"], default: "open" },
        tag: { type: "string" },
      },
    },
    annotations: readOnly,
  },
  {
    name: "get",
    description: "One task with its full event history (created, completed, rolled, rescheduled…).",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
    annotations: readOnly,
  },
  {
    name: "due",
    description:
      "What needs attention: open tasks bucketed by local day into overdue, today, upcoming (within horizon_days), and later. The daily reminder reads this.",
    inputSchema: {
      type: "object",
      properties: { horizon_days: { type: "integer", minimum: 0, maximum: 60, default: 3 } },
    },
    annotations: readOnly,
  },
  {
    name: "create",
    description:
      'Create a task. Every task recurs until opted out: the interval is required unless it is a one-off (interval "none"). Default due = now + interval, as a date with no time; give due_at with a clock time to make it timed.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        notes: { type: "string", maxLength: 4000 },
        interval: INTERVAL,
        anchor: ANCHOR,
        due_at: WHEN,
        tags: TAGS,
      },
      required: ["title", "interval"],
    },
  },
  {
    name: "complete",
    description:
      "Mark the open occurrence done. By default the task is scheduled again (interval after now, or after the due date for due-anchored tasks); repeat=false retires it; next_due_at places the next occurrence by hand.",
    inputSchema: {
      type: "object",
      properties: { id: ID, repeat: { type: "boolean" }, next_due_at: WHEN },
      required: ["id"],
    },
  },
  {
    name: "cancel",
    description:
      "Skip the open occurrence without doing it. Same scheduling behaviour as complete: repeats by default, repeat=false retires, next_due_at places by hand.",
    inputSchema: {
      type: "object",
      properties: { id: ID, repeat: { type: "boolean" }, next_due_at: WHEN },
      required: ["id"],
    },
  },
  {
    name: "reschedule",
    description: "Move the open occurrence to a new due date (or date + time) without closing it.",
    inputSchema: {
      type: "object",
      properties: { id: ID, due_at: WHEN },
      required: ["id", "due_at"],
    },
  },
  {
    name: "update",
    description:
      "Edit title, notes, interval, anchor, or tags. Never moves the open occurrence — use reschedule for that.",
    inputSchema: {
      type: "object",
      properties: {
        id: ID,
        title: { type: "string", maxLength: 200 },
        notes: { type: "string", maxLength: 4000 },
        interval: INTERVAL,
        anchor: ANCHOR,
        tags: TAGS,
      },
      required: ["id"],
    },
  },
  {
    name: "retire",
    description: "Opt out: close the task with no next occurrence. Reversible with reopen.",
    inputSchema: { type: "object", properties: { id: ID }, required: ["id"] },
  },
  {
    name: "reopen",
    description:
      "Bring a retired task back with a new open occurrence (default due: now + interval).",
    inputSchema: { type: "object", properties: { id: ID, due_at: WHEN }, required: ["id"] },
  },
  // ── proposed tasks (§16.8): a second list only a human promotes ─────────
  {
    name: "proposals",
    description:
      "List proposed tasks — candidates waiting for the owner to accept or dismiss (from the mail tick, a session, any adapter). Default: pending, newest first. Not tasks: never in due or list.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "accepted", "dismissed", "all"],
          default: "pending",
        },
        kind: { type: "string", enum: [...PROPOSAL_KINDS] },
      },
    },
    annotations: readOnly,
  },
  {
    name: "propose",
    description:
      'Add a candidate to the proposed list for the owner to vet. Never creates a task. Idempotent and duplicate-aware: the same dedupe_key, the same thread_key, or the same entity as an existing proposal returns outcome "folded" (merged into the pending one) or "duplicate" (already accepted, or dismissed by the owner) instead of a new row. entity is the canonical thing the task is about — "cs348 a3", "shopify interview", "netflix" — and is required.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        kind: { type: "string", enum: [...PROPOSAL_KINDS] },
        entity: { type: "string", maxLength: 120 },
        dedupe_key: {
          type: "string",
          maxLength: 200,
          description: 'unique per source unit, e.g. "gmail:<server>:<message_id>"',
        },
        source: {
          type: "object",
          description:
            'where it came from: { kind: "gmail", account, from, subject, received_at (unix ms) } or { kind: "session" }',
          properties: { kind: { type: "string" } },
          required: ["kind"],
        },
        thread_key: {
          type: "string",
          maxLength: 200,
          description:
            'e.g. "gmail:<server>:<thread_id>" — replies and reminders fold into one row',
        },
        notes: { type: "string", maxLength: 4000 },
        due_at: WHEN,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["title", "kind", "entity", "dedupe_key", "source"],
    },
  },
  {
    name: "accept_proposal",
    description:
      "The owner's yes: create a task from a pending proposal (the ordinary create, every rule intact — interval required unless one-off) and mark the proposal accepted. Title, notes, due_at, and tags default to the proposal's.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "proposal id" },
        interval: INTERVAL,
        anchor: ANCHOR,
        title: { type: "string", maxLength: 200 },
        notes: { type: "string", maxLength: 4000 },
        due_at: WHEN,
        tags: TAGS,
      },
      required: ["id", "interval"],
    },
  },
  {
    name: "dismiss_proposal",
    description:
      "The owner's no: mark a pending proposal dismissed. The row stays, and the same thread or entity will not be proposed again for a while. Reversible with restore_proposal.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "proposal id" } },
      required: ["id"],
    },
  },
  {
    name: "restore_proposal",
    description: "Bring a dismissed proposal back to pending.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "proposal id" } },
      required: ["id"],
    },
  },
  {
    name: "dismiss_stale_proposals",
    description:
      "Dismiss every pending proposal older than older_than_days (default 7) as stale. A stale dismissal never suppresses later proposals about the same thing.",
    inputSchema: {
      type: "object",
      properties: { older_than_days: { type: "integer", minimum: 1, maximum: 365, default: 7 } },
    },
  },
];

export interface ProposalOut {
  id: string;
  title: string;
  notes: string;
  kind: ProposalKind;
  entity: string;
  thread_key: string | null;
  due_at: string | null;
  has_time: boolean;
  due_human: string | null;
  source: Record<string, unknown>;
  confidence: number | null;
  status: string;
  dismiss_reason: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export function proposalOut(p: Proposal, tz: string): ProposalOut {
  return {
    id: p.id,
    title: p.title,
    notes: p.notes,
    kind: p.kind,
    entity: p.entity,
    thread_key: p.threadKey,
    due_at: iso(p.dueAt),
    has_time: p.hasTime,
    due_human: p.dueAt == null ? null : formatWhen(p.dueAt, tz, p.hasTime),
    source: p.source,
    confidence: p.confidence,
    status: p.status,
    dismiss_reason: p.dismissReason,
    task_id: p.taskId,
    created_at: iso(p.createdAt) as string,
    updated_at: iso(p.updatedAt) as string,
    resolved_at: iso(p.resolvedAt),
  };
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

export interface TaskOut {
  id: string;
  title: string;
  notes: string;
  status: string;
  interval: string;
  interval_ms: number | null;
  anchor: Anchor;
  due_at: string | null;
  has_time: boolean;
  due: string | null;
  due_human: string | null;
  tags: string[];
  closes: number;
  last_closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function taskOut(t: Task, now: number, tz: string, tags: string[] = []): TaskOut {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    interval: formatInterval(t.intervalMs),
    interval_ms: t.intervalMs,
    anchor: t.anchor,
    due_at: iso(t.dueAt),
    has_time: t.hasTime,
    due: t.dueAt == null ? null : describeDue(t.dueAt, now, tz),
    due_human: t.dueAt == null ? null : formatWhen(t.dueAt, tz, t.hasTime),
    tags,
    closes: t.closes,
    last_closed_at: iso(t.lastClosedAt),
    created_at: iso(t.createdAt) as string,
    updated_at: iso(t.updatedAt) as string,
  };
}

function eventOut(e: TaskEvent) {
  return { at: iso(e.at), kind: e.kind, detail: e.detail };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const need = (v: unknown, what: string): string => {
  const s = str(v);
  if (!s) throw new TaskError(`${what} is required`);
  return s;
};
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

export function buildTasksServer(
  store: TaskStore,
  opts: TasksServerOptions,
  now: () => number = () => Date.now(),
): Server {
  const tz = opts.tz;
  const server = new Server(
    { name: "mcp-tasks", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  const out = (t: Task) => taskOut(t, now(), tz, store.tagsOf(t.id));
  const outMany = (ts: Task[]) => {
    const tags = store.tagsFor(ts.map((t) => t.id));
    const at = now();
    return ts.map((t) => taskOut(t, at, tz, tags.get(t.id) ?? []));
  };
  const when = (v: unknown): { at: number; hasTime: boolean } | undefined => {
    const s = str(v);
    if (!s) return undefined;
    try {
      return parseDue(s, tz);
    } catch (err) {
      throw new TaskError(err instanceof Error ? err.message : String(err));
    }
  };
  const closeArgs = (a: Record<string, unknown>) => {
    const next = when(a.next_due_at);
    return {
      repeat: typeof a.repeat === "boolean" ? a.repeat : undefined,
      nextDueAt: next?.at,
      nextHasTime: next?.hasTime,
    };
  };

  const dispatch = (name: string, a: Record<string, unknown>): Record<string, unknown> => {
    switch (name) {
      case "list": {
        const status = (str(a.status) ?? "open") as ListFilter;
        if (!["open", "retired", "all"].includes(status))
          throw new TaskError("status must be open, retired, or all");
        return { tasks: outMany(store.list(status, { tag: str(a.tag) })), tz };
      }
      case "get": {
        const id = need(a.id, "id");
        const t = store.get(id);
        if (!t) throw new TaskError(`no task ${id}`);
        return { task: out(t), events: store.events(id).map(eventOut) };
      }
      case "due": {
        const horizon = typeof a.horizon_days === "number" ? a.horizon_days : 3;
        const att = store.attention(horizon, tz);
        return {
          overdue: outMany(att.overdue),
          today: outMany(att.today),
          upcoming: outMany(att.upcoming),
          later: outMany(att.later),
          needs_attention: att.overdue.length + att.today.length,
          tz,
          generated_at: new Date(now()).toISOString(),
        };
      }
      case "create": {
        const due = when(a.due_at);
        const t = store.create({
          title: need(a.title, "title"),
          notes: str(a.notes),
          intervalMs: parseInterval(str(a.interval) ?? "none"),
          anchor: str(a.anchor) as Anchor | undefined,
          dueAt: due?.at,
          hasTime: due?.hasTime,
          tags: strList(a.tags),
        });
        return { task: out(t) };
      }
      case "complete":
      case "cancel": {
        const id = need(a.id, "id");
        const kind: CloseKind = name === "complete" ? "completed" : "cancelled";
        const t = store.close(id, kind, closeArgs(a));
        return { task: out(t), events: store.events(id).slice(-2).map(eventOut) };
      }
      case "reschedule": {
        const id = need(a.id, "id");
        const due = when(a.due_at);
        if (due === undefined) throw new TaskError("due_at is required");
        return { task: out(store.reschedule(id, due.at, due.hasTime)) };
      }
      case "update": {
        const id = need(a.id, "id");
        let t = store.update(id, {
          title: str(a.title),
          notes: str(a.notes),
          intervalMs: a.interval === undefined ? undefined : parseInterval(str(a.interval)),
          anchor: str(a.anchor) as Anchor | undefined,
        });
        const tags = strList(a.tags);
        if (tags) {
          store.setTags(id, tags);
          t = store.get(id) as Task;
        }
        return { task: out(t) };
      }
      case "retire":
        return { task: out(store.retire(need(a.id, "id"))) };
      case "reopen": {
        const due = when(a.due_at);
        return { task: out(store.reopen(need(a.id, "id"), due?.at, due?.hasTime)) };
      }
      case "proposals": {
        const status = (str(a.status) ?? "pending") as ProposalFilter;
        if (!["pending", "accepted", "dismissed", "all"].includes(status))
          throw new TaskError("status must be pending, accepted, dismissed, or all");
        const kind = str(a.kind) as ProposalKind | undefined;
        const ps = store.proposals(status, { kind });
        return {
          proposals: ps.map((p) => proposalOut(p, tz)),
          counts: store.proposalCounts(),
          tz,
        };
      }
      case "propose": {
        const due = when(a.due_at);
        const source = a.source;
        if (!source || typeof source !== "object" || Array.isArray(source))
          throw new TaskError("source must be an object with a kind");
        const r = store.propose({
          title: need(a.title, "title"),
          kind: need(a.kind, "kind") as ProposalKind,
          entity: need(a.entity, "entity"),
          dedupeKey: need(a.dedupe_key, "dedupe_key"),
          source: source as ProposalSource,
          threadKey: str(a.thread_key) ?? null,
          notes: str(a.notes),
          dueAt: due?.at ?? null,
          hasTime: due?.hasTime,
          confidence: typeof a.confidence === "number" ? a.confidence : null,
        });
        return {
          outcome: r.outcome,
          ...(r.outcome === "duplicate" ? { reason: r.reason } : {}),
          proposal: proposalOut(r.proposal, tz),
        };
      }
      case "accept_proposal": {
        const id = need(a.id, "id");
        const due = when(a.due_at);
        const r = store.acceptProposal(id, {
          title: str(a.title),
          notes: str(a.notes),
          intervalMs: parseInterval(str(a.interval) ?? "none"),
          anchor: str(a.anchor) as Anchor | undefined,
          dueAt: due?.at,
          hasTime: due?.hasTime,
          tags: strList(a.tags),
        });
        return { task: out(r.task), proposal: proposalOut(r.proposal, tz) };
      }
      case "dismiss_proposal":
        return { proposal: proposalOut(store.dismissProposal(need(a.id, "id"), "owner"), tz) };
      case "restore_proposal":
        return { proposal: proposalOut(store.restoreProposal(need(a.id, "id")), tz) };
      case "dismiss_stale_proposals": {
        const days = typeof a.older_than_days === "number" ? a.older_than_days : 7;
        if (!Number.isInteger(days) || days < 1 || days > 365)
          throw new TaskError("older_than_days must be a whole number of days from 1 to 365");
        return { dismissed: store.dismissStaleProposals(days) };
      }
      default:
        throw new TaskError(`unknown tool ${name}`);
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = dispatch(name, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      if (err instanceof TaskError)
        return { isError: true, content: [{ type: "text", text: err.message }] };
      throw err;
    }
  });

  return server;
}

/** The advertised tool names, for tests and docs. */
export const TASK_TOOL_NAMES = TOOLS.map((t) => t.name);
