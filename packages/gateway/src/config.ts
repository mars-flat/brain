/**
 * Gateway configuration. The REAL inventory and policy live in the private
 * vault's config/ (§9.2) — the public repo carries only synthetic examples.
 * P3 identity is static (owner/cli/high); P4 derives it from authn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyDocument, ToolKind, TrustTier } from "@brain/contracts";
import { validatePolicy } from "@brain/contracts";

export interface KindOverride {
  /** Glob over the bare tool name (not the URN). */
  pattern: string;
  kind: ToolKind;
}

export interface ServerConfig {
  /** URN prefix — lowercase kebab, since urn = `${name}.${tool}` (§4.4). */
  name: string;
  command: string;
  args: string[];
  /** Extra env; values support ${VAR} expansion from the gateway's env. */
  env?: Record<string, string>;
  enabled?: boolean;
  kinds?: KindOverride[];
}

export interface GatewayIdentity {
  principal: string;
  surface: string;
  trust: TrustTier;
}

export interface GatewayConfig {
  servers: ServerConfig[];
  policy: PolicyDocument;
  identity: GatewayIdentity;
  rateLimitPerMin: number;
}

/** Confirm-default, reads allowed — the §4.5 floor when no policy.yaml exists. */
export const DEFAULT_POLICY: PolicyDocument = [
  { match: { kind: "read" }, effect: "allow" },
  { default: "confirm" },
];

const SERVER_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function expandEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

export function loadGatewayConfig(vaultPath: string): GatewayConfig {
  const serversFile = join(vaultPath, "config", "servers.yaml");
  const policyFile = join(vaultPath, "config", "policy.yaml");

  let servers: ServerConfig[] = [];
  if (existsSync(serversFile)) {
    const raw = Bun.YAML.parse(readFileSync(serversFile, "utf8")) as {
      servers?: unknown[];
    } | null;
    for (const [i, entry] of (raw?.servers ?? []).entries()) {
      const s = entry as Partial<ServerConfig>;
      if (typeof s.name !== "string" || !SERVER_NAME.test(s.name))
        throw new Error(`servers.yaml #${i}: name must be lowercase kebab (URN prefix, §4.4)`);
      if (typeof s.command !== "string" || !Array.isArray(s.args))
        throw new Error(`servers.yaml #${i} (${s.name}): command + args[] required`);
      servers.push({
        name: s.name,
        command: s.command,
        args: s.args.map(String),
        env: Object.fromEntries(
          Object.entries(s.env ?? {}).map(([k, v]) => [k, expandEnv(String(v), process.env)]),
        ),
        enabled: s.enabled !== false,
        kinds: (s.kinds ?? []).map((k) => ({ pattern: String(k.pattern), kind: k.kind })),
      });
    }
    const names = new Set<string>();
    for (const s of servers) {
      if (names.has(s.name)) throw new Error(`servers.yaml: duplicate server name ${s.name}`);
      names.add(s.name);
    }
    servers = servers.filter((s) => s.enabled);
  }

  let policy: PolicyDocument = DEFAULT_POLICY;
  if (existsSync(policyFile)) {
    const verdict = validatePolicy(Bun.YAML.parse(readFileSync(policyFile, "utf8")));
    if (!verdict.ok) throw new Error(`policy.yaml invalid:\n  ${verdict.errors.join("\n  ")}`);
    policy = verdict.value;
  }

  return {
    servers,
    policy,
    identity: { principal: "owner", surface: "cli", trust: "high" },
    rateLimitPerMin: 120,
  };
}
