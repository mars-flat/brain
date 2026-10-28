/**
 * A paced gateway client (§4.4): every call goes through `tools_call`, so
 * policy and the audit chain see the tick like any other principal. The
 * gateway's 120/min window is shared by every principal, so the tick holds
 * itself to half of it and backs off on `rate_limited` rather than racing
 * an interactive session for the rest.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ServerInfo {
  name: string;
  status: string;
}

/** What the tick needs from the gateway; tests substitute a scripted one. */
export interface ToolCaller {
  call(urn: string, args: Record<string, unknown>): Promise<unknown>;
  servers(): Promise<ServerInfo[]>;
}

export class GatewayRefused extends Error {
  constructor(
    readonly urn: string,
    readonly code: string,
    message: string,
  ) {
    super(`${urn}: ${code}: ${message}`);
  }
}

interface CallEnvelope {
  ok?: boolean;
  needs_confirm?: boolean;
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface GatewayClientOptions {
  /** Minimum gap between calls. 1000 ms = at most 60/min, half the gateway window. */
  minGapMs?: number;
  /** Back-off schedule on rate_limited, in ms. */
  backoffMs?: number[];
  clientName?: string;
}

export class GatewayClient implements ToolCaller {
  private client: Client | null = null;
  private last = 0;
  private readonly minGapMs: number;
  private readonly backoffMs: number[];
  private readonly clientName: string;

  constructor(
    private readonly url: string,
    private readonly bearer: string,
    opts: GatewayClientOptions = {},
  ) {
    this.minGapMs = opts.minGapMs ?? 1000;
    this.backoffMs = opts.backoffMs ?? [15_000, 30_000, 60_000];
    this.clientName = opts.clientName ?? "mail-tick";
  }

  async connect(): Promise<void> {
    const client = new Client({ name: this.clientName, version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: { authorization: `Bearer ${this.bearer}` } },
      }),
    );
    this.client = client;
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private async pace(): Promise<void> {
    const wait = this.last + this.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
  }

  private async raw(name: string, args: Record<string, unknown>) {
    if (!this.client) throw new Error("gateway client not connected");
    await this.pace();
    return this.client.callTool({ name, arguments: args });
  }

  async servers(): Promise<ServerInfo[]> {
    const res = await this.raw("tools_servers", {});
    const sc = res.structuredContent as { results?: ServerInfo[] } | undefined;
    return (sc?.results ?? []).map((s) => ({ name: s.name, status: s.status }));
  }

  /**
   * One upstream call. Returns the upstream's structured result (or its
   * text, parsed as JSON when it is). Throws GatewayRefused on a policy
   * deny, a confirm demand (the tick is headless — a needs_confirm means
   * the private policy is missing its allow), or an upstream error.
   */
  async call(urn: string, args: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.raw("tools_call", { urn, args });
      const text = (res.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
      if (res.isError) {
        const code = text.split(":")[0]?.trim() ?? "error";
        if (code === "rate_limited" && attempt < this.backoffMs.length) {
          await sleep(this.backoffMs[attempt] as number);
          continue;
        }
        throw new GatewayRefused(urn, code, text.slice(0, 300));
      }
      const sc = res.structuredContent as CallEnvelope | undefined;
      if (sc?.needs_confirm)
        throw new GatewayRefused(
          urn,
          "needs_confirm",
          "the gateway wants a confirmation — the private policy lacks an allow for this principal",
        );
      if (!sc?.ok) throw new GatewayRefused(urn, "unexpected", text.slice(0, 300));
      const r = sc.result;
      if (r?.isError)
        throw new GatewayRefused(urn, "upstream_error", r.content?.[0]?.text?.slice(0, 300) ?? "");
      if (r?.structuredContent !== undefined) return r.structuredContent;
      const body = r?.content?.[0]?.text ?? "";
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
  }
}
