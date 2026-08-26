/**
 * The four meta-tools (§4.4): progressive disclosure. search returns
 * one-liners, describe returns schemas, call enforces policy + confirm
 * tokens, servers reports health. Deny and confirm come from the composed
 * §6.5-matrix + policy decision; scope checks slot in ABOVE this at P4.
 *
 * Results of upstream calls are wrapped untrusted_content (§4.6): data,
 * not instruction.
 */

import type { Database } from "bun:sqlite";
import type {
  PolicyDocument,
  ToolsCallInput,
  ToolsCallResult,
  ToolsDescribeResult,
  ToolsSearchInput,
  ToolsSearchResult,
  ToolsServersResult,
} from "@brain/contracts";
import { decide } from "@brain/core";
import { type AuditLog, digestArgs } from "./audit.ts";
import type { GatewayIdentity } from "./config.ts";
import type { UpstreamPool } from "./pool.ts";
import { searchTools } from "./toolindex.ts";

export interface MetaDeps {
  pool: UpstreamPool;
  db: Database;
  policy: PolicyDocument;
  identity: GatewayIdentity;
  audit: AuditLog;
  clock: () => Date;
  rateLimitPerMin: number;
  /** Sliding-window call timestamps — per gateway instance, never shared. */
  rateWindow: number[];
}

/** Thrown for deny / rate-limit / unknown-urn — the MCP layer renders isError. */
export class GatewayCallError extends Error {
  constructor(
    message: string,
    readonly code: "denied" | "rate_limited" | "unknown_tool" | "upstream_error",
  ) {
    super(message);
  }
}

const CONFIRM_TTL_MS = 5 * 60_000;

// Sliding-window rate limit (§7: runaway agent). In-memory is right: the
// window is a minute and the gateway is a single process.
function checkRate(deps: MetaDeps): void {
  const callTimes = deps.rateWindow;
  const now = deps.clock().getTime();
  while (callTimes.length && (callTimes[0] as number) < now - 60_000) callTimes.shift();
  if (callTimes.length >= deps.rateLimitPerMin) {
    deps.audit.append({
      type: "rate_limited",
      principal: deps.identity.principal,
      surface: deps.identity.surface,
      urn: "-",
    });
    throw new GatewayCallError(
      `rate limit: ${deps.rateLimitPerMin} calls/min per principal`,
      "rate_limited",
    );
  }
  callTimes.push(now);
}

function oneLine(description: string): string {
  const first = description.split(/[.\n]/)[0] ?? "";
  return first.length > 110 ? `${first.slice(0, 107)}…` : first;
}

export function toolsSearch(deps: MetaDeps, input: ToolsSearchInput): ToolsSearchResult {
  const hits = searchTools(deps.db, input.query, (input.limit ?? 5) * 3, input.kind);
  const statuses = new Map(deps.pool.status().map((s) => [s.name, s]));
  const out: ToolsSearchResult = [];
  for (const h of hits) {
    const d = decide(deps.policy, {
      urn: h.urn,
      kind: h.kind as never,
      ...deps.identity,
    });
    if (d.effect === "deny") continue; // §4.4: filtered by policy for principal+surface
    out.push({
      urn: h.urn,
      title: h.name,
      one_line: oneLine(h.description),
      server: h.server,
      score: Math.round(h.raw * 100) / 100,
      auth_status: statuses.get(h.server)?.auth_status ?? "error",
    });
    if (out.length >= (input.limit ?? 5)) break;
  }
  return out;
}

export function toolsDescribe(deps: MetaDeps, urns: string[]): ToolsDescribeResult {
  const out: ToolsDescribeResult = [];
  for (const urn of urns) {
    const t = deps.pool.find(urn);
    if (!t) continue;
    out.push({
      urn: t.urn,
      description: t.description,
      input_schema: t.inputSchema,
      risk: t.kind,
    });
  }
  return out;
}

export async function toolsCall(deps: MetaDeps, input: ToolsCallInput): Promise<ToolsCallResult> {
  const { identity } = deps;
  const tool = deps.pool.find(input.urn);
  if (!tool) throw new GatewayCallError(`unknown tool urn: ${input.urn}`, "unknown_tool");

  checkRate(deps);
  const argsDigest = digestArgs(input.args);
  const decision = decide(deps.policy, { urn: tool.urn, kind: tool.kind, ...identity });
  deps.audit.append({
    type: "decision",
    principal: identity.principal,
    surface: identity.surface,
    urn: tool.urn,
    kind: tool.kind,
    effect: decision.effect,
    ruleIndex: decision.ruleIndex,
    argsDigest,
  });

  if (decision.effect === "deny") {
    throw new GatewayCallError(
      `denied by policy${decision.isDefault ? " (default)" : ` rule #${decision.ruleIndex}`}${decision.reason ? `: ${decision.reason}` : ""}`,
      "denied",
    );
  }

  if (decision.effect === "confirm") {
    const now = deps.clock().getTime();
    if (input.confirm_token) {
      const row = deps.db
        .query(
          "SELECT token FROM confirm_tokens WHERE token = ? AND urn = ? AND args_digest = ? AND used = 0 AND expires > ?",
        )
        .get(input.confirm_token, tool.urn, argsDigest, now) as { token: string } | null;
      if (row) {
        deps.db.query("UPDATE confirm_tokens SET used = 1 WHERE token = ?").run(row.token);
        deps.audit.append({
          type: "confirm_spent",
          principal: identity.principal,
          surface: identity.surface,
          urn: tool.urn,
          argsDigest,
        });
        return execute(deps, tool.urn, input.args, argsDigest);
      }
    }
    const token = crypto.randomUUID();
    deps.db
      .query("INSERT INTO confirm_tokens (token, urn, args_digest, expires) VALUES (?, ?, ?, ?)")
      .run(token, tool.urn, argsDigest, now + CONFIRM_TTL_MS);
    deps.audit.append({
      type: "confirm_issued",
      principal: identity.principal,
      surface: identity.surface,
      urn: tool.urn,
      argsDigest,
    });
    return {
      needs_confirm: true,
      confirm_token: token,
      preview: `${tool.urn} [${tool.kind}]\n${JSON.stringify(input.args, null, 2).slice(0, 800)}`,
      risk: tool.kind,
    };
  }

  return execute(deps, tool.urn, input.args, argsDigest);
}

async function execute(
  deps: MetaDeps,
  urn: string,
  args: Record<string, unknown>,
  argsDigest: string,
): Promise<ToolsCallResult> {
  const { identity } = deps;
  try {
    const result = await deps.pool.call(urn, args);
    deps.audit.append({
      type: "call",
      principal: identity.principal,
      surface: identity.surface,
      urn,
      argsDigest,
      outcome: "ok",
    });
    return { ok: true, result, untrusted_content: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.audit.append({
      type: "error",
      principal: identity.principal,
      surface: identity.surface,
      urn,
      argsDigest,
      outcome: message.slice(0, 200),
    });
    throw new GatewayCallError(`upstream error from ${urn}: ${message}`, "upstream_error");
  }
}

export function toolsServers(deps: MetaDeps): ToolsServersResult {
  return deps.pool.status();
}
