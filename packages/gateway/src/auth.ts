/**
 * North-bound authentication (§4.3): the gateway is an OAuth 2.1 RESOURCE
 * SERVER — it validates tokens minted by an external IdP (local Keycloak
 * per the owner's P4 decision; any spec-compliant issuer works) and never
 * runs an authorization server of its own. RFC 9728 protected-resource
 * metadata + WWW-Authenticate challenges are what make stock MCP clients
 * discover the IdP; 403 insufficient_scope is what makes step-up real.
 *
 * The §4.3 hard rule is structural here: the inbound token is used for
 * verification only and never enters upstream spawn env or call arguments
 * — §8.4's passthrough test asserts it can't regress silently.
 */

import type { ToolKind } from "@brain/contracts";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthConfig {
  /** IdP issuer URL, e.g. http://localhost:8081/realms/brain */
  issuer: string;
  /** Expected audience claim, e.g. brain-gateway */
  audience: string;
  /** Public URL of this resource (for PRM + challenges). */
  resource: string;
}

export interface AuthInfo {
  sub: string;
  scopes: string[];
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly challenge: string,
    message: string,
  ) {
    super(message);
  }
}

/** §4.3 scope tiers: brain.* maps to brain:read/brain:write, rest to tools:*. */
export function requiredScope(urn: string, kind: ToolKind): string {
  if (urn.startsWith("brain.")) return kind === "read" ? "brain:read" : "brain:write";
  return `tools:${kind}`;
}

export const SCOPES_SUPPORTED = [
  "brain:read",
  "brain:write",
  "tools:read",
  "tools:write",
  "tools:admin",
];

/** RFC 9728 protected resource metadata. */
export function prmDocument(cfg: AuthConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
  };
}

export function prmUrl(cfg: AuthConfig): string {
  return `${cfg.resource.replace(/\/mcp\/?$/, "")}/.well-known/oauth-protected-resource`;
}

export class TokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: AuthConfig) {}

  private challenge(extra = ""): string {
    return `Bearer resource_metadata="${prmUrl(this.cfg)}"${extra}`;
  }

  private async keys(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.jwks) return this.jwks;
    const res = await fetch(
      `${this.cfg.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    );
    if (!res.ok) throw new Error(`issuer discovery failed: HTTP ${res.status}`);
    const meta = (await res.json()) as { jwks_uri?: string };
    if (!meta.jwks_uri) throw new Error("issuer metadata has no jwks_uri");
    this.jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    return this.jwks;
  }

  async verify(authorization: string | null): Promise<AuthInfo> {
    if (!authorization?.startsWith("Bearer ")) {
      throw new AuthError(401, this.challenge(), "missing bearer token");
    }
    const token = authorization.slice(7).trim();
    try {
      const { payload } = await jwtVerify(token, await this.keys(), {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience,
      });
      const scopes =
        typeof payload.scope === "string"
          ? payload.scope.split(/\s+/).filter(Boolean)
          : Array.isArray(payload.scp)
            ? payload.scp.map(String)
            : [];
      return { sub: String(payload.sub ?? "unknown"), scopes };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new AuthError(401, this.challenge(', error="invalid_token"'), message);
    }
  }

  insufficientScope(needed: string): AuthError {
    return new AuthError(
      403,
      this.challenge(`, error="insufficient_scope", scope="${needed}"`),
      `insufficient scope: ${needed} required — re-authorize with the union of scopes (§4.3 step-up)`,
    );
  }
}
