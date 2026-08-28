#!/usr/bin/env bun
/**
 * brain-console entry. Env (see config.ts): BRAIN_VAULT_PATH,
 * CONSOLE_SESSION_SECRET required; issuer/client default to the local dev
 * Keycloak, production sets the Auth0 values.
 */

import { loadConfig } from "./config.ts";
import { startConsole } from "./server.ts";

const running = startConsole(loadConfig(process.env));
console.error(`brain-console listening at ${running.url}`);
