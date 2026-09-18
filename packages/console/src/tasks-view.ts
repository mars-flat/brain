/**
 * The tasks tab (§16.4): server-rendered, forms that POST and redirect —
 * the console's first write path, and its only one. It writes the tasks
 * store, never the vault (§15.3). Every mutating form carries the CSRF
 * token; tasks-routes.ts checks it before anything touches the store.
 *
 * Interaction without a framework: the custom-interval and time inputs
 * show/hide with CSS :has(); the edit modal is a native <dialog> opened by
 * the tab's one small script (tasks-client.js).
 */

import {
  DAY_MS,
  describeDue,
  formatInterval,
  formatWhen,
  intervalTag,
  nextDue,
  parseInterval,
  type SystemTag,
  type Tag,
  type Task,
  type TaskEvent,
  type TaskStore,
  wallParts,
} from "@brain/tasks";
import { esc, page, toast } from "./html.ts";

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
  purged: "deleted forever",
  "tag-created": "tag created",
  "tag-renamed": "tag renamed",
  "tag-deleted": "tag deleted — removed from every task that had it",
};

export function noticeFrom(url: URL): string {
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  if (ok && OK_MESSAGES[ok]) return toast("ok", OK_MESSAGES[ok]);
  if (err) return toast("warn", esc(err.slice(0, 200)));
  return "";
}

const csrfInput = (ctx: TasksCtx) => `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`;

const tagHref = (name: string) => `/tasks?tag=${encodeURIComponent(name)}`;

function intervalPick(current: number | null | undefined): string {
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
  // The custom field is hidden by CSS until "custom…" is the selection.
  return `<span class="interval-pick"><select name="interval">${opts}</select>
    <input type="text" name="interval_custom" value="${esc(custom)}" placeholder="10d, 6w, 12h" size="14"></span>`;
}

function anchorSelect(current: string): string {
  const opt = (v: string, label: string) =>
    `<option value="${v}"${v === current ? " selected" : ""}>${label}</option>`;
  return `<select name="anchor">${opt("completion", "from when I finish it")}${opt("due", "from the due date (keeps cadence)")}</select>`;
}

/** A date input plus an off-by-default "set a time" toggle that reveals the time input. */
function duePick(at: number | undefined, hasTime: boolean, tz: string, required = false): string {
  const parts = at == null ? { date: "", time: "09:00" } : wallParts(at, tz);
  const time = at == null || !hasTime ? "09:00" : parts.time;
  return `<span class="due-pick"><input type="date" name="due" value="${esc(parts.date)}"${required ? " required" : ""}>
    <label class="inline"><input type="checkbox" name="has_time"${hasTime ? " checked" : ""}> set a time</label>
    <input type="time" name="time" value="${esc(time)}"></span>`;
}

/** Tag checkboxes — the tag list itself is read-only here; it is managed at /tasks/tags. */
function tagPick(all: Tag[], selected: string[]): string {
  if (all.length === 0)
    return `<p class="muted">no tags yet — <a href="/tasks/tags">create some</a>.</p>`;
  const boxes = all
    .map(
      (t) =>
        `<label><input type="checkbox" name="tags" value="${esc(t.name)}"${selected.includes(t.name) ? " checked" : ""}> ${esc(t.name)}</label>`,
    )
    .join("");
  return `<div class="tagpick">${boxes} <a class="muted" href="/tasks/tags">manage tags</a></div>`;
}

function dueCls(t: Task, ctx: TasksCtx): string {
  if (t.dueAt == null) return "";
  const label = describeDue(t.dueAt, ctx.now, ctx.tz);
  if (label.endsWith("overdue") || label === "yesterday") return "bad";
  if (label === "today") return "warn";
  return "";
}

function dueHtml(t: Task, ctx: TasksCtx): string {
  if (t.dueAt == null) return `<a class="chip" href="${tagHref("retired")}">retired</a>`;
  return `<span class="chip ${dueCls(t, ctx)}">${esc(describeDue(t.dueAt, ctx.now, ctx.tz))}</span>
    <span class="muted">${esc(formatWhen(t.dueAt, ctx.tz, t.hasTime))}</span>`;
}

function chips(t: Task, tags: string[]): string {
  const interval = intervalTag(t.intervalMs);
  return (
    `<a class="chip" href="${tagHref(interval)}">${esc(interval)}</a>` +
    tags.map((n) => `<a class="chip tag" href="${tagHref(n)}">${esc(n)}</a>`).join("")
  );
}

function taskRow(ctx: TasksCtx, t: Task, tags: string[]): string {
  const acts =
    t.status === "open"
      ? `<span class="acts"><a href="/tasks/${esc(t.id)}/close?kind=completed">done</a><a href="/tasks/${esc(t.id)}/close?kind=cancelled">skip</a></span>`
      : `<span class="acts"><form class="inline" method="post" action="/tasks/${esc(t.id)}/reopen">${csrfInput(ctx)}<button class="btn" type="submit">reopen</button></form>
         <a class="danger" href="/tasks/${esc(t.id)}/purge">delete forever</a></span>`;
  return `<li><a class="title" href="/tasks/${esc(t.id)}">${esc(t.title)}</a>
    ${chips(t, tags)}
    ${dueHtml(t, ctx)}${acts}</li>`;
}

export function tasksPage(
  ctx: TasksCtx,
  view: "open" | "retired",
  notice: string,
  tag?: string,
): string {
  const counts = ctx.store.counts();
  const tagFilter = tag?.trim() || undefined;
  const seg = (v: "open" | "retired", href: string, label: string) =>
    `<a href="${href}"${v === view ? ` class="on"` : ""}>${label}</a>`;
  let body: string;
  if (view === "open") {
    const att = ctx.store.attention(7);
    const keep = tagFilter
      ? new Set(ctx.store.list("open", { tag: tagFilter }).map((t) => t.id))
      : null;
    const only = (list: Task[]) => (keep ? list.filter((t) => keep.has(t.id)) : list);
    const shown = [...att.overdue, ...att.today, ...att.upcoming, ...att.later].filter(
      (t) => !keep || keep.has(t.id),
    );
    const tags = ctx.store.tagsFor(shown.map((t) => t.id));
    const section = (title: string, list: Task[]) =>
      list.length
        ? `<h3>${title} <span class="muted">${list.length}</span></h3><ul class="tasks">${list.map((t) => taskRow(ctx, t, tags.get(t.id) ?? [])).join("")}</ul>`
        : "";
    body =
      shown.length === 0
        ? `<p class="muted">${counts.open === 0 ? `nothing open. <a href="/tasks/new">add a task</a>.` : "nothing open with that tag."}</p>`
        : section("overdue", only(att.overdue)) +
          section("today", only(att.today)) +
          section("next 7 days", only(att.upcoming)) +
          section("later", only(att.later));
  } else {
    const list = ctx.store.list("retired", { tag: tagFilter });
    const tags = ctx.store.tagsFor(list.map((t) => t.id));
    body = list.length
      ? `<ul class="tasks">${list.map((t) => taskRow(ctx, t, tags.get(t.id) ?? [])).join("")}</ul>`
      : `<p class="muted">nothing retired${tagFilter ? " with that tag" : ""}.</p>`;
  }
  const filterLine = tagFilter
    ? `<p class="muted">filtered by <span class="chip tag">${esc(tagFilter)}</span> · <a href="${view === "retired" ? "/tasks?view=retired" : "/tasks"}">clear</a></p>`
    : "";
  return page(
    "tasks",
    `<h1>tasks</h1>
     <p class="muted">${counts.open} open · ${counts.retired} retired · every task repeats until you say otherwise · times in ${esc(ctx.tz)}</p>
     <div class="bar">
       <div class="seg">${seg("open", "/tasks", "open")}${seg("retired", "/tasks?view=retired", "retired")}</div>
       <div class="right"><a class="btn" href="/tasks/tags">tags</a><a class="btn primary" href="/tasks/new">+ new task</a></div>
     </div>
     <hr class="rule">
     ${notice}${filterLine}${body}`,
    { authed: true },
  );
}

export function newTaskPage(ctx: TasksCtx, notice: string): string {
  return page(
    "new task",
    `<h1>new task</h1>${notice}
     <form class="stack" method="post" action="/tasks">${csrfInput(ctx)}
       <label>title</label><input type="text" name="title" required maxlength="200" autofocus>
       <label>repeats</label>${intervalPick(undefined)}
       <label>next occurrence is measured</label>${anchorSelect("completion")}
       <label>first due <span class="muted">(blank = one interval from now)</span></label>
       ${duePick(undefined, false, ctx.tz)}
       <label>tags</label>${tagPick(ctx.store.tags(), [])}
       <label>notes</label><textarea name="notes" maxlength="4000"></textarea>
       <p><button class="btn primary" type="submit">create</button> <a href="/tasks">cancel</a></p>
     </form>`,
    { authed: true },
  );
}

function eventLine(e: TaskEvent, tz: string): string {
  const d = e.detail;
  const when = (v: unknown, hasTime: unknown) =>
    typeof v === "number" ? formatWhen(v, tz, hasTime !== false) : "";
  let text: string;
  switch (e.kind) {
    case "created":
      text = `created · due ${when(d.dueAt, d.hasTime)}${Array.isArray(d.tags) && d.tags.length ? ` · tags ${(d.tags as string[]).join(", ")}` : ""}`;
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
      text = `next due ${when(d.to, d.hasTime)}${d.manual ? " · placed by hand" : ` · ${d.anchor === "due" ? "from the due date" : "from completion"}`}`;
      break;
    case "rescheduled":
      text = `moved ${when(d.from, true)} → ${when(d.to, d.hasTime)}`;
      break;
    case "edited":
      text = Array.isArray(d.tags)
        ? `tags: ${(d.tags as string[]).join(", ") || "none"}`
        : `edited ${Object.keys((d.patch as Record<string, unknown>) ?? {}).join(", ")}`;
      break;
    case "retired":
      text = `retired${d.reason && d.reason !== "manual" ? ` after being ${String(d.reason)}` : ""}`;
      break;
    case "reopened":
      text = `reopened · due ${when(d.to, d.hasTime)}`;
      break;
    default:
      text = String(e.kind);
  }
  return `<li><span class="muted">${esc(formatWhen(e.at, tz))}</span> — ${esc(text)}</li>`;
}

export function taskPage(
  ctx: TasksCtx,
  t: Task,
  events: TaskEvent[],
  tags: string[],
  notice: string,
): string {
  const open = t.status === "open";
  const id = esc(t.id);
  const actions = open
    ? `<div class="row actions">
         <a class="btn good" href="/tasks/${id}/close?kind=completed">done</a>
         <a class="btn warn" href="/tasks/${id}/close?kind=cancelled">skip this one</a>
         <form class="inline" method="post" action="/tasks/${id}/retire">${csrfInput(ctx)}<button class="btn bad" type="submit">retire</button></form>
         <button class="btn" type="button" data-dialog="edit">edit</button>
       </div>
       <form class="stack card" method="post" action="/tasks/${id}/reschedule">${csrfInput(ctx)}
         <label>move the current occurrence to</label>
         ${duePick(t.dueAt as number, t.hasTime, ctx.tz, true)}
         <p><button class="btn" type="submit">reschedule</button></p>
       </form>`
    : `<div class="row actions">
         <form class="inline" method="post" action="/tasks/${id}/reopen">${csrfInput(ctx)}
           ${duePick(undefined, t.hasTime, ctx.tz)}
           <button class="btn good" type="submit">reopen</button>
           <span class="muted">(blank date = one interval from now)</span>
         </form>
         <a class="btn bad" href="/tasks/${id}/purge">delete forever</a>
         <button class="btn" type="button" data-dialog="edit">edit</button>
       </div>`;
  return page(
    t.title,
    `<p><a class="chip type" href="${tagHref(t.status)}">${open ? "open" : "retired"}</a>
        <a class="chip" href="${tagHref(intervalTag(t.intervalMs))}">${esc(intervalTag(t.intervalMs))}</a>
        <span class="chip">${t.anchor === "due" ? "anchored to due date" : "anchored to completion"}</span>
        <span class="chip">${t.closes} closed</span>
        ${tags.map((n) => `<a class="chip tag" href="${tagHref(n)}">${esc(n)}</a>`).join("")}</p>
     <h1>${esc(t.title)}</h1>${notice}
     <p>${dueHtml(t, ctx)}</p>
     ${t.notes ? `<div class="card"><pre class="notes">${esc(t.notes)}</pre></div>` : ""}
     ${actions}
     <details class="card"><summary>history <span class="muted">${events.length}</span></summary>
       <ul class="plain">${events
         .slice()
         .reverse()
         .map((e) => eventLine(e, ctx.tz))
         .join("")}</ul>
     </details>
     <dialog id="edit">
       <form class="stack" method="post" action="/tasks/${id}/edit">${csrfInput(ctx)}
         <h3>edit</h3>
         <label>title</label><input type="text" name="title" value="${esc(t.title)}" required maxlength="200">
         <label>repeats</label>${intervalPick(t.intervalMs)}
         <label>next occurrence is measured</label>${anchorSelect(t.anchor)}
         <label>tags</label>${tagPick(ctx.store.tags(), tags)}
         <label>notes</label><textarea name="notes" maxlength="4000">${esc(t.notes)}</textarea>
         <p class="muted">edits never move the current occurrence — reschedule does</p>
         <p><button class="btn primary" type="submit">save</button>
            <button class="btn" type="submit" formmethod="dialog" formnovalidate>cancel</button></p>
       </form>
     </dialog>
     <p><a href="/tasks">← all tasks</a></p>`,
    { authed: true },
  );
}

/** The owner's spec: complete or cancel, then "schedule again?" defaulting to yes. */
export function closePromptPage(ctx: TasksCtx, t: Task, kind: "completed" | "cancelled"): string {
  const verb = kind === "completed" ? "done" : "skipping";
  const canRepeat = t.intervalMs != null;
  const next = canRepeat ? nextDue(t, ctx.now, ctx.tz) : ctx.now + DAY_MS;
  return page(
    `${verb}: ${t.title}`,
    `<h1>${verb}: ${esc(t.title)}</h1>
     <form class="stack" method="post" action="/tasks/${esc(t.id)}/close">${csrfInput(ctx)}
       <input type="hidden" name="kind" value="${kind}">
       <p class="sect"><strong>schedule again?</strong></p>
       ${
         canRepeat
           ? `<label class="choice"><input type="radio" name="repeat" value="yes" checked> yes — next ${esc(formatWhen(next, ctx.tz, t.hasTime))} <span class="muted">(every ${esc(formatInterval(t.intervalMs))}, ${t.anchor === "due" ? "from the due date" : "from now"})</span></label>`
           : `<p class="muted">this is a one-off — it has no interval. pick a date to repeat it anyway.</p>`
}
       <label class="choice"><input type="radio" name="repeat" value="date"> yes, on a date I pick:
         ${duePick(next, t.hasTime, ctx.tz)}</label>
       <label class="choice"><input type="radio" name="repeat" value="no"${canRepeat ? "" : " checked"}> no — retire this task</label>
       <p><button class="btn primary" type="submit">confirm</button> <a href="/tasks">cancel</a></p>
     </form>`,
    { authed: true },
  );
}

/** Permanent deletion needs a second page, not a second click on the same one. */
export function purgePromptPage(ctx: TasksCtx, t: Task, eventCount: number): string {
  return page(
    `delete forever: ${t.title}`,
    `<h1>delete forever: ${esc(t.title)}</h1>
     <p>This removes the task and its ${eventCount} history event${eventCount === 1 ? "" : "s"}. There is no undo — retired tasks can otherwise be reopened at any time.</p>
     <form class="row" method="post" action="/tasks/${esc(t.id)}/purge">${csrfInput(ctx)}
       <button class="btn bad" type="submit">delete forever</button>
       <a href="/tasks/${esc(t.id)}">cancel</a>
     </form>`,
    { authed: true },
  );
}

export function tagsPage(ctx: TasksCtx, tags: Tag[], system: SystemTag[], notice: string): string {
  const yours = tags.length
    ? `<ul class="plain tags-list">${tags
        .map(
          (t) => `<li>
            <form class="inline" method="post" action="/tasks/tags/${t.id}/rename">${csrfInput(ctx)}
              <input type="text" name="name" value="${esc(t.name)}" maxlength="40" required>
              <button class="btn" type="submit">rename</button></form>
            <a class="chip tag" href="${tagHref(t.name)}">${t.count} task${t.count === 1 ? "" : "s"}</a>
            <form class="inline" method="post" action="/tasks/tags/${t.id}/delete">${csrfInput(ctx)}
              <button class="btn bad" type="submit">delete</button></form>
          </li>`,
        )
        .join("")}</ul>`
    : `<p class="muted">no tags yet.</p>`;
  const builtIn = system
    .map(
      (s) =>
        `<li><a class="chip" href="${tagHref(s.name)}">${esc(s.name)}</a> <span class="muted">${s.count} task${s.count === 1 ? "" : "s"} · ${s.kind}</span></li>`,
    )
    .join("");
  return page(
    "tags",
    `<h1>tags</h1>
     <p class="muted">tags are assigned on a task's form; the list itself is managed here. a task's repeat interval and status are tags too, built in.</p>
     <form class="row" method="post" action="/tasks/tags">${csrfInput(ctx)}
       <input type="text" name="name" placeholder="new tag" maxlength="40" required>
       <button class="btn primary" type="submit">create</button>
     </form>
     <hr class="rule">
     ${notice}
     <h3>yours</h3>${yours}
     <h3>built-in <span class="muted">read-only</span></h3>
     <ul class="plain">${builtIn}</ul>
     <p><a href="/tasks">← all tasks</a></p>`,
    { authed: true },
  );
}
