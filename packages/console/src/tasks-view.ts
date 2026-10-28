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
  type Closed,
  DAY_MS,
  dayDelta,
  describeDue,
  formatInterval,
  formatWhen,
  intervalTag,
  isStale,
  localDate,
  nextDue,
  type Proposal,
  parseInterval,
  type SystemTag,
  similarTaskHint,
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
  accepted: "task created from the proposal",
  dismissed: "proposal dismissed",
  restored: "proposal restored",
};

/** The stale trim (§16.8): the toast carries how many went. */
export const STALE_DAYS = 7;

export function noticeFrom(url: URL): string {
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  if (ok === "stale") {
    const n = Number(url.searchParams.get("n") ?? 0);
    return toast(
      "ok",
      n === 0
        ? "nothing older than a week to dismiss"
        : `dismissed ${n} proposal${n === 1 ? "" : "s"} older than a week`,
    );
  }
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

/** Row-level actions are quiet: the row is the thing, the verbs sit at its edge. */
function rowActs(ctx: TasksCtx, t: Task): string {
  const id = esc(t.id);
  return t.status === "open"
    ? `<span class="acts"><a class="btn quiet" href="/tasks/${id}/close?kind=completed">done</a><a class="btn quiet" href="/tasks/${id}/close?kind=cancelled">skip</a></span>`
    : `<span class="acts"><form class="inline" method="post" action="/tasks/${id}/reopen">${csrfInput(ctx)}<button class="btn" type="submit">reopen</button></form>
         <a class="btn quiet danger" href="/tasks/${id}/purge">delete forever</a></span>`;
}

function taskRow(ctx: TasksCtx, t: Task, tags: string[]): string {
  return `<li><a class="title" href="/tasks/${esc(t.id)}">${esc(t.title)}</a>
    ${chips(t, tags)}
    ${dueHtml(t, ctx)}${rowActs(ctx, t)}</li>`;
}

/**
 * A board card for the urgent band: an open task due by tomorrow. It is
 * draggable onto the done column — the drop opens the same close prompt
 * the done button does (console-client.js) — and carries that href as its
 * drag payload so the two paths cannot diverge.
 */
function todoCard(ctx: TasksCtx, t: Task, tags: string[]): string {
  const id = esc(t.id);
  const closeHref = `/tasks/${id}/close?kind=completed`;
  return `<article class="tcard" draggable="true" data-drag="${closeHref}">
    <a class="title" href="/tasks/${id}">${esc(t.title)}</a>
    <span class="acts"><a class="btn quiet" href="${closeHref}">done</a><a class="btn quiet" href="/tasks/${id}/close?kind=cancelled">skip</a></span>
    <span class="meta">${dueHtml(t, ctx)}${tags.map((n) => `<a class="chip tag" href="${tagHref(n)}">${esc(n)}</a>`).join("")}</span>
  </article>`;
}

/** A closed occurrence from today: read-only, greyed, with where the task went next. */
function doneCard(ctx: TasksCtx, c: Closed): string {
  const t = c.task;
  const at = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(c.at));
  const next =
    t.status === "open" && t.dueAt != null
      ? `next ${esc(describeDue(t.dueAt, ctx.now, ctx.tz))}`
      : "retired";
  return `<article class="tcard closed">
    <a class="title" href="/tasks/${esc(t.id)}">${esc(t.title)}</a>
    <span class="meta">${c.kind === "completed" ? "done" : "skipped"} ${esc(at)} · ${next}</span>
  </article>`;
}

/** The urgent band (§16.4): overdue + today + tomorrow as todo, today's closures as done. */
function board(ctx: TasksCtx, todo: Task[], done: Closed[], tags: Map<string, string[]>): string {
  const todoHtml = todo.length
    ? todo.map((t) => todoCard(ctx, t, tags.get(t.id) ?? [])).join("")
    : `<p class="empty">nothing due by tomorrow.</p>`;
  const doneHtml = done.length
    ? done.map((c) => doneCard(ctx, c)).join("")
    : `<p class="empty">nothing closed yet today.</p>`;
  return `<section class="board" aria-label="today, tomorrow and overdue">
    <div class="col"><h3>todo <span class="muted">${todo.length}</span></h3>${todoHtml}</div>
    <div class="col" data-drop="done"><h3>done <span class="muted">${done.length}</span></h3>${doneHtml}</div>
  </section>`;
}

// ── proposed tasks (§16.8): the sidebar and its page ──────────────────────

const KIND_LABEL: Record<Proposal["kind"], string> = {
  university: "university",
  job: "job",
  subscription: "subscription",
  other: "other",
};

/** "g-2006 · LEARN · 2026-10-27" — the breadcrumb that finds the mail; never a link (owner, Q10). */
function sourceLine(p: Proposal, tz: string): string {
  const s = p.source;
  const parts: string[] = [];
  if (typeof s.account === "string" && s.account) parts.push(s.account);
  if (typeof s.from === "string" && s.from) parts.push(s.from.replace(/\s*<[^>]*>\s*$/, ""));
  else if (s.kind !== "gmail") parts.push(String(s.kind));
  if (typeof s.received_at === "number") parts.push(localDate(s.received_at, tz));
  return parts.map(esc).join(" · ");
}

function proposalDue(p: Proposal, ctx: TasksCtx): string {
  if (p.dueAt == null) return "";
  const label = describeDue(p.dueAt, ctx.now, ctx.tz);
  const cls =
    label.endsWith("overdue") || label === "yesterday" ? "bad" : label === "today" ? "warn" : "";
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

/** One proposed row: title (no detail page), kind and due chips, the breadcrumb, accept and dismiss. */
function proposalRow(ctx: TasksCtx, p: Proposal, back: string): string {
  const id = esc(p.id);
  return `<li data-proposal="${id}">
    <span class="title plain">${esc(p.title)}</span>
    <span class="facts"><span class="chip">${KIND_LABEL[p.kind]}</span>${proposalDue(p, ctx)}</span>
    <span class="src">${sourceLine(p, ctx.tz)}</span>
    <span class="acts"><a class="btn" href="/tasks/new?proposal=${id}">accept</a>
      <form class="inline" method="post" action="/tasks/proposed/${id}/dismiss">${csrfInput(ctx)}<input type="hidden" name="back" value="${esc(back)}"><button class="btn quiet" type="submit">dismiss</button></form></span>
  </li>`;
}

function staleForm(ctx: TasksCtx, pending: Proposal[], back: string): string {
  if (!pending.some((p) => isStale(p, ctx.now, STALE_DAYS))) return "";
  return `<form class="inline" method="post" action="/tasks/proposed/dismiss-stale">${csrfInput(ctx)}<input type="hidden" name="back" value="${esc(back)}"><button class="btn quiet" type="submit">dismiss older than ${STALE_DAYS} days</button></form>`;
}

/** The sidebar on /tasks: pending proposals, newest first; one muted line at zero so the layout never jumps. */
function proposedAside(ctx: TasksCtx, pending: Proposal[]): string {
  const list = pending.length
    ? `<ul class="tasks props">${pending.map((p) => proposalRow(ctx, p, "/tasks")).join("")}</ul>`
    : `<p class="empty">nothing proposed.</p>`;
  return `<aside class="side" aria-label="proposed tasks">
    <h3>proposed <span class="muted">${pending.length}</span></h3>
    ${list}
    <p class="row"><a class="muted" href="/tasks/proposed">all proposed</a>${staleForm(ctx, pending, "/tasks")}</p>
  </aside>`;
}

/** /tasks/proposed: pending in full, then the last 30 days of accepted and dismissed, with restore. */
export function proposedPage(
  ctx: TasksCtx,
  pending: Proposal[],
  resolved: Proposal[],
  notice: string,
): string {
  const counts = ctx.store.proposalCounts();
  const pendingHtml = pending.length
    ? `<ul class="tasks props full">${pending
        .map((p) =>
          proposalRow(ctx, p, "/tasks/proposed").replace(
            "</li>",
            `${p.notes ? `<pre class="notes">${esc(p.notes)}</pre>` : ""}</li>`,
          ),
        )
        .join("")}</ul>`
    : `<p class="muted">nothing proposed. the mail tick adds candidates twice a day; any session can add one with <code>tasks.propose</code>.</p>`;
  const resolvedHtml = resolved.length
    ? `<ul class="tasks props">${resolved
        .map((p) => {
          const id = esc(p.id);
          const what =
            p.status === "accepted"
              ? p.taskId
                ? `accepted → <a href="/tasks/${esc(p.taskId)}">the task</a>`
                : "accepted (task since deleted)"
              : `dismissed${p.dismissReason && p.dismissReason !== "owner" ? ` as ${p.dismissReason}` : ""}`;
          const when = p.resolvedAt == null ? "" : ` · ${esc(formatWhen(p.resolvedAt, ctx.tz))}`;
          const restore =
            p.status === "dismissed"
              ? `<span class="acts"><form class="inline" method="post" action="/tasks/proposed/${id}/restore">${csrfInput(ctx)}<input type="hidden" name="back" value="/tasks/proposed"><button class="btn quiet" type="submit">restore</button></form></span>`
              : "";
          return `<li><span class="title plain muted">${esc(p.title)}</span><span class="chip">${KIND_LABEL[p.kind]}</span><span class="src">${what}${when}</span>${restore}</li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">nothing resolved in the last 30 days.</p>`;
  return page(
    "proposed tasks",
    `<h1>proposed</h1>
     <p class="muted">${counts.pending} pending · ${counts.accepted} accepted · ${counts.dismissed} dismissed · times in ${esc(ctx.tz)}</p>
     <div class="bar">
       <div class="seg"><a href="/tasks">open</a><a href="/tasks?view=retired">retired</a><a class="on" href="/tasks/proposed">proposed</a></div>
       <div class="right">${staleForm(ctx, pending, "/tasks/proposed")}<a class="btn" href="/tasks/new">new task</a></div>
     </div>
     <hr class="rule">
     ${notice}
     <h3>pending <span class="muted">${pending.length}</span></h3>${pendingHtml}
     <details class="card"><summary>accepted and dismissed, last 30 days <span class="muted">${resolved.length}</span></summary>${resolvedHtml}</details>
     <p><a href="/tasks">← all tasks</a></p>`,
    { authed: true },
  );
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
  let facts = `${counts.open} open · ${counts.retired} retired`;
  let body: string;
  if (view === "open") {
    const pending = ctx.store.proposals("pending");
    facts = `${facts} · ${pending.length} proposed`;
    const att = ctx.store.attention(7);
    // The store's horizon buckets are by local day; "tomorrow" is the
    // first day of upcoming and belongs on the board, the rest in the list.
    const tomorrow = att.upcoming.filter((t) => dayDelta(t.dueAt as number, ctx.now, ctx.tz) === 1);
    const week = att.upcoming.filter((t) => !tomorrow.includes(t));
    facts = `${att.overdue.length} overdue · ${att.today.length} today · ${tomorrow.length} tomorrow · ${facts}`;
    const keep = tagFilter
      ? new Set(ctx.store.list("open", { tag: tagFilter }).map((t) => t.id))
      : null;
    const only = <T extends { id: string }>(list: T[]) =>
      keep ? list.filter((t) => keep.has(t.id)) : list;
    const todo = only([...att.overdue, ...att.today, ...tomorrow]);
    const done = ctx.store.closedToday().filter((c) => !keep || keep.has(c.task.id));
    const shown = [...todo, ...only(week), ...only(att.later)];
    const tags = ctx.store.tagsFor(shown.map((t) => t.id));
    const section = (title: string, list: Task[]) =>
      list.length
        ? `<h3>${title} <span class="muted">${list.length}</span></h3><ul class="tasks">${list.map((t) => taskRow(ctx, t, tags.get(t.id) ?? [])).join("")}</ul>`
        : "";
    const main =
      shown.length === 0 && done.length === 0
        ? `<p class="muted">${counts.open === 0 ? `nothing open. <a href="/tasks/new">add a task</a>.` : "nothing open with that tag."}</p>`
        : board(ctx, todo, done, tags) +
          section("next 7 days", only(week)) +
          section("later", only(att.later));
    // Two columns (owner, 2026-10-28): the board and lists, and beside them
    // the proposed sidebar. Under 64rem the sidebar drops below the lists.
    body = `<div class="cols"><div class="main">${main}</div>${proposedAside(ctx, pending)}</div>`;
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
     <p class="muted">${facts} · times in ${esc(ctx.tz)}</p>
     <div class="bar">
       <div class="seg">${seg("open", "/tasks", "open")}${seg("retired", "/tasks?view=retired", "retired")}</div>
       <div class="right"><a class="btn" href="/tasks/tags">tags</a><a class="btn primary" href="/tasks/new">new task</a></div>
     </div>
     <hr class="rule">
     ${notice}${filterLine}${body}`,
    { authed: true, wide: true },
  );
}

/**
 * The create form — and, given a pending proposal, the accept form: the
 * same form prefilled, the breadcrumb and notes above it, interval left on
 * one-off because the interval is the human's call, and a quiet "similar
 * open task" line when the token hint finds one. Its POST carries the
 * proposal id, so the create and the status flip are one transaction.
 */
export function newTaskPage(ctx: TasksCtx, notice: string, proposal?: Proposal): string {
  const p = proposal;
  const hint = p ? similarTaskHint(p.title, ctx.store.list("open")) : null;
  const head = p
    ? `<h1>accept proposal</h1>${notice}
       <div class="card">
         <p><span class="chip">${KIND_LABEL[p.kind]}</span>${proposalDue(p, ctx)} <span class="muted">${sourceLine(p, ctx.tz)}</span></p>
         ${p.notes ? `<pre class="notes">${esc(p.notes)}</pre>` : ""}
         ${hint ? `<p class="muted">similar open task: <a href="/tasks/${esc(hint.id)}">${esc(hint.title)}</a></p>` : ""}
       </div>`
    : `<h1>new task</h1>${notice}`;
  return page(
    p ? "accept proposal" : "new task",
    `${head}
     <form class="stack" method="post" action="/tasks">${csrfInput(ctx)}
       ${p ? `<input type="hidden" name="proposal_id" value="${esc(p.id)}">` : ""}
       <label>title</label><input type="text" name="title" required maxlength="200" value="${esc(p?.title ?? "")}" autofocus>
       <label>repeats</label>${intervalPick(p ? null : undefined)}
       <label>next occurrence is measured</label>${anchorSelect("completion")}
       <label>first due <span class="muted">(blank = one interval from now)</span></label>
       ${duePick(p?.dueAt ?? undefined, p?.hasTime ?? false, ctx.tz)}
       <label>tags</label>${tagPick(ctx.store.tags(), [])}
       <label>notes</label><textarea name="notes" maxlength="4000">${esc(p?.notes ?? "")}</textarea>
       <p class="row actions"><button class="btn primary" type="submit">${p ? "accept — create task" : "create"}</button> <a class="btn quiet" href="/tasks">cancel</a></p>
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
  // One primary per view (brain-console-design §5): done, or reopen. The
  // destructive act is quiet and pushed to the far edge.
  const actions = open
    ? `<div class="row actions">
         <a class="btn primary" href="/tasks/${id}/close?kind=completed">done</a>
         <a class="btn" href="/tasks/${id}/close?kind=cancelled">skip this one</a>
         <button class="btn" type="button" data-dialog="edit">edit</button>
         <form class="inline push" method="post" action="/tasks/${id}/retire">${csrfInput(ctx)}<button class="btn quiet danger" type="submit">retire</button></form>
       </div>
       <form class="stack card" method="post" action="/tasks/${id}/reschedule">${csrfInput(ctx)}
         <label>move the current occurrence to</label>
         ${duePick(t.dueAt as number, t.hasTime, ctx.tz, true)}
         <p><button class="btn" type="submit">reschedule</button></p>
       </form>`
    : `<div class="row actions">
         <form class="inline" method="post" action="/tasks/${id}/reopen">${csrfInput(ctx)}
           ${duePick(undefined, t.hasTime, ctx.tz)}
           <button class="btn primary" type="submit">reopen</button>
           <span class="muted">(blank date = one interval from now)</span>
         </form>
         <button class="btn" type="button" data-dialog="edit">edit</button>
         <a class="btn quiet danger push" href="/tasks/${id}/purge">delete forever</a>
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
         <p class="row actions"><button class="btn primary" type="submit">save</button>
            <button class="btn quiet" type="submit" formmethod="dialog" formnovalidate>cancel</button></p>
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
       <p class="row actions"><button class="btn primary" type="submit">confirm</button> <a class="btn quiet" href="/tasks">cancel</a></p>
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
     <form class="row actions" method="post" action="/tasks/${esc(t.id)}/purge">${csrfInput(ctx)}
       <button class="btn bad" type="submit">delete forever</button>
       <a class="btn quiet" href="/tasks/${esc(t.id)}">cancel</a>
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
              <button class="btn quiet danger" type="submit">delete</button></form>
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
