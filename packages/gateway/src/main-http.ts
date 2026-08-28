#!/usr/bin/env bun
/**
 * tool-gateway over Streamable HTTP with OAuth resource-server auth (§4.3).
 *
 *   GATEWAY_ISSUER    IdP issuer (default: local Keycloak realm)
 *   GATEWAY_AUDIENCE  expected aud claim (default: tool-gateway)
 *   GATEWAY_PORT      default 8090
 *   GATEWAY_HOST      listen interface (default 127.0.0.1; container: 0.0.0.0)
 *   GATEWAY_RESOURCE  advertised resource URL for PRM/challenges — set to the
 *                     tailnet URL on the VM (default http://127.0.0.1:<port>/mcp)
 */

import { resolve } from "node:path";
import { startHttpGateway } from "./http.ts";

const vault = process.env.BRAIN_VAULT_PATH;
if (!vault) {
  console.error("tool-gateway: BRAIN_VAULT_PATH is required (§9.1)");
  process.exit(2);
}

const port = Number(process.env.GATEWAY_PORT ?? 8090);
const running = await startHttpGateway({
  vaultPath: resolve(vault),
  cwd: process.cwd(),
  port,
  host: process.env.GATEWAY_HOST,
  auth: {
    issuer: process.env.GATEWAY_ISSUER ?? "http://localhost:8081/realms/brain",
    audience: process.env.GATEWAY_AUDIENCE ?? "tool-gateway",
    resource: process.env.GATEWAY_RESOURCE ?? `http://127.0.0.1:${port}/mcp`,
  },
});
console.error(
  `tool-gateway listening at ${running.url} (issuer: ${process.env.GATEWAY_ISSUER ?? "http://localhost:8081/realms/brain"})`,
);
