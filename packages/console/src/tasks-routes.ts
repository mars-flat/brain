/**
 * Routes for the tasks tab (§16.4). GET renders; POST mutates the tasks
 * store and redirects (303) so a refresh never repeats a write. Every POST
 * must be same-origin and carry the session-bound CSRF token (csrf.ts).
 * Rule violations from the store become a notice on the page the user
 * came from — never a 500, never a half-applied write (each store call is
 * one transaction).
 */

import {
  type Anchor,
  type CloseKind,
  instantOf,
  parseInterval,
  TaskError,
  type TaskStore,
} from "@brain/tasks";
import type { ConsoleConfig } from "./config.ts";
import { csrfOk, csrfToken, sameOrigin } from "./csrf.ts";
import { esc, page } from "./html.ts";
import type { Session } from "./session.ts";
import { closePromptPage, newTaskPage, noticeFrom, taskPage, tasksPage } from "./tasks-view.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirect(to: string): Response {
  return new Response(null, { status: 303, headers: { location: to } });
}

function refused(message: string, status: number): Response {
  return html(
    page("tasks", `<h1>hm.</h1><p>${esc(message)}</p><p><a href="/tasks">back to tasks</a></p>`, {
      authed: true,
    }),
    status,
  );
}

const withErr = (to: string, err: string) => redirect(`${to}?err=${encodeURIComponent(err)}`);

export async function handleTasks(
  req: Request,
  url: URL,
  session: Session,
  cfg: ConsoleConfig,
  store: TaskStore,
  tz: string,
): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/tasks" && !path.startsWith("/tasks/")) return null;
  const seg = path.slice("/tasks".length).split("/").filter(Boolean);
  const ctx = { store, tz, csrf: csrfToken(session, cfg.sessionSecret), now: Date.now() };
  const when = (s: string): number => {
    try {
      return instantOf(s, tz);
    } catch (err) {
      throw new TaskError(err instanceof Error ? err.message : String(err));
    }
  };

  if (req.method === "POST") {
    if (!sameOrigin(req, cfg.baseUrl)) return refused("cross-origin form refused", 403);
    const form = await req.formData();
    const f = (k: string) => String(form.get(k) ?? "").trim();
    if (!csrfOk(f("csrf"), session, cfg.sessionSecret))
      return refused("stale form — reload the page and try again", 403);
    const intervalMs = () =>
      parseInterval(f("interval") === "custom" ? f("interval_custom") : f("interval"));

    if (seg.length === 0) {
      try {
        const t = store.create({
          title: f("title"),
          notes: f("notes"),
          intervalMs: intervalMs(),
          anchor: (f("anchor") || undefined) as Anchor | undefined,
          dueAt: f("due") ? when(f("due")) : undefined,
        });
        return redirect(`/tasks/${t.id}?ok=created`);
      } catch (err) {
        if (err instanceof TaskError) return withErr("/tasks/new", err.message);
        throw err;
      }
    }

    const [id, action] = seg;
    if (!id || !ID_RE.test(id) || !action || seg.length !== 2) return refused("not found", 404);
    const back = `/tasks/${id}`;
    try {
      switch (action) {
        case "close": {
          const kind: CloseKind = f("kind") === "cancelled" ? "cancelled" : "completed";
          const repeat = f("repeat");
          const t = store.close(id, kind, {
            repeat: repeat !== "no",
            nextDueAt: repeat === "date" ? when(f("next")) : undefined,
          });
          const verb = kind === "completed" ? "done" : "skipped";
          return redirect(`/tasks?ok=${verb}-${t.status === "open" ? "rolled" : "retired"}`);
        }
        case "reschedule":
          store.reschedule(id, when(f("due")));
          return redirect(`${back}?ok=rescheduled`);
        case "edit":
          store.update(id, {
            title: f("title"),
            notes: f("notes"),
            intervalMs: intervalMs(),
            anchor: (f("anchor") || undefined) as Anchor | undefined,
          });
          return redirect(`${back}?ok=updated`);
        case "retire":
          store.retire(id);
          return redirect(`${back}?ok=retired`);
        case "reopen":
          store.reopen(id, f("due") ? when(f("due")) : undefined);
          return redirect(`${back}?ok=reopened`);
        default:
          return refused("not found", 404);
      }
    } catch (err) {
      if (err instanceof TaskError) return withErr(back, err.message);
      throw err;
    }
  }

  // ── GET ──
  if (seg.length === 0)
    return html(
      tasksPage(
        ctx,
        url.searchParams.get("view") === "retired" ? "retired" : "open",
        noticeFrom(url),
      ),
    );
  if (seg.length === 1 && seg[0] === "new") return html(newTaskPage(ctx, noticeFrom(url)));
  const [id, action] = seg;
  if (!id || !ID_RE.test(id) || seg.length > 2) return refused("not found", 404);
  const task = store.get(id);
  if (!task) return refused(`no task “${esc(id)}”`, 404);
  if (!action) return html(taskPage(ctx, task, store.events(id), noticeFrom(url)));
  if (action === "close") {
    if (task.status !== "open") return withErr(`/tasks/${id}`, "task is not open");
    const kind: CloseKind =
      url.searchParams.get("kind") === "cancelled" ? "cancelled" : "completed";
    return html(closePromptPage(ctx, task, kind));
  }
  return refused("not found", 404);
}
