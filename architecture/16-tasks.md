# The Tasks Surface

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 16. `packages/tasks` — recurring tasks: a separate tool with its own store

Added 2026-09-18 at the owner's request: a task dashboard behind the console
login (§15) and a daily, read-only reminder on the Mac. One design question
mattered and the owner ruled on it before a line was written: **tasks are a
separate tool from the brain, with their own SQLite store** — not vault
nodes, not routed through the single-writer consolidator (§5.7). Scheduling
state is deterministic and relational; memory is narrative and append-only.
Neither is forced into the other's shape, and the brain does not know tasks
exist. §16.7 records the projection that would change that, deliberately
unbuilt.

Three packages: `packages/tasks` (the pure recurrence core, the store, the
`tasks.*` MCP upstream), the console's tasks tab (`packages/console`,
§16.4), and `packages/tasks-reminder` (the launchd agent, laptop-only,
never deployed).

### 16.1 The owner's spec

- **Recurrence anchors to completion, not to a calendar.** Every task
  carries an interval. The next occurrence is scheduled only when the
  current one is completed or cancelled, `interval` from that moment. If a
  task goes late, *nothing happens*: no second instance, no pile-up. An
  advanced toggle anchors to the original due date instead, or places the
  next occurrence by hand.
- **Opt-out, not opt-in.** Complete or cancel, then "schedule again?
  yes / no", defaulting to yes. Every task recurs until you say otherwise.
- **An authenticated dashboard on the owner's domain** for configuring all
  of it, and **a read-only daily modal on the Mac** at
  `max(9am, first computer open)` that links out to the dashboard.

### 16.2 The recurrence model

The "anchor to completion" rule has one structural consequence that shapes
everything below: **a task has at most one open occurrence, ever.** There
is no occurrence table, no backfill, no overdue fan-out — the task row *is*
the open occurrence.

```
tasks(id, title, notes, interval_ms?, anchor, status, due_at?, created_at, updated_at,
      last_closed_at?, closes)
  anchor := 'completion' | 'due'      -- 'due' is the advanced toggle
  status := 'open' | 'retired'        -- open ⇔ due_at IS NOT NULL (a CHECK constraint)
task_events(id, task_id, at, kind, detail json)   -- append-only by trigger
  kind := created | completed | cancelled | rolled | rescheduled | edited | retired | reopened
```

"Done" and "cancelled" are **events on the occurrence, not task states**:
closing an open occurrence immediately rolls the task to its next one
(the yes default) or retires it (the opt-out). The two verbs differ only in
the event they leave behind — which is exactly the signal a later reader
would want ("skipped four times, done twice").

Transitions are pure functions in `core.ts` — no I/O, no clock, `now` is a
parameter — so the rules are property-tested (§8.3 style, `fast-check`):

| Invariant | Statement |
|---|---|
| **One occurrence** | `status = open ⇔ due_at ≠ null`, enforced by the database and asserted after every random op |
| **No pile-up** | Closing a due-anchored task late by *k* intervals emits exactly one `rolled` event; the next due is the first slot strictly after `max(now, due)`, keeps the cadence phase (`(next − due) mod interval = 0`), and is within one interval of `max(now, due)` |
| **Completion anchor** | `next = now + interval`, however late |
| **Opt-out** | `repeat = false` (or a one-off's default) retires: `due_at = null`, events `[closed, retired]` |
| **Replay** | `foldEvents(events(id))` deep-equals `get(id)` after any random history — the log is a second derivation of the truth, not a decoration |
| **Determinism** | Same ops + same clock → identical rows and logs |

Two edges worth knowing: a one-off asked to repeat with no manual date is a
rule violation (there is nothing to add the interval to), and an *early*
close of a due-anchored task rolls to the slot after the due date it had —
that is what "anchored to the due date" means, not "interval from now".

### 16.3 Storage: own SQLite beside the vault, two writers by design

The store is `$BRAIN_DATA_DIR/tasks/tasks.db` on the VM's data disk —
**beside** `vault/`, never inside it (the vault is git; a database is not
source you diff, and `_index/` is derived state, which this is not). It is
**source of truth, not a cache**: nothing rebuilds it, so the schema
version in `tasks_meta` is a migration gate, and the error on mismatch says
"migrate it, never delete it" — the opposite of `brain.db`'s advice.

Two processes open the same file: the **console** (the human's write path,
§16.4) and the **tasks MCP upstream** spawned by the gateway (§16.5). Both
containers bind-mount the same host directory; SQLite in WAL mode with a
`busy_timeout` is the whole concurrency story for one user. The mount is
created with the container uid by `deploy/vm/deploy.sh` (idempotent
`install -d`) before `compose up`, because Docker would otherwise create it
root-owned and the console would crash-loop on first deploy.

Rules the code enforces rather than documents: the one-occurrence CHECK
(§16.2); `BEFORE UPDATE/DELETE` triggers that make `task_events` append-only
at the engine; and `TASKS_DB_PATH` **must be absolute** or the upstream
refuses to start — the §4.3 spawn-boundary lesson, applied before it bites
again.

**Time.** Instants are unix ms in storage and ISO on the wire; a zone
matters only at the day boundary ("due today") and in what a human reads.
`TASKS_TZ` (IANA; UTC when unset or unknown) is read by both the console
and the upstream. Zone math is Intl-only — no library — with a fixed-point
inverse for wall-time → instant that survives DST edges (property-tested
across five zones).

**Backup.** `brain backup` now tarballs `tasks/` beside `vault/`,
snapshotting the live database with `VACUUM INTO` first so a WAL file is
never captured mid-write. `scripts/restore-drill.sh` restores both.

### 16.4 The console tab: the first write path

`/tasks` is a tab on the existing console, not a subdomain (§12 Q10): the
dashboard, one login, one cert. Since 2026-09-18 it is also the **front
door** — the root URL redirects here and tasks leads the top bar (owner's
call; the graph moved back to its own `/graph` route, §15.3). Server-rendered, forms that **POST and
303-redirect** so a refresh never repeats a write — the same pattern the
dashboard's refresh button already used. No JavaScript was added.

§15.3's "the console never writes" is now "the console never writes **the
vault**". The tasks store is the one thing it writes, and that write path
carries its own defence, because `SameSite=Lax` on the session cookie is
most of CSRF protection but not all of it: every mutating form embeds a
token bound to the session (HMAC of `sub` + expiry under the session
secret — nothing to store), every POST must also prove same-origin via
`Origin` (or `Referer`), and the CSP gained `form-action 'self'`. A POST
failing either check is a 403 page, never a write.

The completion flow is the owner's spec verbatim: *done* or *skip* on a
row → a page asking **schedule again?** with three answers — *yes* (the
default button, showing the computed next date and why), *yes, on a date I
pick* (a `datetime-local` prefilled with the computed date), *no — retire*.
For a one-off the default flips to *no*. The handoff's counter-proposal —
complete immediately and show an inline reversible line — is recorded in
§12 Q14 and would be a one-file swap; the blocking prompt shipped because
it is what was asked for.

Rule violations from the store (empty title, next date in the past, closing
a retired task) come back as a notice on the page the user came from — the
store's transactions mean a refused write is a no-op, never a half-write.
Ids are opaque UUIDs; hostile ids are rejected by regex before SQL.

### 16.5 The `tasks.*` upstream

`packages/tasks/src/main.ts` is a stdio MCP server the gateway spawns from
the private vault's `config/servers.yaml`, exactly like `brain` and the
Google instances (the example vault carries the synthetic entry). Ten tools,
plain JSON Schemas, risk kinds via annotations (§4.4):

```
tasks.list(status=open|retired|all)      read
tasks.get(id)                             read   → task + full event history
tasks.due(horizon_days=3)                 read   → overdue / today / upcoming / later, by LOCAL day
tasks.create(title, interval, notes?, anchor?, due_at?)          write
tasks.complete(id, repeat?, next_due_at?)                         write
tasks.cancel(id, repeat?, next_due_at?)                           write
tasks.reschedule(id, due_at)  tasks.update(id, …)  tasks.retire(id)  tasks.reopen(id, due_at?)   write
```

Reads carry `readOnlyHint`; nothing carries `destructiveHint` — retire is
reversible by reopen and the log cannot be deleted — so writes fall to the
policy's confirm default (§4.5) unless the owner's private policy allows
them for trusted surfaces, the way `brain.ingest` is. Scopes are the
generic tiers: `tools:read` for the reads, `tools:write` for the rest. Date
arguments accept ISO with an offset or a bare wall time in `TASKS_TZ`;
results carry both the ISO instant and a human rendering ("in 3 days",
"2 days overdue").

This is what makes tasks reachable from **every Claude surface** — laptop
sessions, cloud routines, the phone — for the cost of one roster entry: the
progressive-disclosure index, policy, confirm tokens, and the hash-chained
audit already exist. The compose e2e smoke (§8.2) drives create → due →
complete through the real gateway against the shared mount.

### 16.6 The daily reminder: a local artifact

`packages/tasks-reminder` is a **launchd agent** (agent, not daemon — it
must run in the GUI session to show UI), installed per machine by
`bun packages/tasks-reminder/src/install.ts` and deliberately outside the
deploy pipeline. Its plist fires at 09:00, at login, and every 30 minutes;
the script itself enforces the spec — silent before 9am local, silent once
today's dialog has been shown (a date stamp in `~/.brain/`) — so
`max(9am, first computer open)` is a *guard*, not a scheduler, and a tick
that finds no tailnet simply retries half an hour later without touching
the stamp.

Read-only by construction: it calls `tasks.due` through the gateway with a
**client-credentials token from its own Auth0 client, `tasks-reminder`,
granted `tools:read` and nothing else** — a client that structurally cannot
hold a write scope. Token minting reuses the SessionEnd hook's code
(`clientCredentialsToken`, now scope-parameterised). If nothing is overdue
or due today it stays silent; otherwise a **System Events `display
dialog`** — a real modal, frontmost, no notification permission needed
(verified live 2026-09-17; Notification Center banners would need Script
Editor allowed) — shows the count and the first few lines with *Later* /
*Open*, and *Open* launches the console's `/tasks`. Every failure path
exits 0 and logs to `~/.brain/tasks-reminder.log`.

Secrets: the plist and the config file (`~/.brain/tasks-reminder.json`:
URLs, client id, hour) hold none. The agent's `WorkingDirectory` is the
repo, so bun auto-loads `.env`, where `TASKS_REMINDER_CLIENT_SECRET` lives
(§9.2). The gateway URL defaults from the hook's `brain-harness.json`, so
the tailnet name never enters the public repo (§9.4).

### 16.7 Deliberately not built

- **Projecting completions into the vault** (the handoff's hybrid). The
  event log is what such a projection would read — "rescheduled four
  times" is already answerable from `tasks.get` — but the owner chose a
  clean separation, and a `task_events → brain.note` bridge is a small,
  separate decision for later. Nothing in §16.3 precludes it.
- **A `tasks.` subdomain.** Costs a cert + timer, a Caddy block, an Auth0
  client and callback, a session secret, and a compose service to deliver
  a tab. Revisit only if tasks must outlive a brain outage or be reachable
  off the tailnet (§12 Q10).
- **Inline, non-blocking completion** (§12 Q14) and a due-count tile on
  `/dashboard` — both cheap, neither asked for.
- **A `brain doctor` check on the store** — the console healthcheck and
  the gateway's upstream status (§15.4) already surface a missing or
  unreadable file.

---

---

[← Index](./README.md)
