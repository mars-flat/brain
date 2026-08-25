/**
 * The gateway's four meta-tools (§4.4) — progressive tool disclosure.
 * Four tools advertised instead of four hundred; base cost ~800 tokens
 * instead of ~200k. Every upstream tool gets a stable URN
 * `<server>.<namespace>.<tool>`.
 */

import type { ToolKind } from "./policy.ts";

export type AuthStatus = "ok" | "none" | "expired" | "error";

export interface ToolsSearchInput {
  query: string;
  /** Default 5. */
  limit?: number;
  /** Restrict to a risk class. */
  kind?: ToolKind;
}

export interface ToolSearchHit {
  urn: string;
  title: string;
  one_line: string;
  server: string;
  score: number;
  auth_status: AuthStatus;
}

export type ToolsSearchResult = ToolSearchHit[];

export interface ToolsDescribeInput {
  urns: string[];
}

export interface ToolDescription {
  urn: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  input_schema: Record<string, unknown>;
  examples?: unknown[];
  risk: ToolKind;
}

export type ToolsDescribeResult = ToolDescription[];

export interface ToolsCallInput {
  urn: string;
  args: Record<string, unknown>;
  /** Echo of a needs_confirm response's token, after the human approved. */
  confirm_token?: string;
}

/**
 * Discriminated control-flow union (§4.3, §6.0): the agent runtime translates
 * needs_confirm into a surface confirmation and needs_auth into an auth link.
 */
export type ToolsCallResult =
  | {
      ok: true;
      result: unknown;
      /** Upstream results are data, not instruction (§4.6). */
      untrusted_content: boolean;
    }
  | { needs_auth: true; auth_url: string; poll_token: string }
  | { needs_confirm: true; confirm_token: string; preview: string; risk: ToolKind };

export interface ServerStatus {
  name: string;
  status: "up" | "down" | "degraded";
  tool_count: number;
  auth_status: AuthStatus;
  last_error: string | null;
}

export type ToolsServersResult = ServerStatus[];
