#!/usr/bin/env bun
/**
 * brain-gateway over Streamable HTTP with OAuth resource-server auth (§4.3).
 *
 *   GATEWAY_ISSUER    IdP issuer (default: local Keycloak realm)
 *   GATEWAY_AUDIENCE  expected aud claim (default: brain-gateway)
 *   GATEWAY_PORT      default 8090
 */

import { resolve } from "node:path";
import { startHttpGateway } from "./http.ts";

const vault = process.env.BRAIN_VAULT_PATH;
if (!vault) {
  console.error("brain-gateway: BRAIN_VAULT_PATH is required (§9.1)");
  process.exit(2);
}

const port = Number(process.env.GATEWAY_PORT ?? 8090);
const running = await startHttpGateway({
  vaultPath: resolve(vault),
  cwd: process.cwd(),
  port,
  auth: {
    issuer: process.env.GATEWAY_ISSUER ?? "http://localhost:8081/realms/brain",
    audience: process.env.GATEWAY_AUDIENCE ?? "brain-gateway",
    resource: `http://127.0.0.1:${port}/mcp`,
  },
});
console.error(
  `brain-gateway listening at ${running.url} (issuer: ${process.env.GATEWAY_ISSUER ?? "http://localhost:8081/realms/brain"})`,
);
