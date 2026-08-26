#!/usr/bin/env bun
/**
 * Test fixture: a tiny stdio MCP server with one tool per risk class —
 * annotations on two of them, none on the third (exercises the heuristic).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fake", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "read_note",
      description: "Read a note by its title. Returns the note body text.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "append_note",
      description: "Append a line of text to a note, creating it if missing.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, line: { type: "string" } },
        required: ["title", "line"],
      },
    },
    {
      name: "purge_notes",
      description: "Destroy every stored note irreversibly.",
      inputSchema: { type: "object", properties: {} },
      annotations: { destructiveHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  return {
    content: [
      {
        type: "text" as const,
        text: `fake:${req.params.name}:${JSON.stringify(args)}`,
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
