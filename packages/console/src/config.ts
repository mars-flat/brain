/**
 * Console configuration. Identity (issuer, client) comes from env — local
 * dev uses the compose Keycloak, production uses Auth0; same code. The
 * links/expiries shown on the dashboard come from the PRIVATE vault
 * (`config/console.yaml`), never from this public repo (§9.2).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ConsoleConfig {
  vaultPath: string;
  port: number;
  host: string;
  /** Public base URL (what the browser sees), e.g. https://example.com */
  baseUrl: string;
  issuer: string;
  clientId: string;
  /** Absent for public+PKCE clients (dev Keycloak); set for Auth0. */
  clientSecret?: string;
  sessionSecret: string;
  /** OIDC subs allowed in. Empty = any authenticated user (dev only). */
  allowedSubs: string[];
  /** Unauthenticated PRM endpoint of the gateway, for the health tile. */
  gatewayPrmUrl: string;
  /** Gateway upstream-status endpoint (internal; Caddy never routes it). */
  gatewayHealthUrl: string;
  sessionTtlMs: number;
}

export function loadConfig(env: Record<string, string | undefined>): ConsoleConfig {
  const vaultPath = env.BRAIN_VAULT_PATH;
  if (!vaultPath) throw new Error("console: BRAIN_VAULT_PATH is required (§9.1)");
  const port = Number(env.CONSOLE_PORT ?? 8091);
  const sessionSecret = env.CONSOLE_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 16)
    throw new Error("console: CONSOLE_SESSION_SECRET (>=16 chars) is required");
  return {
    vaultPath,
    port,
    host: env.CONSOLE_HOST ?? "127.0.0.1",
    baseUrl: (env.CONSOLE_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    issuer: env.CONSOLE_ISSUER ?? "http://localhost:8081/realms/brain",
    clientId: env.CONSOLE_CLIENT_ID ?? "brain-cli",
    clientSecret: env.CONSOLE_CLIENT_SECRET || undefined,
    sessionSecret,
    allowedSubs: (env.CONSOLE_ALLOWED_SUB ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    gatewayPrmUrl:
      env.CONSOLE_GATEWAY_PRM_URL ?? "http://127.0.0.1:8090/.well-known/oauth-protected-resource",
    gatewayHealthUrl:
      env.CONSOLE_GATEWAY_HEALTH_URL ??
      `${new URL(env.CONSOLE_GATEWAY_PRM_URL ?? "http://127.0.0.1:8090/").origin}/healthz/upstreams`,
    sessionTtlMs: 7 * 24 * 3600_000,
  };
}

interface ConsoleLink {
  title: string;
  url: string;
  group?: string;
  note?: string;
}

export interface ExpiryItem {
  name: string;
  /** YYYY-MM-DD */
  expires: string;
  note?: string;
}

/** A credential/token the owner holds for an external service. */
export interface ServiceToken {
  name: string;
  /** YYYY-MM-DD; absent = does not expire (or expiry unknown — say so in note). */
  expires?: string;
  note?: string;
}

/**
 * One external SaaS the system depends on (Azure, Auth0, …). Everything
 * here is owner-private truth (accounts, expiry dates) and so lives in the
 * vault, never this repo (§9.2/§9.4). `probe` names a built-in live check
 * the dashboard runs server-side; services without one render config-only.
 */
export interface ServiceEntry {
  name: string;
  /** Which identity the owner uses to sign in to this service. */
  account?: string;
  /** The service's official console/portal URL. */
  console?: string;
  /** Built-in live probe: azure | oidc | openai | vercel. */
  probe?: string;
  /** Azure probe only: the subscription id to query. */
  subscription?: string;
  tokens?: ServiceToken[];
  note?: string;
}

export interface VaultConsoleConfig {
  links: ConsoleLink[];
  expiries: ExpiryItem[];
  services: ServiceEntry[];
}

/** `config/console.yaml` in the private vault; absent file = empty config. */
export function loadVaultConsoleConfig(vaultPath: string): VaultConsoleConfig {
  const file = join(vaultPath, "config", "console.yaml");
  if (!existsSync(file)) return { links: [], expiries: [], services: [] };
  const raw = Bun.YAML.parse(readFileSync(file, "utf8")) as {
    links?: ConsoleLink[];
    expiries?: ExpiryItem[];
    services?: ServiceEntry[];
  } | null;
  return { links: raw?.links ?? [], expiries: raw?.expiries ?? [], services: raw?.services ?? [] };
}
