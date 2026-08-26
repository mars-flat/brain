/**
 * Risk classification (§4.3 scope tiers, §4.4 `risk`): read | write | admin.
 * Order of authority: explicit config override → MCP tool annotations
 * (readOnlyHint / destructiveHint, spec 2025-03+) → name heuristic → write.
 * Confirm-default policy makes the write fallback safe.
 */

import type { ToolKind } from "@brain/contracts";
import { globToRegExp } from "@brain/core";
import type { KindOverride } from "./config.ts";

const READ_PREFIX =
  /^(get|list|read|search|fetch|describe|query|show|stat|watch|recall|expand|neighbors|timeline|trace)([_-]|$)/;
const ADMIN_PREFIX =
  /^(delete|remove|destroy|drop|exec|execute|run|shell|kill|format|wipe)([_-]|$)/;

export function classifyKind(
  tool: { name: string; annotations?: Record<string, unknown> },
  overrides: KindOverride[] = [],
): ToolKind {
  for (const o of overrides) {
    if (globToRegExp(o.pattern).test(tool.name)) return o.kind;
  }
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return "read";
  if (a.destructiveHint === true) return "admin";
  if (READ_PREFIX.test(tool.name)) return "read";
  if (ADMIN_PREFIX.test(tool.name)) return "admin";
  return "write";
}
