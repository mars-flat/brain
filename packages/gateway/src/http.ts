/**
 * The gateway over Streamable HTTP with resource-server auth (§4.3).
 * Every /mcp request authenticates; tools/call additionally pre-checks the
 * §4.3 scope for the target URN so insufficient scope surfaces as HTTP 403
 * + WWW-Authenticate — the spec-shaped step-up trigger — before any policy
 * or upstream work happens. Identity flows per-request: principal = token
 * sub, surface "http", trust high for this single-user system.
 */

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type AuthConfig, AuthError, prmDocument, requiredScope, TokenVerifier } from "./auth.ts";
import { buildGateway, type GatewayOptions, type RunningGateway } from "./server.ts";

export interface HttpGatewayOptions extends GatewayOptions {
  port: number;
  /** Listen interface. Default 127.0.0.1; the container sets 0.0.0.0 (§3.1 — Tailscale fronts it, never a public IP). */
  host?: string;
  auth: AuthConfig;
}

export interface RunningHttpGateway {
  url: string;
  gateway: RunningGateway;
  httpServer: HttpServer;
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

export async function startHttpGateway(opts: HttpGatewayOptions): Promise<RunningHttpGateway> {
  const gateway = await buildGateway(opts);
  const verifier = new TokenVerifier(opts.auth);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);

      if (
        req.method === "GET" &&
        (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname === "/.well-known/oauth-protected-resource/mcp")
      ) {
        sendJson(res, 200, prmDocument(opts.auth));
        return;
      }

      // Upstream pool status for the console's MCP section (§15.4).
      // Unauthenticated like PRM, but internal in practice: the edge
      // Caddyfile routes only /mcp* and PRM here, so this never leaves
      // the compose network / VM loopback.
      if (req.method === "GET" && url.pathname === "/healthz/upstreams") {
        sendJson(res, 200, gateway.deps.pool.status());
        return;
      }

      if (url.pathname !== "/mcp") {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      // ── authenticate (RS role, §4.3) ─────────────────────────────────
      const auth = await verifier.verify(req.headers.authorization ?? null);
      // Per-request identity rides the SDK's authInfo channel (race-free
      // under interleaving). token deliberately empty: verified inbound
      // tokens have no business existing past this point (§4.3 hard rule).
      (req as IncomingMessage & { auth?: unknown }).auth = {
        token: "",
        clientId: auth.sub,
        scopes: auth.scopes,
        extra: { sub: auth.sub },
      };

      const body = req.method === "POST" ? await readBody(req) : undefined;

      // ── scope pre-check for tools/call (step-up trigger, §4.3) ───────
      const messages = Array.isArray(body) ? body : body ? [body] : [];
      for (const m of messages as Array<Record<string, unknown>>) {
        if (m?.method !== "tools/call") continue;
        const params = m.params as { name?: string; arguments?: { urn?: string } } | undefined;
        if (params?.name !== "tools_call") continue;
        const urn = params.arguments?.urn;
        const tool = urn ? gateway.deps.pool.find(urn) : null;
        if (!tool) continue; // unknown URN → meta layer answers with its own error
        const needed = requiredScope(tool.urn, tool.kind);
        if (!auth.scopes.includes(needed)) throw verifier.insufficientScope(needed);
      }

      // ── route to a session transport ─────────────────────────────────
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (req.method !== "POST") {
          sendJson(res, 400, { error: "unknown_session" });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport as StreamableHTTPServerTransport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await gateway.makeServer().connect(transport);
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (e instanceof AuthError) {
        sendJson(
          res,
          e.status,
          { error: e.status === 401 ? "invalid_token" : "insufficient_scope", detail: e.message },
          { "www-authenticate": e.challenge },
        );
        return;
      }
      sendJson(res, 500, { error: "internal", detail: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", resolve),
  );
  return {
    url: `http://127.0.0.1:${opts.port}/mcp`,
    gateway,
    httpServer,
    stop: async () => {
      for (const t of transports.values()) await t.close().catch(() => {});
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await gateway.stop();
    },
  };
}
