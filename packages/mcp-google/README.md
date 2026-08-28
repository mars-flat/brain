# @brain/mcp-google

A thin stdio MCP server over the plain Gmail and Drive REST APIs,
**instantiated once per Google account** behind the gateway. Built in-house
(W2) because Google's hosted Workspace MCP servers sit behind a
human-reviewed preview; if that ever changes, hosted becomes a config swap
at the URN seam — nothing here depends on it.

## Tool surface

**Mail is read + label control. There is structurally no send or draft
tool** — Gmail's `gmail.modify` scope technically permits sending, so the
guarantee is the absent tool surface plus the gateway's permanent policy
deny on send-shaped names (`*.send_*`, `*send_message*`, …). Never add one.

| Tool | Kind | Notes |
|---|---|---|
| `mail_search` | read | Gmail query syntax (`from:`, `is:unread`, `newer_than:7d`); summaries with headers + snippet |
| `mail_get_message` / `mail_get_thread` | read | full decoded bodies — text/plain preferred, html fallback, 50k-char cap |
| `mail_list_labels` / `mail_create_label` | read / write | |
| `mail_modify_labels` | write | add/remove label ids; archive = remove `INBOX`, spam = add `SPAM`, read/unread = `UNREAD` |
| `drive_search` / `drive_get_metadata` / `drive_list_recent` | read | `files.list` q syntax; trashed excluded unless `include_trashed` |
| `drive_read` | read | Google-native files export (Docs→markdown, Sheets→CSV); text capped at 100k chars; small binaries as base64 |
| `drive_create` / `drive_update` / `drive_copy` | write | content, rename, move between folders |
| `drive_trash` / `drive_untrash` | write | the default, reversible delete |
| `drive_delete_forever` | **admin** | `destructiveHint` → step-up + confirm at the gateway; irreversible |

Kinds ride MCP annotations (`readOnlyHint` on reads, `destructiveHint` on
the permanent delete); everything else falls to the gateway's write →
default-confirm.

## Environment

| Var | Meaning |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | the Desktop OAuth client (client creds, not account secrets) |
| `GOOGLE_REFRESH_TOKEN` | per-account; the gateway resolves `${secret:google/<name>}` at spawn |
| `GOOGLE_ACCOUNT_LABEL` | owner short-name (`g-…`) — lands in tool descriptions so search can tell accounts apart |
| `GOOGLE_TOKEN_URL`, `GOOGLE_GMAIL_BASE`, `GOOGLE_DRIVE_BASE`, `GOOGLE_UPLOAD_BASE` | test/e2e overrides; default to the real Google endpoints |

Access tokens are minted from the refresh token in-process and cached with
a 60s expiry skew; a 401 mid-flight forces exactly one re-mint and retry.
Consent (or re-consent after revocation): `bun scripts/google-auth.ts
<short-name> <email>` — the consent screen must be **published/In
production**, since Testing-mode refresh tokens die in 7 days.

## Wiring

One `servers.yaml` entry per account in the private vault's `config/`
(§4.2 — the public repo carries only the synthetic example):

```yaml
- name: g-example            # URN prefix → g-example.mail_search
  command: bun
  args: [packages/mcp-google/src/main.ts]
  env:
    GOOGLE_OAUTH_CLIENT_ID: ${GOOGLE_OAUTH_CLIENT_ID}
    GOOGLE_OAUTH_CLIENT_SECRET: ${GOOGLE_OAUTH_CLIENT_SECRET}
    GOOGLE_REFRESH_TOKEN: ${secret:google/g-example}
    GOOGLE_ACCOUNT_LABEL: g-example
```

## Tests

`test/fake-google.ts` fakes the token endpoint plus the Gmail/Drive REST
slices this server touches (Bun.serve, in-memory, no real APIs or identity
— §8.2). The unit suite drives the server over a real MCP client pair; the
compose e2e smoke (`scripts/compose-smoke.sh`) wires a `g-test` instance
against the same fake through the full composed stack, confirm tokens and
the no-send policy deny included.
