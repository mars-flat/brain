/**
 * OIDC authorization-code + PKCE against any spec-compliant issuer —
 * Keycloak in the dev stack, Auth0 in production; the difference is env.
 * The id_token is verified against the issuer's JWKS (jose), same trust
 * chain the gateway uses (§4.3). client_secret is optional: the dev client
 * is public+PKCE, the production console client is confidential.
 */

import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcClient {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  /** RP-initiated logout (Auth0/Keycloak publish it; optional per spec). */
  end_session_endpoint?: string;
}

const discoveryCache = new Map<string, Discovery>();

export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
  const meta = (await res.json()) as Discovery;
  discoveryCache.set(issuer, meta);
  return meta;
}

const b64u = (b: Buffer) => b.toString("base64url");

export interface AuthRequest {
  url: string;
  state: string;
  verifier: string;
}

export async function buildAuthRequest(client: OidcClient): Promise<AuthRequest> {
  const meta = await discover(client.issuer);
  const state = b64u(randomBytes(16));
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, verifier };
}

export interface VerifiedIdentity {
  sub: string;
  email?: string;
}

export async function exchangeCode(
  client: OidcClient,
  code: string,
  verifier: string,
): Promise<VerifiedIdentity> {
  const meta = await discover(client.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.clientId,
    code,
    redirect_uri: client.redirectUri,
    code_verifier: verifier,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("token response carried no id_token");

  const jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: meta.issuer,
    audience: client.clientId,
  });
  if (typeof payload.sub !== "string") throw new Error("id_token has no sub");
  return { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined };
}
