# @brain/tasks-reminder

The daily Mac reminder for the tasks tool: a launchd agent that asks the
gateway what is due and shows one read-only dialog a day. Laptop-only,
never deployed. Package documentation, not architecture — see the note at
the top of [`packages/tasks/README.md`](../tasks/README.md); the §16.6
number is kept so references resolve.

```
bun packages/tasks-reminder/src/install.ts --client-id <id>   # once per Mac
bun packages/tasks-reminder/src/reminder.ts --dry-run          # what it would show
bun packages/tasks-reminder/src/reminder.ts --force            # show it now
bun test packages/tasks-reminder
tail ~/.brain/tasks-reminder.log
```

### 16.6 The daily reminder: a local artifact

`packages/tasks-reminder` is a **launchd agent** (agent, not daemon — it
must run in the GUI session to show UI), installed per machine by
`bun packages/tasks-reminder/src/install.ts` and deliberately outside the
deploy pipeline. Its plist fires at 09:00, at login, and every 30 minutes;
the script itself enforces the spec — silent before 9am local, silent once
today's dialog has been shown (a date stamp in `~/.brain/`) — so
`max(9am, first computer open)` is a *guard*, not a scheduler, and a tick
that cannot reach the gateway leaves the stamp alone so a later tick tries
again.

**Dark wakes are not "the computer open"** (found 2026-09-24, from the
first week of logs). A closed MacBook wakes for a few seconds every quarter
hour to service TCP keepalives, launchd fires any missed ticks inside those
windows, and the network is only half up: every early failure — connect
refused, DNS timeout, the MCP SDK's default 60 s request timer expiring
while the Mac slept mid-call — ran in one, and so did the tidy 09:00 "successes", which
stamped the day from behind a closed lid. The script now reads
`pmset -g systemstate` and exits silently, stamp untouched, when the
capabilities lack `Graphics`. On a real wake Wi-Fi and the tailnet still
need a few seconds, so connect, DNS and timeout errors retry inside the
tick (three attempts, 20 s apart, logged) rather than waiting for launchd's
next one, which can be hours away once the lid closes again. Anything that
is not a network error — a 403, a refused tool — fails at once as before.

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

Files under `~/.brain`: the config (`tasks-reminder.json`: gateway and
console URLs, client id, audience, earliest hour, horizon), the day stamp
(`tasks-reminder-last`), the log (`tasks-reminder.log`), and a token cache
(`tasks-reminder-token.json`, mode 0600) holding the live `tools:read`
access token between ticks. The plist and the config hold no secrets; the
token cache does, and that is why it is the only 0600 file. The client
secret itself never touches `~/.brain`: the agent's `WorkingDirectory` is
the repo, so bun auto-loads `.env`, where `TASKS_REMINDER_CLIENT_SECRET`
lives (§9.2). The gateway URL defaults from the hook's `brain-harness.json`, so
the tailnet name never enters the public repo (§9.4).
