#!/usr/bin/env bun
/**
 * mcp-google over stdio, one process per Google account. The gateway
 * resolves GOOGLE_REFRESH_TOKEN from `${secret:google/<name>}` at spawn
 * (§4.3 south-bound plane); nothing here ever sees the vault.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildGoogleServer } from "./server.ts";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`mcp-google: ${name} is required`);
    process.exit(2);
  }
  return v;
};

const server = buildGoogleServer({
  clientId: need("GOOGLE_OAUTH_CLIENT_ID"),
  clientSecret: need("GOOGLE_OAUTH_CLIENT_SECRET"),
  refreshToken: need("GOOGLE_REFRESH_TOKEN"),
  accountLabel: process.env.GOOGLE_ACCOUNT_LABEL ?? "google",
  // Test/e2e overrides — default to the real Google endpoints when unset.
  tokenUrl: process.env.GOOGLE_TOKEN_URL,
  gmailBase: process.env.GOOGLE_GMAIL_BASE,
  driveBase: process.env.GOOGLE_DRIVE_BASE,
  uploadBase: process.env.GOOGLE_UPLOAD_BASE,
});
await server.connect(new StdioServerTransport());
