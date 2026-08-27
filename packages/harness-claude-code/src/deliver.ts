/**
 * Remote episode delivery (P5, §6.4): SessionEnd POSTs the envelope to the
 * gateway's `brain.ingest` tool instead of running the local CLI. The wire
 * is spec-shaped end to end — the issuer comes from the gateway's RFC 9728
 * PRM document, the token endpoint from OIDC discovery, the credential is
 * a client_credentials grant (the §4.3 headless plane), and the call is a
 * normal MCP `tools_call`. Tokens are cached on disk because SessionEnd is
 * a fresh process every time and IdP free tiers meter M2M tokens.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EpisodeEnvelope } from "@brain/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface DeliveryTarget {
  /** The gateway MCP endpoint, e.g. https://vm.tailnet.ts.net/mcp */
  gatewayUrl: string;
  clientId?: string;
  clientSecret?: string;
  /** Auth0 requires an audience on client_credentials; Keycloak ignores it. */
  audience?: string;
  /** Pre-acquired bearer — skips the whole token flow (tests, smoke). */
  token?: string;
  tokenCachePath?: string;
}

export interface DeliveryResult {
  episode_id: string;
  new_nodes: number;
  quarantined: number;
  /** True when the server queues for its batch cadence (§5.8) instead of consolidating inline. */
  queued: boolean;
}

/**
 * Env wins over the install()-written config file: the file is what makes a
 * fresh machine work, the env is how you point one session elsewhere.
 */
export function resolveDeliveryTarget(
  env: Record<string, string | undefined>,
  projectDir: string,
): DeliveryTarget | null {
  let fromFile: Partial<DeliveryTarget> = {};
  try {
    fromFile = JSON.parse(
      readFileSync(join(projectDir, ".claude", "brain-harness.json"), "utf8"),
    ) as Partial<DeliveryTarget>;
  } catch {
    // no config file — env may still carry everything
  }
  const gatewayUrl = env.BRAIN_GATEWAY_URL ?? fromFile.gatewayUrl;
  if (!gatewayUrl) return null;
  return {
    gatewayUrl,
    clientId: env.BRAIN_HOOK_CLIENT_ID ?? fromFile.clientId,
    clientSecret: env.BRAIN_HOOK_CLIENT_SECRET,
    audience: env.BRAIN_HOOK_AUDIENCE ?? fromFile.audience,
    tokenCachePath: fromFile.tokenCachePath,
  };
}

type Fetch = typeof fetch;

/** RFC 9728: the resource names its own authorization server. */
export async function issuerFromPrm(gatewayUrl: string, fetchFn: Fetch = fetch): Promise<string> {
  const base = gatewayUrl.replace(/\/mcp\/?$/, "");
  const res = await fetchFn(`${base}/.well-known/oauth-protected-resource`);
  if (!res.ok) throw new Error(`PRM fetch failed: HTTP ${res.status}`);
  const prm = (await res.json()) as { authorization_servers?: string[] };
  const issuer = prm.authorization_servers?.[0];
  if (!issuer) throw new Error("PRM names no authorization server");
  return issuer;
}

export async function tokenEndpoint(issuer: string, fetchFn: Fetch = fetch): Promise<string> {
  const res = await fetchFn(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`issuer discovery failed: HTTP ${res.status}`);
  const meta = (await res.json()) as { token_endpoint?: string };
  if (!meta.token_endpoint) throw new Error("issuer metadata has no token_endpoint");
  return meta.token_endpoint;
}

interface CachedToken {
  key: string;
  access_token: string;
  /** Unix seconds. */
  expires_at: number;
}

export function defaultTokenCachePath(): string {
  return join(homedir(), ".brain", "harness-token.json");
}

/** 60s skew: never present a token that dies mid-ingest. */
const EXPIRY_SKEW_S = 60;

export async function clientCredentialsToken(
  target: DeliveryTarget,
  fetchFn: Fetch = fetch,
  now: () => number = Date.now,
): Promise<string> {
  if (target.token) return target.token;
  if (!target.clientId || !target.clientSecret)
    throw new Error("no credentials: set BRAIN_HOOK_CLIENT_ID and BRAIN_HOOK_CLIENT_SECRET");

  const cachePath = target.tokenCachePath ?? defaultTokenCachePath();
  const cacheKey = `${target.gatewayUrl} ${target.clientId}`;
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as CachedToken;
    if (cached.key === cacheKey && cached.expires_at - EXPIRY_SKEW_S > now() / 1000)
      return cached.access_token;
  } catch {
    // absent or unreadable cache is a cache miss
  }

  const issuer = await issuerFromPrm(target.gatewayUrl, fetchFn);
  const endpoint = await tokenEndpoint(issuer, fetchFn);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: target.clientId,
    client_secret: target.clientSecret,
    scope: "brain:write",
  });
  if (target.audience) body.set("audience", target.audience);
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${await res.text()}`);
  const tok = (await res.json()) as { access_token: string; expires_in?: number };

  const record: CachedToken = {
    key: cacheKey,
    access_token: tok.access_token,
    expires_at: Math.floor(now() / 1000) + (tok.expires_in ?? 300),
  };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(record), { mode: 0o600 });
  } catch {
    // a failed cache write only costs the next process a token round-trip
  }
  return tok.access_token;
}

/** POST the envelope through the gateway: tools_call → brain.ingest. */
export async function deliverEpisode(
  target: DeliveryTarget,
  episode: EpisodeEnvelope,
  fetchFn: Fetch = fetch,
): Promise<DeliveryResult> {
  const bearer = await clientCredentialsToken(target, fetchFn);
  const client = new Client({ name: "brain-session-end", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(target.gatewayUrl), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  );
  try {
    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "brain.ingest", args: { episode } },
    });
    const sc = res.structuredContent as
      | {
          ok?: boolean;
          result?: {
            isError?: boolean;
            structuredContent?: {
              episode_id?: string;
              queued?: boolean;
              processed?: Array<{ newNodes?: string[]; quarantined?: unknown[] }>;
            };
            content?: Array<{ text?: string }>;
          };
        }
      | undefined;
    if (!sc?.ok || sc.result?.isError)
      throw new Error(
        `gateway refused ingest: ${sc?.result?.content?.[0]?.text ?? JSON.stringify(res.content).slice(0, 200)}`,
      );
    const processed = sc.result?.structuredContent?.processed ?? [];
    return {
      episode_id: sc.result?.structuredContent?.episode_id ?? episode.episode_id,
      new_nodes: processed.reduce((n, p) => n + (p.newNodes?.length ?? 0), 0),
      quarantined: processed.reduce((n, p) => n + (p.quarantined?.length ?? 0), 0),
      queued: sc.result?.structuredContent?.queued === true,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
