# @brain/mail-tick

The twice-daily mail tick (§16.8): a **gateway client**, like
`tasks-reminder`, never an upstream. It reads the owner's three inboxes
through the `g-*` upstreams, triages headers in one model call, extracts
tasks from the survivors, writes them to the **proposed list** with
`tasks.propose`, and files automated mail per the owner's standing Gmail
policy (inbox for action, labels for reference, archive the rest). Every
call rides `tools_call`, so policy and the hash-chained audit see it like
any other principal. This README is the package's whole documentation.

```
bun test packages/mail-tick
bun packages/mail-tick/src/main.ts --dry-run --since 3d        # what a tick would do, writing nothing
bun packages/mail-tick/src/main.ts --no-organize               # proposals + the seen-marker only
bun packages/mail-tick/src/main.ts --account g-2006            # one account
```

On the VM it runs as `brain-mail-tick.timer` at 08:00 and 16:00
America/Toronto, inside the gateway container
(`docker compose exec -T gateway bun /app/packages/mail-tick/src/main.ts`),
the same shape as the consolidate cadence (§5.8). `journalctl -u
brain-mail-tick` shows one summary line per account per tick.

## One tick

```
token      client_credentials as the `mail-tick` Auth0 M2M client (tools:read tools:write)
accounts   tools_servers → every g-* upstream that is up (no account list in the repo)
context    tasks.list(open) titles · tasks.proposals(pending) titles + entities
per account
  labels   <acct>.mail_list_labels → the real lane tree + the ids of brain/triaged and brain/archived
  search   <acct>.mail_search, 25 a page (Gmail's per-user concurrency cap), ≤ 200 a tick:
           (in:inbox OR label:<lane>…) -label:brain/triaged -category:promotions -category:social -category:forums newer_than:2d
  triage   one model call per 40 headers + snippets (no bodies, effort low, strict JSON):
           { kind: university|job|subscription|none, actionable, sender: automated|person|unsure, lane, disposition, reason }
  extract  one model call per actionable survivor, body capped at 6k chars:
           { title, kind, entity, due_date, due_time, notes, keywords, confidence, matches_existing }
  propose  tasks.propose per item with confidence ≥ 0.6 and no matches_existing; ≤ 20 created rows an account a tick
  file     mail_modify_labels, batched ≤ 50 ids, per the disposition table below — applied LAST
summary    scanned · pages · triaged-in · extracted · created · folded · duplicate · matched-existing · dropped-low · capped · marked · labeled · archived
```

**The rubric** the two prompts share (owner, 2026-10-28): *university*
(course and registrar mail with a date; entity = course code + assessment,
`cs348 a3`), *job* (applications, interviews, offers with a next step;
entity = company + stage, `shopify interview`), *subscription* (receipts,
renewals, trial-ending, price changes — proposed as *review/cancel
<service>*, due on the renewal date; entity = the service, `netflix`).
Everything else is `none`; "when unsure, none". The entity is what the
store dedupes on (§16.8), so the prompt asks for it short and stable.

**Dedupe is the store's job.** The tick carries the open-task titles and
pending proposals into the extraction prompt so the model can mark
`matches_existing`, and `tasks.propose` returns `created`, `folded` or
`duplicate` (message key, thread key, entity) — the tick only counts them.

## Filing — the disposition table

The model supplies `sender`, `lane` and a `disposition`; the table is
mechanical in `parseTriage` and `runTick`, and the hard limits are
asserted before every label call.

| Message | Lane | Inbox | Marker |
|---|---|---|---|
| sender `person` or `unsure` (any kind) — an interviewer, a professor, a reply in a thread | none | **stays, untouched** (owner, Q20: only bots get filed) | `brain/triaged` |
| automated, actionable, proposal created or folded | add if the model named one | **stays** — inbox is for action; the owner archives it | `brain/triaged` |
| automated, actionable, but the same thing as an existing task (`matches_existing`, or a duplicate of an accepted proposal) | add | **archive** | `brain/triaged` + `brain/archived` |
| automated, reference (news, security, receipts, `uw/*`…): lane named, not actionable | add | **archive** | both |
| automated, no lane, reason marketing / notification / digest / social | none | **archive** (pure marketing may be archived unlabeled — 2026-08-28 policy) | both |
| automated, reason `fyi` or `unsure` | add if named | **stays** | `brain/triaged` |
| starred | add if named | **never archived**, never un-starred | `brain/triaged` |

A human must never be filed: `looksAutomated()` (no-reply, notification,
newsletter, list and billing address shapes) overrides a model
`automated` to `unsure` when the address does not look like a system, and
`unsure` never archives. Read-state is untouched (Q21). No follow-through:
mail whose proposal was accepted or dismissed stays where it is until the
owner archives it (Q20).

**Hard limits** (`assertLabelChange`, unit-tested, visible as argument
digests in the audit chain): `remove_label_ids ⊆ {INBOX}`; `add_label_ids
⊆ {the account's listed label ids}` — which includes the two `brain/*`
markers and nothing else; never `SPAM`, `TRASH`, `UNREAD`, `STARRED`. The
tick never creates a label, never touches a filter, never reads Drive,
and the gateway's permanent no-send deny stays.

**`brain/triaged` is the seen-marker.** The search excludes it, so a tick
that died halfway re-sees only the unmarked remainder, and the store's
message key absorbs any repeat. It is applied last, after every propose
for the batch returned. **`brain/archived`** marks everything the tick
ever moved: `label:brain/archived` is the one-search undo. Both labels
are created once per account in the ops step; an account without them
gets a warning in the summary and no filing (proposals still happen —
the window alone then bounds the scan, so the model re-reads two days of
headers each tick until the label exists).

## Running it

| Env | Meaning |
|---|---|
| `MAIL_TICK_CLIENT_ID` / `MAIL_TICK_CLIENT_SECRET` | the `mail-tick` Auth0 M2M client (`scripts/auth0-setup.ts`), VM `.env` |
| `GATEWAY_AUDIENCE` | the canonical resource URL, as the gateway has it |
| `MAIL_TICK_GATEWAY_URL` | default `http://127.0.0.1:8090/mcp` — inside the container |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | the model; the base URL is a test override (fake OpenAI in the smoke) |
| `MAIL_TICK_MODEL` | default `gpt-5.6-luna` |
| `TASKS_TZ` | the owner's zone, for dates in notes and the search |
| `MAIL_TICK_CONFIG` | optional JSON in the private vault: `{ "accounts": { "g-x": { "lanes": ["uw"], "hint": "the university account" } } }` |
| `MAIL_TICK_TOKEN_CACHE` | default `/data/tasks/mail-tick-token.json` (0600) |

Flags: `--dry-run` (print would-be proposals and label changes, write
nothing), `--since 3d` (the search window; use 3d on the first run),
`--no-organize` (proposals and the marker only), `--account g-x`
(repeatable). Exit 1 only when every account stopped early.

**Private policy** (first match wins, before the global `kind: read →
allow`; principal = the client's `sub`, `<client_id>@clients`):

```yaml
- match: { principal: ["<mail-tick client_id>@clients"], tool: "tasks.propose" }
  effect: allow
- match: { principal: ["<mail-tick client_id>@clients"], tool: "g-*.mail_modify_labels" }
  effect: allow
- match: { principal: ["<mail-tick client_id>@clients"], kind: [write, admin] }
  effect: deny
  reason: "the mail tick proposes and labels; it creates, closes, dismisses, filters, sends nothing"
```

So the tick structurally cannot create or close a task, dismiss or
restore a proposal, create a label or filter, touch Drive, or write the
brain. A `needs_confirm` from the gateway means an allow is missing; the
tick reports it as `stopped:` and marks nothing.

**Pacing.** The gateway's 120/min window is shared by every principal;
the tick holds itself to one call a second and backs off (15s, 30s, 60s)
on `rate_limited`. A 3-day first run over three inboxes is minutes.

**Cost.** Triage is a call per 40 messages, extraction a call per
actionable survivor, all at `low` effort with a stable prompt prefix:
well under a dollar a month.

## Tests

`test/core.test.ts` — the query, the strict schemas, defensive parsing of
both stages, the disposition table row by row, propose arguments, label
batching, the hard limit. `test/tick.test.ts` — one tick against a
scripted gateway and model: proposals, the marker last, archive on and
off, the starred rule, the human-override, `matches_existing`, the
confidence floor, the cap, pagination, dry-run, a failure leaving mail
unmarked, a missing marker label, upstream selection.
