/**
 * Mock authorization server for the integration tier (§8.2: "real OAuth
 * flow vs mock AS"): serves OIDC discovery + JWKS and mints RS256 tokens
 * with whatever claims a test asks for — including deliberately wrong ones.
 */

import { createServer, type Server } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface MockAS {
  issuer: string;
  stop(): Promise<void>;
  issueToken(opts: {
    sub?: string;
    scope?: string;
    aud?: string;
    expiresIn?: string;
    issuer?: string;
    kid?: string;
  }): Promise<string>;
}

export async function startMockAS(port: number): Promise<MockAS> {
  const issuer = `http://127.0.0.1:${port}`;
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const wrongPair = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };

  const server: Server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        }),
      );
      return;
    }
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    issuer,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
    issueToken: async (opts) => {
      const key = opts.kid === "wrong-key" ? wrongPair.privateKey : privateKey;
      return new SignJWT({ scope: opts.scope ?? "" })
        .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "mock-1" })
        .setIssuer(opts.issuer ?? issuer)
        .setAudience(opts.aud ?? "brain-gateway")
        .setSubject(opts.sub ?? "owner-sub")
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "10m")
        .sign(key);
    },
  };
}
