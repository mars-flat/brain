/**
 * Minimal OIDC provider for tests: discovery, authorize (immediate
 * redirect back with a code — no login page), PKCE-checked token
 * exchange, JWKS. Same role the gateway's mock-as plays for the RS
 * tests (§8.2 integration tier), but for the authorization-code flow.
 */

import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface MockIdp {
  issuer: string;
  /** The sub every login gets. Mutable so tests can switch identities. */
  sub: string;
  stop(): void;
}

export async function startMockIdp(port: number): Promise<MockIdp> {
  const issuer = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const state = { sub: "owner-sub" };

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        });
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/authorize") {
        const code = crypto.randomUUID();
        codes.set(code, {
          challenge: url.searchParams.get("code_challenge") ?? "",
          clientId: url.searchParams.get("client_id") ?? "",
        });
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return new Response(null, { status: 302, headers: { location: back.toString() } });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const body = new URLSearchParams(await req.text());
        const grant = codes.get(body.get("code") ?? "");
        if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const digest = createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url");
        if (digest !== grant.challenge)
          return Response.json(
            { error: "invalid_grant", error_description: "pkce" },
            { status: 400 },
          );
        const idToken = await new SignJWT({ email: "owner@example.invalid" })
          .setProtectedHeader({ alg: "RS256", kid: "test" })
          .setIssuer(issuer)
          .setAudience(grant.clientId)
          .setSubject(state.sub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({ id_token: idToken, access_token: "unused", token_type: "Bearer" });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    issuer,
    get sub() {
      return state.sub;
    },
    set sub(v: string) {
      state.sub = v;
    },
    stop: () => server.stop(true),
  };
}
