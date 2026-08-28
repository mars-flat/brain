# Handoff: W2 and the open tails

You're continuing a personal LLM system whose brain now runs **fully
remote**: an Azure VM serves the tool gateway (OAuth resource server
against the owner's Auth0 tenant) and the web console over the owner's
tailnet; deploys ride push-to-main with a doctor-gated rollback; the vault
backs itself up nightly to its private remote. **P0–P5 are done. P6
(Discord) is deferred by the owner until they provide a bot token.**
This file replaces `HANDOFF-P5-ONWARDS.md` (rotated out with P5's close).

## First: read the spec, then keep it true

1. `architecture/README.md` — locked decisions, nav, **Current status**.
2. Only the chapter for what you're touching (`§N` references are greppable).
3. The `architecture-sync` skill is mandatory: doc edits ride the same
   commit as the code that changes them. **Owner rule (2026-08-28):
   `architecture/` documents the *pattern* of connecting MCP servers, never
   individual servers** — per-server docs live in the server package's README.
4. The `brain-memory` skill: recall before acting, capture as you go. The
   brain itself now holds much of this project's history — use it.
5. Identity hygiene (§9.4) is enforced by CI: no emails, domains, tailnet
   names, or home paths in tracked files. Deployment identity lives in
   `.env` / the VM's compose `.env` / the private vault config /
   `QUESTIONS-FOR-OWNER.md` (gitignored). When this file names an account,
   it uses short-names; the mapping lives in the owner's answers file.

## W2 — Google mail + Drive behind the gateway (PLAN B: in-house)

**Decided path** (owner, 2026-08-28): Google's hosted Workspace/Gmail/Drive
MCP servers are gated behind the Workspace Developer Preview Program
(human-reviewed form); the owner declined to enroll. So: **build the thin
in-house server** over the plain REST APIs. If the owner ever enrolls,
hosted servers become a config swap at the URN seam — but do not plan on it.

### What already exists (don't redo)

- **Google Cloud**: project `brain` with Gmail API, Drive API (+ the three
  MCP APIs, unusable without preview) enabled; OAuth consent published
  ("In production" — critical: Testing mode kills refresh tokens in 7 days);
  a Desktop OAuth client whose id/secret are in the laptop `.env` as
  `GOOGLE_OAUTH_CLIENT_ID/SECRET`.
- **Consents**: `scripts/google-auth.ts <short-name> <email>` runs one
  browser consent and stores the refresh token as `${secret:google/<name>}`
  (envelope-encrypted, syncs via the vault repo). Scopes: `gmail.modify` +
  `drive`. Account short-names: `g-2k05`, `g-2006`, `g-z` (emails in
  `QUESTIONS-FOR-OWNER.md`). Check `brain secret list` — at rotation time
  `google/g-2k05` was stored; the other two consents may still be pending.
- **Policy**: the vault's `config/policy.yaml` already carries a permanent
  deny for send-shaped tools (`*.send_*`, `*send_message*`, …) and the
  `brain.ingest` allow. The send deny is an owner rule; never remove it.

### Build: `packages/mcp-google`

One stdio MCP server, instantiated per account by the gateway. Per the
owner: **mail = read + label control, structurally no send; Drive = full
CRUD with trash-first deletes.**

- `mail_search` (messages.list `q=` — full Gmail query syntax), `mail_get_message`,
  `mail_get_thread` (full bodies), `mail_list_labels`, `mail_create_label`,
  `mail_modify_labels` (add/remove label ids — covers archive = remove
  INBOX, spam = add SPAM, custom categories, read/unread). **No send tool,
  no draft tool.**
- `drive_search` (files.list `q=`), `drive_get_metadata`, `drive_read`
  (files.get alt=media; files.export for Google-native formats),
  `drive_create` (upload), `drive_update` (content + metadata:
  rename/move via files.update), `drive_copy`, `drive_trash` /
  `drive_untrash` (update `trashed`), `drive_list_recent`.
  `drive_delete_forever` only if you name it so the kind classifier flags
  it admin (§4.3) — step-up + confirm.
- Kind classification (§4.4 heuristics): the `search/get/list/read`
  prefixes auto-read; `modify/create/update/trash` fall through to write →
  the owner's default-confirm policy. Add `kinds:` overrides in
  `servers.yaml` only if a name misclassifies.
- Token handling: refresh-token → access-token exchange in-process with
  expiry-aware caching (the pattern lives in
  `packages/harness-claude-code/src/deliver.ts`). Env in: `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (resolved by the
  gateway from `${secret:google/<name>}`), `GOOGLE_ACCOUNT_LABEL`.
- Tests: fake Google token + API endpoints via `Bun.serve` (the repo has
  this pattern in `packages/console/test/mock-idp.ts` and
  `adapters/model-openai/test/batch.test.ts`). Never the real API in CI;
  never real identity in fixtures.

### Wiring (private vault, `config/servers.yaml`)

Three entries (names are URN prefixes): `g-2k05`, `g-2006`, `g-z` — each
`command: bun`, `args: [packages/mcp-google/src/main.ts]`, env as above
with its own `${secret:google/<name>}`. Do **not** wire the Workspace
`search_corpus` or any plain API as tools.

### VM prerequisites (the step everyone forgets)

1. `GOOGLE_OAUTH_CLIENT_ID/SECRET` must be added to the VM's
   `deploy/compose/.env` (they're client credentials, not account secrets).
2. **The gateway resolves `${secret:...}` on the VM, and the VM has no
   secrets master key yet** — copy it once over Tailscale SSH:
   `scp <vault>/secrets/master.key root@<vm-tailnet-name>:/data/secrets/master.key`
   (0600; path expectations in `packages/gateway` / `adapters/secrets-file`).
   The VM already holds the vault plaintext; the owner accepted this.
3. Vault `servers.yaml`/`policy.yaml` changes reach the VM via
   `git -C /data/vault pull` + gateway restart; deploys now rebuild the
   index before the doctor gate, so pushes don't fail deploys.

### Done-when

From the owner's laptop through the VM gateway (Auth0 token): search each
of the three inboxes; read a full message; archive something via
confirm; create a Drive file, rename it, trash it, untrash it. A denied
send-shaped URN test proves the policy rule fires. All in the e2e style of
`scripts/compose-smoke.sh` where feasible (fake Google API in CI).

## W1 tail — the console's front door (blocked on DNS, then small)

State: the console + gateway are healthy on the VM (loopback), tailnet-only.
**DNS is resolved**: the Vercel-DNS migration stalled ~2h15m post-delegation
(their zone activation lag — lesson: Cloudflare's pre-warmed flow next time)
but activated 2026-08-27 ~10pm. The site serves globally again, and the
`brain` subdomain A record points at the VM's tailnet IP (ttl 300) —
resolvable by anyone, reachable only on the tailnet (§15.1). The DNS-API
token for DNS-01 cert automation is `VERCEL_API_TOKEN` in `.env`
(expires ~2026-11-25 — it's on the dashboard expiry list).

Remaining, once DNS resolves (design: local `WEB-CONSOLE-DRAFT.md`,
uncommitted, has the full picture; sanitized version is
`architecture/15-console.md`):

1. Caddy in compose: DNS-01 cert, routes `/` + `/dashboard` → console
   :8091, `/mcp` → gateway :8090; retire `tailscale serve`; migrate
   `GATEWAY_RESOURCE`/`BRAIN_GATEWAY_URL`/Claude Code local-scope config to
   the real domain.
2. Auth0 `brain-console` client (confidential web app, callback
   `<base>/callback`) — doesn't exist yet: extend `scripts/auth0-setup.ts`
   (idempotent) and have the owner re-mint a Management credential for one
   run, or give them the dashboard steps. Then `CONSOLE_CLIENT_ID/SECRET`
   into the VM `.env` (placeholder sits there now).
3. Owner's first login ("Continue with Google") → pin `CONSOLE_ALLOWED_SUB`
   and add a gateway-policy principal pin.
4. Dashboard expiry tile data (`config/console.yaml` in the vault):
   `VERCEL_API_TOKEN` ~2026-11-25; the VM's Tailscale **node key**
   (~180d unless disabled per-machine); Azure sponsorship **credit expiry**
   (owner checks portal → Cost Management → Credits). Azure spend tile
   wants a Reader-scoped managed identity on the VM (designed, unbuilt).

## Standing facts a future agent should not relearn

- Three HOME gremlins: `az vm run-command`, systemd units, and the deploy
  workflow's inline script all run without `HOME`; git dies without it.
  All patched — keep `Environment=HOME=/root` / `export HOME=/root`.
- Secrets cannot transit the agent's own tool calls (permission classifier).
  Owner-run scratchpad scripts with base64-armored payloads is the pattern.
- The vault currently has two git writers (laptop CLI notes + VM
  consolidator); rebase-pull before pushing from the laptop. Long-term the
  laptop should write via the gateway.
- Whoever changes the vault must reindex (or rely on the deploy gate's
  rebuild). Salience lives only in SQLite (§5.2).
- GitHub OIDC subjects embed account/repo ids — Entra federated credentials
  must use the id-pinned form.
- Owner cost posture: Azure sponsorship credits burn first (card only on
  exhaustion/term-expiry — silent conversion, §3.2); every third-party tier
  in use is free and comfortably under its limits; the one metered thing is
  Auth0 M2M tokens (1k/mo) — the disk token caches keep usage ~5% of that.

## When you finish a chunk

Update `architecture/README.md → Current status` in the same PR, capture
decisions in the brain as they happen, and rotate this handoff when its
work is done.
