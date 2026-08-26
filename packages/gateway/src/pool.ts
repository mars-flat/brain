/**
 * Connection pool (§4.2 box 7): one stdio MCP client per upstream server.
 * A server that fails to start or dies is marked down with its error —
 * the gateway keeps serving everything else. Calls to a down server try
 * one reconnect, then error.
 */

import type { ServerStatus, ToolKind } from "@brain/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig } from "./config.ts";
import { classifyKind } from "./kinds.ts";

export interface UpstreamTool {
  urn: string;
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
}

interface Upstream {
  config: ServerConfig;
  client: Client | null;
  tools: UpstreamTool[];
  status: "up" | "down";
  lastError: string | null;
}

export class UpstreamPool {
  private readonly upstreams = new Map<string, Upstream>();

  constructor(
    configs: ServerConfig[],
    private readonly cwd: string,
  ) {
    for (const config of configs) {
      this.upstreams.set(config.name, {
        config,
        client: null,
        tools: [],
        status: "down",
        lastError: null,
      });
    }
  }

  async start(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((u) => this.connect(u)));
  }

  private async connect(u: Upstream): Promise<void> {
    try {
      const client = new Client({ name: "brain-gateway", version: "0.1.0" });
      const transport = new StdioClientTransport({
        command: u.config.command,
        args: u.config.args,
        env: { ...getDefaultEnvironment(), ...u.config.env },
        cwd: this.cwd,
        stderr: "ignore",
      });
      transport.onclose = () => {
        u.status = "down";
        u.client = null;
      };
      await client.connect(transport);
      const listed = await client.listTools();
      u.tools = listed.tools.map((t) => ({
        urn: `${u.config.name}.${t.name}`,
        server: u.config.name,
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        kind: classifyKind(
          { name: t.name, annotations: t.annotations as Record<string, unknown> | undefined },
          u.config.kinds,
        ),
      }));
      u.client = client;
      u.status = "up";
      u.lastError = null;
    } catch (e) {
      u.status = "down";
      u.client = null;
      u.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  catalog(): UpstreamTool[] {
    return [...this.upstreams.values()]
      .flatMap((u) => u.tools)
      .sort((a, b) => a.urn.localeCompare(b.urn));
  }

  find(urn: string): UpstreamTool | null {
    return this.catalog().find((t) => t.urn === urn) ?? null;
  }

  status(): ServerStatus[] {
    return [...this.upstreams.values()]
      .map((u) => ({
        name: u.config.name,
        status: u.status,
        tool_count: u.tools.length,
        auth_status: (u.status === "up" ? "ok" : "error") as ServerStatus["auth_status"],
        last_error: u.lastError,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(urn: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.find(urn);
    if (!tool) throw new Error(`unknown tool urn: ${urn}`);
    const u = this.upstreams.get(tool.server);
    if (!u) throw new Error(`unknown server: ${tool.server}`);
    if (u.status !== "up" || !u.client) {
      await this.connect(u);
      if (u.status !== "up" || !u.client)
        throw new Error(`server ${tool.server} is down: ${u.lastError ?? "unknown"}`);
    }
    return u.client.callTool({ name: tool.name, arguments: args });
  }

  async stop(): Promise<void> {
    for (const u of this.upstreams.values()) {
      await u.client?.close().catch(() => {});
      u.client = null;
      u.status = "down";
    }
  }
}
