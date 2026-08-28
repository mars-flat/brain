# Handoff: W2 and the small tails

You're continuing a personal LLM system whose brain runs **fully remote
behind its own domain**: an Azure VM serves the tool gateway (OAuth
resource server against the owner's Auth0 tenant) and the web console —
live vault viewer + ops dashboard — through a Caddy TLS edge on the
owner's real domain, reachable **only over their tailnet** (public DNS
resolves to a tailnet IP nothing else can route). Deploys ride
push-to-main with a doctor-gated rollback; the vault backs itself up
nightly to its private remote; the owner has logged in and the console is
**pinned to their identity**. **P0–P5 and the W1 console/edge are done.
P6 (Discord) stays deferred until the owner provides a bot token.**

## First: read the spec, then keep it true

1. `architecture/README.md` — locked decisions, nav, **Current status**.
2. Only the chapter for what you're touching (`§N` refs are greppable;
   the console/edge chapter is `architecture/15-console.md`).
3. The `architecture-sync` skill is mandatory: doc edits ride the same
   commit as the code. **Owner rule: `architecture/` documents the
   *pattern* of connecting MCP servers, never individual servers** —
   per-server docs live in the server package's README.
4. The `brain-memory` skill: recall before acting, capture as you go —
   the brain holds this project's history, including everything below.
5. Identity hygiene (§9.4), CI-enforced: no emails, domains, tailnet
   names, subs, or home paths in tracked files. Deployment identity lives
   in `.env`, the VM's compose `.env`, the private vault config, and
   `QUESTIONS-FOR-OWNER.md` (gitignored). This file uses short-names.

## W2 — Google mail + Drive behind the gateway (the main build)

**Decided**: Google's hosted Workspace MCP servers are preview-gated
(human-reviewed form; owner declined). Build the **thin in-house server**
over the plain REST APIs. Hosted becomes a config swap at the URN seam if
the owner ever enrolls — don't plan on it.

### Ready and verified (don't redo)

- **Google Cloud**: project `brain`; Gmail + Drive APIs enabled; consent
  screen **published/In production** (Testing mode kills refresh tokens
  in 7 days); Desktop OAuth client in laptop `.env` as
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
- **All three consents are DONE and verified**: refresh tokens stored as
  `${secret:google/g-2k05|g-2006|g-z}` (envelope-encrypted, synced via
  the vault repo), scopes `gmail.modify` + `drive`, each proven live
  against Gmail (labels.list) and Drive (about.get) REST with correct
  identity. Re-consent if ever needed: `scripts/google-auth.ts`.
- **Policy**: the vault's `config/policy.yaml` permanently denies
  send-shaped tools (`*.send_*`, `*send_message*`, …). Owner rule; never
  remove. `brain.ingest` allow for http/cli is also there.

### Build: `packages/mcp-google`

One stdio MCP server, instantiated per account. **Mail = read + label
control, structurally no send (no send/draft tools); Drive = full CRUD,
trash-first deletes.**

- `mail_search` (messages.list `q=`), `mail_get_message`,
  `mail_get_thread` (full bodies), `mail_list_labels`,
  `mail_create_label`, `mail_modify_labels` (add/remove ids — archive =
  remove INBOX, spam = add SPAM, custom categories, read/unread).
- `drive_search` (files.list `q=`), `drive_get_metadata`, `drive_read`
  (alt=media; files.export for Google-native), `drive_create`,
  `drive_update` (content + rename/move), `drive_copy`, `drive_trash`/
  `drive_untrash`, `drive_list_recent`. `drive_delete_forever` only if
  named so the §4.4 classifier flags it admin (step-up + confirm).
- Kinds: `search/get/list/read` prefixes auto-read; the rest fall to
  write → default-confirm. `kinds:` overrides in `servers.yaml` if needed.
- Tokens: refresh→access exchange in-process with expiry caching (pattern:
  `packages/harness-claude-code/src/deliver.ts`). Env: the two client
  vars, `GOOGLE_REFRESH_TOKEN` (gateway resolves `${secret:google/<n>}`),
  `GOOGLE_ACCOUNT_LABEL`.
- Tests: fake Google endpoints via `Bun.serve` (patterns:
  `packages/console/test/mock-idp.ts`,
  `adapters/model-openai/test/batch.test.ts`). No real APIs or identity
  in CI/fixtures.

### Wiring + VM prerequisites

- Private vault `config/servers.yaml`: three entries `g-2k05`/`g-2006`/
  `g-z`, `command: bun`, `args: [packages/mcp-google/src/main.ts]`, each
  with its own secret ref. Don't wire Workspace `search_corpus` or plain
  APIs as tools.
- `GOOGLE_OAUTH_CLIENT_ID/SECRET` → VM `deploy/compose/.env` (client
  creds, not account secrets — owner-run push script pattern).
- **The VM has no secrets master key**: copy once,
  `scp <vault>/secrets/master.key root@<vm>:/data/secrets/master.key`
  (0600). Without it the gateway can't resolve `${secret:...}` upstreams.
- Vault config reaches the VM via `git -C /data/vault pull` + gateway
  restart; deploys rebuild the index before the doctor gate.

### Done-when

Through `https://<domain>/mcp` with an Auth0 token: search all three
inboxes, read a full message, archive via confirm; Drive create → rename
→ trash → untrash. A send-shaped URN is denied by policy. E2e in the
`scripts/compose-smoke.sh` style with a fake Google API in CI.

## Small tails (nothing blocking; pick off opportunistically)

1. ~~**Dashboard config**~~ — done (W1.6, 2026-08-28): `config/console.yaml`
   written in the private vault with links, the expiry radar, and the new
   `services:` section (per-service accounts, consoles, token expiries,
   live probes — §15.4). Two facts inside it need owner confirmation
   (OpenAI login, real credit expiry — see `QUESTIONS-FOR-OWNER.md`).
2. **Gateway principal pinning** — the console is pinned
   (`CONSOLE_ALLOWED_SUB` on the VM), the gateway is not. Careful design:
   the policy language has no negation, and `brain-hook`'s
   client-credentials subject (`<clientid>@clients`) must stay allowed.
3. ~~**Azure spend tile**~~ — built (W1.6): ARM via the VM's managed
   identity, az-CLI fallback in dev. Identity enabled AND Reader granted
   (owner-run 2026-08-28, `azure/azure-config.md` §7). Goes live on the
   VM with the next deploy; end-to-end IMDS check pending until then.
4. **Laptop as second vault writer** — CLI notes still commit locally;
   rebase-pull before pushing. Long-term: laptop writes via the gateway.

## Standing facts a future agent should not relearn

- **HOME gremlins ×3**: `az vm run-command`, systemd units, and the
  deploy workflow's inline script all run without `HOME`; git dies. Keep
  `Environment=HOME=/root` / `export HOME=/root`.
- **Secrets cannot transit the agent's own tool calls** (permission
  classifier). Owner-run scratchpad scripts with base64-armored payloads.
- **lego is v5**: env-driven CLI (`LEGO_*` vars + bare `run`); the v4
  flag syntax is gone. `deploy/vm/certs.sh` is correct; monthly
  `brain-certs.timer` renews and reloads Caddy.
- **The edge is a compose profile** (`edge`), enabled only on the VM via
  `COMPOSE_PROFILES=edge` in its `.env` — dev stacks never interpolate
  it. Caddy must not start before `certs.sh` has run once.
- **Whoever changes the vault must reindex** (or rely on the deploy
  gate's rebuild). Salience lives only in SQLite (§5.2).
- **The vault belongs to uid 1000** (the container user); root operates
  git for push/backup only. Any root-context write (ad-hoc pull, root
  exec) strands root-owned files the consolidator EACCESes on. Deploys
  self-heal ownership; `deploy/vm/vault-pull.sh` is the safe ad-hoc pull.
- **GitHub OIDC subjects embed account/repo ids** — Entra federated
  credentials must use the id-pinned form.
- **Vercel DNS zone activation lags delegation** (~2h REFUSED window,
  unboundable). If DNS ever moves again: Cloudflare's pre-warmed flow.
- **Cost posture**: Azure sponsorship credits burn first (silent
  pay-as-you-go conversion only on exhaustion/term-expiry, §3.2); all
  third-party tiers are free and far under limits; Auth0 M2M tokens
  (1k/mo) are the one metered thing — disk token caches keep it ~5%.

## Judgment calls (standing policy — survives handoff rotations)

Also captured in the brain as `owner-question-handling-policy`; if you
rotate this handoff, carry this section forward or re-capture it first.

- **Decide yourself and note it**: library choices within the
  constraints, file organization, test structure — anything a careful
  engineer would just pick.
- **Ask the owner** for anything that changes a locked decision in
  README §0, adds a paid service or a human setup step, or touches the
  vault/public-repo boundary.
- **Non-blocking questions** accumulate in `QUESTIONS-FOR-OWNER.md`
  (repo root, gitignored); the owner answers inline between work chunks.
  Check it at session start.
- **Blocked work still files its question there — then pivot** to other
  work rather than stalling. Genuinely interactive decisions in a live
  session use AskUserQuestion.
- **Every open question ships with a stated default** so silence never
  blocks (the §12 table's "my default if you don't weigh in" column).

## When you finish a chunk

Update `architecture/README.md → Current status` in the same PR, capture
decisions in the brain as they happen, and rotate this handoff when its
work is done.
