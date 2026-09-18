# @brain/tasks

Recurring tasks as a **separate tool** from the brain: a pure recurrence
core, its own SQLite store, and the `tasks.*` MCP upstream. The design is
`architecture/16-tasks.md`; this file is the operator's card.

- **Rules:** a task has at most one open occurrence; completing or
  cancelling it schedules the next one (`interval` after now, or after the
  due date for due-anchored tasks — late by any amount means one roll,
  never a pile-up); every task repeats until retired.
- **Store:** `TASKS_DB_PATH` (absolute, or the upstream refuses to start),
  WAL, shared by the console's `/tasks` tab and this upstream. Source of
  truth — a schema mismatch means migrate, never delete.
- **Zone:** `TASKS_TZ` (IANA; UTC when unset) decides "due today". A task
  is due on a *day* unless given a time; date-only tasks sit at local noon.
- **Tags:** user tags are managed in the console (`/tasks/tags`) and
  assigned by name; the interval and status of a task are tags too,
  derived and read-only. Permanent deletion of a retired task (purge) is
  console-only.
- **Roster entry:** see `examples/vault-example/config/servers.yaml` —
  copy it into the private vault's `config/servers.yaml` on the VM.

```
bun test packages/tasks                       # properties + store + tools
TASKS_DB_PATH=/abs/path/tasks.db bun packages/tasks/src/main.ts   # stdio server
```

The daily Mac reminder lives in `packages/tasks-reminder` (install once
with `bun packages/tasks-reminder/src/install.ts --client-id <id>`; try it
with `bun packages/tasks-reminder/src/reminder.ts --dry-run`).
