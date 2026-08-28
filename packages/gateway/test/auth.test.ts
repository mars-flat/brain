/**
 * P4 integration tier (§8.2): real OAuth token flow against a mock AS.
 * Executable done-when: an MCP client completes auth end to end, the
 * token-passthrough assertion holds (§8.4), and step-up works — 403
 * insufficient_scope with a scope challenge, then success with the union.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type RunningHttpGateway, startHttpGateway } from "../src/http.ts";
import { type MockAS, startMockAS } from "./mock-as.ts";

const FIXTURE = join(import.meta.dir, "fake-upstream.ts");
const AS_PORT = 18821;
const GW_PORT = 18822;

let mockAs: MockAS;
let gw: RunningHttpGateway;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "brain-auth-"));
  mockAs = await startMockAS(AS_PORT);
  gw = await startHttpGateway({
    vaultPath: tmp,
    cwd: join(import.meta.dir, "..", "..", ".."),
    port: GW_PORT,
    auth: {
      issuer: mockAs.issuer,
      audience: "tool-gateway",
      resource: `http://127.0.0.1:${GW_PORT}/mcp`,
    },
    dbPath: ":memory:",
    auditPath: join(tmp, "audit.jsonl"),
    config: {
      // The fixture doubles as "brain" so the brain:* scope mapping is real.
      servers: [
        { name: "brain", command: process.execPath, args: [FIXTURE], enabled: true },
        { name: "fake", command: process.execPath, args: [FIXTURE], enabled: true },
      ],
      policy: [{ match: { kind: "read" }, effect: "allow" }, { default: "confirm" }],
      identity: { principal: "static-should-not-appear", surface: "cli", trust: "high" },
      rateLimitPerMin: 500,
    },
  });
});

afterAll(async () => {
  await gw.stop();
  await mockAs.stop();
});

async function connectedClient(token: string): Promise<Client> {
  const client = new Client({ name: "auth-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gw.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("resource-server discovery and rejection (§4.3)", () => {
  test("PRM document points at the IdP", async () => {
    const res = await fetch(`http://127.0.0.1:${GW_PORT}/.well-known/oauth-protected-resource`);
    const prm = (await res.json()) as Record<string, unknown>;
    expect(prm.authorization_servers).toEqual([mockAs.issuer]);
    expect(prm.scopes_supported).toContain("brain:read");
  });

  test("upstream health is served unauthenticated for the console (§15.4)", async () => {
    const res = await fetch(`http://127.0.0.1:${GW_PORT}/healthz/upstreams`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string; status: string; tool_count: number }>;
    expect(list.map((s) => s.name)).toEqual(["brain", "fake"]);
    for (const s of list) expect(s.status).toBe("up");
  });

  test("no token → 401 with resource_metadata challenge", async () => {
    const res = await fetch(gw.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  test.each([
    ["expired", { expiresIn: "-5m" }],
    ["wrong audience", { aud: "someone-else" }],
    ["wrong issuer claim", { issuer: "http://evil.example.invalid" }],
    ["wrong signing key", { kid: "wrong-key" }],
  ] as Array<[string, Record<string, string>]>)(
    "%s token → 401 invalid_token",
    async (_name, overrides) => {
      const token = await mockAs.issueToken({ scope: "tools:read brain:read", ...overrides });
      const res = await fetch(gw.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    },
  );
});

describe("scopes and step-up (§4.3)", () => {
  test("tools:read session: list + search + read-call work; brain read needs brain:read", async () => {
    const token = await mockAs.issueToken({ scope: "tools:read" });
    const client = await connectedClient(token);

    const { tools } = await client.listTools();
    expect(tools.length).toBe(4);

    const read = await client.callTool({
      name: "tools_call",
      arguments: { urn: "fake.read_note", args: { title: "x" } },
    });
    expect((read.structuredContent as { ok?: boolean }).ok).toBe(true);

    // brain.* requires the brain:read scope — HTTP 403, not an MCP error.
    await expect(
      client.callTool({
        name: "tools_call",
        arguments: { urn: "brain.read_note", args: { title: "x" } },
      }),
    ).rejects.toThrow(/403|insufficient_scope/i);
    await client.close();
  });

  test("insufficient_scope carries the scope challenge for step-up", async () => {
    const token = await mockAs.issueToken({ scope: "tools:read" });
    const res = await fetch(gw.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "tools_call", arguments: { urn: "fake.append_note", args: {} } },
      }),
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="tools:write"');
  });

  test("step-up end to end: union-scope token → confirm → execute (§4.3)", async () => {
    const stepped = await mockAs.issueToken({ scope: "tools:read tools:write" });
    const client = await connectedClient(stepped);
    const args = { urn: "fake.append_note", args: { title: "t", line: "l" } };

    const first = await client.callTool({ name: "tools_call", arguments: args });
    const confirm = first.structuredContent as { needs_confirm?: boolean; confirm_token?: string };
    expect(confirm.needs_confirm).toBe(true);

    const second = await client.callTool({
      name: "tools_call",
      arguments: { ...args, confirm_token: confirm.confirm_token },
    });
    expect((second.structuredContent as { ok?: boolean }).ok).toBe(true);
    await client.close();
  });
});

describe("token passthrough assertion (§8.4) + per-request identity", () => {
  test("the inbound token never reaches an upstream and never lands in the audit", async () => {
    const token = await mockAs.issueToken({ scope: "brain:read tools:read", sub: "shane-sub" });
    const client = await connectedClient(token);

    const res = await client.callTool({
      name: "tools_call",
      arguments: { urn: "brain.dump_context", args: {} },
    });
    const out = res.structuredContent as { result: { content: Array<{ text: string }> } };
    const dumped = JSON.parse(out.result.content[0]?.text ?? "{}") as {
      env: Record<string, string>;
    };
    expect(dumped.env).toBeDefined(); // the upstream really dumped its world
    expect(JSON.stringify(dumped)).not.toContain(token); // …the token is not in it
    // …nor are the gateway's own secrets — upstreams get a scrubbed env (§7).
    expect(dumped.env).not.toHaveProperty("OPENAI_API_KEY");

    const audit = readFileSync(join(tmp, "audit.jsonl"), "utf8");
    expect(audit).not.toContain(token);
    // Identity came from the token, not the static config.
    expect(audit).toContain('"principal":"shane-sub"');
    expect(audit).toContain('"surface":"http"');
    expect(audit).not.toContain("static-should-not-appear");
    await client.close();
  });
});
