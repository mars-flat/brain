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
import type { ListFilter, TaskStore } from "./store.ts";
import { describeDue, formatWhen, parseDue } from "./time.ts";

const VERSION = "0.2.0";

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
];

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

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

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
