# Setup & Prerequisites

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 13. Human-only prerequisites

Everything an agent structurally cannot do: create accounts, accept terms, enter payment details, click "Allow" in a browser, install desktop apps, or toggle web-console settings. Listed by the phase that first needs it, so nothing is gathered before it's used.

### Already satisfied

| Item | Status |
|---|---|
| Docker, git, `gh` | installed |
| `gh` authenticated as `mars-flat` | ✅ — repo creation, pushes, branch protection, Actions config all scriptable |
| `mars-flat/brain` repo | ✅ exists, public, empty |
| **Obsidian + vault** | ✅ `brain/vault/` is an Obsidian vault |
| **OpenAI API key** | ✅ — unblocks P2 |
| **Azure subscription + credit** | ✅ — guard rails in `azure/azure-config.md`; budgets re-spaced 2026-08-27 (§3.2) |
| **Auth0 account** | ✅ tenant created 2026-08-27 — configuration is scripted (`scripts/auth0-setup.ts`), see the P5 steps below |

### Needed per phase

| Phase | What you must provide | Blocking? |
|---|---|---|
| **P0** | **Bun installed** — `curl -fsSL https://bun.sh/install \| bash`. Not currently on the machine | Trivial, but P0 doesn't run without it |
| **P1 – P2** | *nothing — all satisfied* | no |
| **P3** | Credentials for any *real* upstream MCP servers you want fronted | No — fake servers cover local dev and all tests |
| ~~**P4**~~ | ~~IdP account (Auth0/Clerk)~~ **Resolved:** local **Keycloak** container is the P4 IdP (owner, §12 Q6) — `docker compose -f deploy/keycloak/compose.yaml up -d` auto-imports the realm. **No account, no browser signup.** | **No** — fully local |
| **P5** | ~~Azure budget adjustment (§3.2); GitHub↔Entra federated credential~~ **done 2026-08-27** (budgets re-spaced; `brain-deploy` app + id-pinned federated credential; `rg-brain` + `brain-vm` provisioned). Remaining human steps: the three below | Only the Auth0 credential blocks finishing P5 |
| **P6** | **Discord application + bot token**, your Discord user ID | 🔴 **Yes** — blocks P6 |

### The three P5 human steps (2026-08-27)

1. **Auth0 Management credential** — the tenant exists but an agent cannot mint the first credential. Dashboard → Applications → Create Application → `brain-mgmt`, **Machine to Machine**, authorized for the **Auth0 Management API** with `read:/create:` scopes on clients, resource servers, and client grants. Its values go in `.env` as `AUTH0_DOMAIN` / `AUTH0_MGMT_CLIENT_ID` / `AUTH0_MGMT_CLIENT_SECRET`; then `bun scripts/auth0-setup.ts` creates everything else (API + scopes, brain-cli PKCE, brain-hook, agent-runtime, grants) and prints the follow-on `.env` lines. The credential can be deleted after setup.
2. **Tailscale** — free Personal plan is enough. Either pre-generate an auth key (admin console → Settings → Keys) into `.env` as `TAILSCALE_AUTHKEY`, or run `tailscale up` on the VM interactively. `tailscaled` is already installed by `deploy/vm/provision.sh`.
3. **GHCR package visibility** — GitHub creates `ghcr.io/mars-flat/brain-gateway` private and has no API to change it: package settings → Danger Zone → Change visibility → **Public**. Until then deploys fall back to building on the VM (works, ~3 min slower).

### Setting up the Discord bot (P6)

Fifteen minutes, all in the browser.

**1. Create the application.** [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → name it (this is what shows in the member list).

**2. Get the bot token.** **Bot** tab → **Reset Token** → copy immediately. Shown once. This is `DISCORD_BOT_TOKEN`.

**3. Leave privileged intents OFF.** On the same tab you'll see *Message Content Intent*. `MESSAGE_CONTENT` gates reading message text in **guild channels**; DMs to your bot are exempt. Since the plan is DM-only (§12 q5), leave it off — fewer permissions, and it avoids the verification requirements that kick in at scale. If you later want the bot reading a channel, that's when you enable it.

**4. Generate the invite URL.** **OAuth2 → URL Generator** → scope **`bot`** → permissions: *Send Messages*, *Read Message History*, *Embed Links*. That's enough; the Approve/Deny buttons in §6.2 are message components and need no extra permission.

**5. Create a private server and invite the bot.** This step is non-obvious and people get stuck on it: **Discord will not let you DM a bot unless you share a server with it.** So make a throwaway server (**+** in the sidebar → *Create My Own*), open the invite URL from step 4, and add the bot there. Once you share that server, DMs work. You can also just talk to it in a channel on that server — with one member it's equivalent, though §6.5 rates guild channels `low` trust and DMs `medium`, so DM if you want write operations to need one less confirmation.

**6. Copy your user ID for the allowlist.** Discord **Settings → Advanced → Developer Mode** ON, then right-click your own name → **Copy User ID**. This is `DISCORD_USER_ID`. §6.2 ignores every other sender outright, so this value is what makes the bot invisible to anyone else.

```bash
# vault/.env
DISCORD_BOT_TOKEN=...      # step 2 — rotate via Reset Token if ever exposed
DISCORD_USER_ID=...        # step 6 — the entire allowlist
DISCORD_GUILD_ID=...       # optional, if using a channel rather than DMs
```

> **The token is a full bot credential.** Anyone holding it controls the bot. It lives in `vault/.env`, which is gitignored inside a repo that is itself gitignored (§9.1) — but if it ever leaks, Reset Token immediately invalidates the old one.

### Things only you can ever do, at any phase

- **Click "Allow" on OAuth consent screens.** The gateway generates the URL and handles everything after the redirect — but the consent itself is a human act. This is by design, not a limitation.
- **Accept terms of service** for any provider.
- **Enter payment details** anywhere.
- **Approve `brain lint` proposals** and review the `quarantine/` folder. Deliberate: §5.9 emits proposals, never mutations.
- **Confirm Time Machine covers `~/brain`** and isn't excluding it (§9.1). Until this is true, the vault is one disk failure from total loss.

### Things you might assume you need but don't

| Assumption | Reality |
|---|---|
| A vector DB or embedding provider | §1 — none, unless `brain eval` later demands it |
| A domain, ever | **Not needed at all now** — no public IP means no TLS (§3.1). Only returns with WhatsApp |
| `age` installed for secret encryption | **Dropped.** `secrets-file` uses `node:crypto` (scrypt + AES-256-GCM) instead — one less install, one less binary in the container, no behaviour lost |
| `better-sqlite3`, a test runner, a transpiler | **All dropped** — `bun:sqlite`, `bun test`, and native TS replace them (§10) |
| Real upstream credentials for development | Fake MCP servers cover P3 and every test |
| A second GitHub repo for the vault | ~~§9.1 — local git repo, no remote until P5~~ done 2026-08-27: private `mars-flat/brain-vault` |
| Azure adapters (Key Vault, Storage Queue, Blob) | One VM runs fine on `secrets-file` / `queue-sqlite` / `object-fs`. Build the ports, skip the adapters (§3) |
| Caddy, TLS certs, a static IP | Dropped — Discord is outbound-only and Tailscale covers laptop access (§3.1) |

---

---

[← Index](./README.md)
