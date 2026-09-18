/**
 * The tasks tab (§16.4): server-rendered, forms that POST and redirect —
 * the console's first write path, and its only one. It writes the tasks
 * store, never the vault (§15.3). Every mutating form carries the CSRF
 * token; tasks-routes.ts checks it before anything touches the store.
 */

import {
  DAY_MS,
  describeDue,
  formatInterval,
  formatWhen,
  nextDue,
  parseInterval,
  type Task,
  type TaskEvent,
  type TaskStore,
  wallString,
} from "@brain/tasks";
import { esc, page } from "./html.ts";

export interface TasksCtx {
  store: TaskStore;
  tz: string;
  csrf: string;
  now: number;
}

const INTERVALS: Array<[string, string]> = [
  ["1d", "every day"],
  ["3d", "every 3 days"],
  ["1w", "every week"],
  ["2w", "every 2 weeks"],
  ["4w", "every 4 weeks"],
  ["30d", "every 30 days"],
  ["90d", "every 90 days"],
  ["180d", "every 180 days"],
  ["365d", "every 365 days"],
  ["none", "one-off — no repeat"],
  ["custom", "custom…"],
];

const OK_MESSAGES: Record<string, string> = {
  created: "task created",
  "done-rolled": "done — scheduled again",
  "done-retired": "done — retired, it won't repeat",
  "skipped-rolled": "skipped — scheduled again",
  "skipped-retired": "skipped — retired, it won't repeat",
  rescheduled: "rescheduled",
  updated: "updated",
  retired: "retired — no next occurrence until you reopen it",
  reopened: "reopened",
};

export function noticeFrom(url: URL): string {
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  if (ok && OK_MESSAGES[ok]) return `<p class="ok">${OK_MESSAGES[ok]}</p>`;
  if (err) return `<p class="warn">${esc(err.slice(0, 200))}</p>`;
  return "";
}

const csrfInput = (ctx: TasksCtx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`;

function intervalSelect(current: number | null | undefined): string {
  let selected = "custom";
  let custom = "";
  if (current === undefined) selected = "1w";
  else {
    const preset = INTERVALS.find(([v]) => v !== "custom" && parseInterval(v) === current);
    if (preset) selected = preset[0];
    else custom = formatInterval(current);
  }
  const opts = INTERVALS.map(
    ([v, label]) =>
      `<option value="${v}"${v === selected ? " selected" : ""}>${esc(label)}</option>`,
  ).join("");
  return `<select name="interval">${opts}</select>
    <input type="text" name="interval_custom" value="${esc(custom)}" placeholder="custom: 10d, 6w, 12h" size="18">`;
}

function anchorSelect(current: string): string {
  const opt = (v: string, label: string) =>
    `<option value="${v}"${v === current ? " selected" : ""}>${label}</option>`;
  return `<select name="anchor">${opt("completion", "from when I finish it")}${opt("due", "from the due date (keeps cadence)")}</select>`;
}

function dueCls(t: Task, ctx: TasksCtx): string {
  if (t.dueAt == null) return "";
  const label = describeDue(t.dueAt, ctx.now, ctx.tz);
  if (label.endsWith("overdue") || label === "yesterday") return "bad";
  if (label === "today") return "warn";
  return "";
}

function dueHtml(t: Task, ctx: TasksCtx): string {
  if (t.dueAt == null) return `<span class="chip">retired</span>`;
  return `<span class="chip ${dueCls(t, ctx)}">${esc(describeDue(t.dueAt, ctx.now, ctx.tz))}</span>
    <span class="muted">${esc(formatWhen(t.dueAt, ctx.tz))}</span>`;
}

function taskRow(ctx: TasksCtx, t: Task): string {
  const acts =
    t.status === "open"
      ? `<span class="acts"><a href="/tasks/${esc(t.id)}/close?kind=completed">done</a><a href="/tasks/${esc(t.id)}/close?kind=cancelled">skip</a></span>`
      : `<form class="inline" method="post" action="/tasks/${esc(t.id)}/reopen">${csrfInput(ctx)}<button class="btn" type="submit">reopen</button></form>`;
  return `<li><a class="title" href="/tasks/${esc(t.id)}">${esc(t.title)}</a>
    <span class="chip">every ${esc(formatInterval(t.intervalMs))}</span>
    ${dueHtml(t, ctx)}${acts}</li>`;
}

export function tasksPage(ctx: TasksCtx, view: "open" | "retired", notice: string): string {
  const counts = ctx.store.counts();
  const seg = (v: "open" | "retired", href: string, label: string) =>
    `<a href="${href}"${v === view ? ` class="on"` : ""}>${label}</a>`;
  let body: string;
  if (view === "open") {
    const att = ctx.store.attention(ctx.tz, 7);
    const section = (title: string, list: Task[]) =>
      list.length
        ? `<h3>${title} <span class="muted">${list.length}</span></h3><ul class="tasks">${list.map((t) => taskRow(ctx, t)).join("")}</ul>`
        : "";
    body =
      counts.open === 0
        ? `<p class="muted">nothing open. <a href="/tasks/new">add a task</a>.</p>`
        : section("overdue", att.overdue) +
          section("today", att.today) +
          section("next 7 days", att.upcoming) +
          section("later", att.later);
  } else {
    const list = ctx.store.list("retired");
    body = list.length
      ? `<ul class="tasks">${list.map((t) => taskRow(ctx, t)).join("")}</ul>`
      : `<p class="muted">nothing retired.</p>`;
  }
  return page(
    "tasks",
    `<h1>tasks</h1>
     <p class="muted">${counts.open} open · ${counts.retired} retired · every task repeats until you say otherwise · times in ${esc(ctx.tz)}</p>
     <div class="row"><div class="seg">${seg("open", "/tasks", "open")}${seg("retired", "/tasks?view=retired", "retired")}</div>
       <a class="btn" href="/tasks/new">+ new task</a></div>
     ${notice}${body}`,
    { authed: true },
  );
}

export function newTaskPage(ctx: TasksCtx, notice: string): string {
  return page(
    "new task",
    `<h1>new task</h1>${notice}
     <form class="stack" method="post" action="/tasks">${csrfInput(ctx)}
       <label>title</label><input type="text" name="title" required maxlength="200" autofocus>
       <label>repeats</label>${intervalSelect(undefined)}
       <label>next occurrence is measured</label>${anchorSelect("completion")}
       <label>first due <span class="muted">(blank = one interval from now)</span></label>
       <input type="datetime-local" name="due">
       <label>notes</label><textarea name="notes" maxlength="4000"></textarea>
       <p><button class="btn primary" type="submit">create</button> <a href="/tasks">cancel</a></p>
     </form>`,
    { authed: true },
  );
}

function eventLine(e: TaskEvent, tz: string): string {
  const d = e.detail;
  const when = (v: unknown) => (typeof v === "number" ? formatWhen(v, tz) : "");
  let text: string;
  switch (e.kind) {
    case "created":
      text = `created · due ${when(d.dueAt)}`;
      break;
    case "completed":
    case "cancelled": {
      const late = typeof d.lateMs === "number" ? d.lateMs : 0;
      const lateness =
        late === 0
          ? "on time"
          : late < DAY_MS
            ? `${Math.round(late / 3_600_000)}h late`
            : `${Math.round(late / DAY_MS)}d late`;
      text = `${e.kind === "completed" ? "done" : "skipped"} · ${lateness}`;
      break;
    }
    case "rolled":
      text = `next due ${when(d.to)}${d.manual ? " · placed by hand" : ` · ${d.anchor === "due" ? "from the due date" : "from completion"}`}`;
      break;
    case "rescheduled":
      text = `moved ${when(d.from)} → ${when(d.to)}`;
      break;
    case "edited":
      text = `edited ${Object.keys((d.patch as Record<string, unknown>) ?? {}).join(", ")}`;
      break;
    case "retired":
      text = `retired${d.reason && d.reason !== "manual" ? ` after being ${String(d.reason)}` : ""}`;
      break;
    case "reopened":
      text = `reopened · due ${when(d.to)}`;
      break;
    default:
      text = String(e.kind);
  }
  return `<li><span class="muted">${esc(formatWhen(e.at, tz))}</span> — ${esc(text)}</li>`;
}

export function taskPage(ctx: TasksCtx, t: Task, events: TaskEvent[], notice: string): string {
  const open = t.status === "open";
  const actions = open
    ? `<p class="row">
         <a class="btn" href="/tasks/${esc(t.id)}/close?kind=completed">done</a>
         <a class="btn" href="/tasks/${esc(t.id)}/close?kind=cancelled">skip this one</a>
         <form class="inline" method="post" action="/tasks/${esc(t.id)}/retire">${csrfInput(ctx)}<button class="btn" type="submit">retire — stop repeating</button></form>
       </p>
       <form class="stack card" method="post" action="/tasks/${esc(t.id)}/reschedule">${csrfInput(ctx)}
         <label>move the current occurrence to</label>
         <input type="datetime-local" name="due" value="${esc(wallString(t.dueAt as number, ctx.tz))}">
         <p><button class="btn" type="submit">reschedule</button></p>
       </form>`
    : `<form class="stack card" method="post" action="/tasks/${esc(t.id)}/reopen">${csrfInput(ctx)}
         <label>reopen with a due date <span class="muted">(blank = one interval from now)</span></label>
         <input type="datetime-local" name="due">
         <p><button class="btn primary" type="submit">reopen</button></p>
       </form>`;
  return page(
    t.title,
    `<p><span class="chip type">${open ? "open" : "retired"}</span>
        <span class="chip">every ${esc(formatInterval(t.intervalMs))}</span>
        <span class="chip">${t.anchor === "due" ? "anchored to due date" : "anchored to completion"}</span>
        <span class="chip">${t.closes} closed</span></p>
     <h1>${esc(t.title)}</h1>${notice}
     <p>${dueHtml(t, ctx)}</p>
     ${t.notes ? `<div class="card"><pre style="white-space:pre-wrap">${esc(t.notes)}</pre></div>` : ""}
     ${actions}
     <details class="card"><summary>edit</summary>
       <form class="stack" method="post" action="/tasks/${esc(t.id)}/edit">${csrfInput(ctx)}
         <label>title</label><input type="text" name="title" value="${esc(t.title)}" required maxlength="200">
         <label>repeats</label>${intervalSelect(t.intervalMs)}
         <label>next occurrence is measured</label>${anchorSelect(t.anchor)}
         <label>notes</label><textarea name="notes" maxlength="4000">${esc(t.notes)}</textarea>
         <p><button class="btn" type="submit">save</button> <span class="muted">edits never move the current occurrence — reschedule does</span></p>
       </form>
     </details>
     <h3>history</h3>
     <ul class="plain">${events
       .slice()
       .reverse()
       .map((e) => eventLine(e, ctx.tz))
       .join("")}</ul>
     <p><a href="/tasks">← all tasks</a></p>`,
    { authed: true },
  );
}

/** The owner's spec: complete or cancel, then "schedule again?" defaulting to yes. */
export function closePromptPage(ctx: TasksCtx, t: Task, kind: "completed" | "cancelled"): string {
  const verb = kind === "completed" ? "done" : "skipping";
  const canRepeat = t.intervalMs != null;
  const next = canRepeat ? nextDue(t, ctx.now) : ctx.now + DAY_MS;
  return page(
    `${verb}: ${t.title}`,
    `<h1>${verb}: ${esc(t.title)}</h1>
     <form class="stack" method="post" action="/tasks/${esc(t.id)}/close">${csrfInput(ctx)}
       <input type="hidden" name="kind" value="${kind}">
       <p class="sect"><strong>schedule again?</strong></p>
       ${
         canRepeat
           ? `<label class="choice"><input type="radio" name="repeat" value="yes" checked> yes — next ${esc(formatWhen(next, ctx.tz))} <span class="muted">(every ${esc(formatInterval(t.intervalMs))}, ${t.anchor === "due" ? "from the due date" : "from now"})</span></label>`
           : `<p class="muted">this is a one-off — it has no interval. pick a date to repeat it anyway.</p>`
}
       <label class="choice"><input type="radio" name="repeat" value="date"> yes, on a date I pick:
         <input type="datetime-local" name="next" value="${esc(wallString(next, ctx.tz))}"></label>
       <label class="choice"><input type="radio" name="repeat" value="no"${canRepeat ? "" : " checked"}> no — retire this task</label>
       <p><button class="btn primary" type="submit">confirm</button> <a href="/tasks">cancel</a></p>
     </form>`,
    { authed: true },
  );
}
