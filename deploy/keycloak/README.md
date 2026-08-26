# Local Keycloak — P4 identity provider

The gateway is an OAuth 2.1 **resource server** (§4.3). This is the IdP it
validates tokens against. Owner decision (§12 Q6): run it locally for P4;
swap to a hosted IdP at P5 by changing `GATEWAY_ISSUER` — the gateway code
is identical.

## Run it

```sh
docker compose -f deploy/keycloak/compose.yaml up -d
# wait until healthy (~20s first boot), then:
bun scripts/auth-smoke.ts
```

The realm `brain`, its five scopes, the `brain-cli` public client (PKCE
S256), and an `owner`/`owner` user all import automatically.

## Defaults (dev only)

| | |
|---|---|
| Issuer | `http://localhost:8081/realms/brain` |
| Gateway audience | `brain-gateway` |
| Admin console | `http://localhost:8081` (`admin`/`admin`) |
| Test user | `owner` / `owner` |

`start-dev` and these passwords are for local development only. At P5 the
hosted IdP replaces all of it; nothing here ships to production.

## Two credential planes (§4.3)

- **North-bound (this):** who calls the gateway. `brain-cli` is the public
  client Claude Code uses (browser + PKCE). `agent-runtime` is a
  confidential `client_credentials` client for the P6 server-side loop.
- **South-bound:** how the gateway reaches GitHub etc. — separate, held as
  envelope-encrypted secrets (`${secret:...}` refs, `adapters/secrets-file`).
  The two planes never cross: the inbound token is never forwarded upstream
  (asserted in `auth.test.ts`).
