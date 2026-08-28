/**
 * The console end to end against a mock IdP and a scratch copy of the
 * example vault: the login round-trip, sub-pinning, the viewer's pages,
 * and the dashboard rendering with degraded tiles.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVault, openDb, rebuild } from "@brain/brainstore";
import { loadConfig } from "../src/config.ts";
import { expiryTile } from "../src/dashboard.ts";
import { type RunningConsole, startConsole } from "../src/server.ts";
import { type MockIdp, startMockIdp } from "./mock-idp.ts";

const IDP_PORT = 18861;
const CONSOLE_PORT = 18862;
const EXAMPLE = join(import.meta.dir, "..", "..", "..", "examples", "vault-example");

let idp: MockIdp;
let console_: RunningConsole;
let vault: string;

beforeAll(async () => {
  vault = mkdtempSync(join(tmpdir(), "console-vault-"));
  cpSync(EXAMPLE, vault, { recursive: true });
  mkdirSync(join(vault, "_index"), { recursive: true });
  rebuild(openDb(join(vault, "_index", "brain.db")), loadVault(vault));
  writeFileSync(
    join(vault, "config", "console.yaml"),
    `links:
  - { title: "Example portal", url: "https://example.invalid/portal", group: "cloud" }
expiries:
  - { name: "test-token", expires: "2099-01-01", note: "far future" }
services:
  - name: Example SaaS
    account: owner@example.invalid
    console: https://example.invalid/console
    tokens:
      - { name: "dated-key", expires: "2099-01-01" }
      - { name: "undated-key", note: "lives forever" }
`,
  );
  // A known MCP roster: the dashboard merges it with gateway health, which
  // is unreachable in this test — rows must degrade to "unknown".
  writeFileSync(
    join(vault, "config", "servers.yaml"),
    `servers:\n  - { name: alpha, command: bun, args: [nonexistent.ts] }\n`,
  );

  idp = await startMockIdp(IDP_PORT);
  console_ = startConsole(
    loadConfig({
      BRAIN_VAULT_PATH: vault,
      CONSOLE_PORT: String(CONSOLE_PORT),
      CONSOLE_SESSION_SECRET: "test-secret-test-secret",
      CONSOLE_ISSUER: idp.issuer,
      CONSOLE_CLIENT_ID: "brain-console",
      CONSOLE_GATEWAY_PRM_URL: "http://127.0.0.1:1/nope", // degraded tile on purpose
    }),
  );
});

afterAll(() => {
  console_.stop();
  idp.stop();
});

/** Drives login and returns the session cookie. */
async function login(): Promise<string> {
  const start = await fetch(`${console_.url}/login`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const oauthCookie = (start.headers.get("set-cookie") ?? "").split(";")[0] as string;
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const callback = await fetch(authorize.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: oauthCookie },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
  return (callback.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

describe("auth (W1.2)", () => {
  test("unauthenticated requests bounce to login; healthz doesn't", async () => {
    const res = await fetch(`${console_.url}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect((await fetch(`${console_.url}/healthz`)).status).toBe(200);
  });

  test("the full code+PKCE round-trip issues a working session", async () => {
    const cookie = await login();
    const home = await fetch(`${console_.url}/`, { headers: { cookie } });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("the brain");
  });

  test("logout clears the session and lands locally — no IdP bounce", async () => {
    const cookie = await login();
    const res = await fetch(`${console_.url}/logout`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(200); // a page, not a redirect: the IdP's SSO cookie must not re-login
    expect(res.headers.get("set-cookie")).toContain("console_session=;");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await res.text()).toContain("signed out");
  });

  test("a tampered session cookie is just an anonymous visitor", async () => {
    const cookie = await login();
    const forged = `${cookie.slice(0, -4)}AAAA`;
    const res = await fetch(`${console_.url}/`, {
      redirect: "manual",
      headers: { cookie: forged },
    });
    expect(res.status).toBe(302);
  });
});

describe("viewer (W1.3)", () => {
  test("node page renders content, edges, and resolved wikilinks", async () => {
    const cookie = await login();
    const res = await fetch(`${console_.url}/node/htmx-server-rendered-ui`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("htmx");
    expect(body).toContain("/node/"); // wikilinks and edges resolve into viewer links
    expect(body).toContain("edges");
  });

  test("search hits the FTS index", async () => {
    const cookie = await login();
    const res = await fetch(`${console_.url}/search?q=garden+tracker+frontend`, {
      headers: { cookie },
    });
    expect(await res.text()).toContain("/node/htmx-server-rendered-ui");
  });

  test("missing node 404s; hostile id 400s", async () => {
    const cookie = await login();
    expect((await fetch(`${console_.url}/node/not-a-node`, { headers: { cookie } })).status).toBe(
      404,
    );
    expect(
      (await fetch(`${console_.url}/node/..%2F..%2Fetc`, { headers: { cookie } })).status,
    ).toBe(400);
  });
});

describe("dashboard (W1.4)", () => {
  test("renders with links, expiries, and gracefully degraded tiles", async () => {
    const cookie = await login();
    const res = await fetch(`${console_.url}/dashboard`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Example portal");
    expect(body).toContain(`class="card links"`); // one-line truncation is links-only; other cards wrap
    expect(body).toContain("test-token");
    expect(body).toContain("unavailable"); // the unreachable gateway tile degraded, page did not
    expect(body).toContain("nodes");
  });

  test("service cards and the MCP section render from config, degraded", async () => {
    const cookie = await login();
    const res = await fetch(`${console_.url}/dashboard`, { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain("Example SaaS");
    expect(body).toContain("owner@example.invalid");
    expect(body).toContain("no expiry"); // undated-key
    expect(body).toContain("alpha"); // MCP roster from servers.yaml
    expect(body).toContain("unknown"); // gateway health unreachable → status degrades
    expect(body).toContain("open console ↗");
  });

  test("graph tab: page, data, and script all serve behind auth", async () => {
    const cookie = await login();
    expect((await fetch(`${console_.url}/graph`, { redirect: "manual" })).status).toBe(302);
    const pageRes = await fetch(`${console_.url}/graph`, { headers: { cookie } });
    expect(pageRes.status).toBe(200);
    const body = await pageRes.text();
    expect(body).toContain("<canvas");
    expect(body).toContain(`data-type="concept"`); // legend chip for a type the example vault has
    const dataRes = await fetch(`${console_.url}/graph.json`, { headers: { cookie } });
    const graph = (await dataRes.json()) as {
      nodes: Array<{ id: string; type: string; degree: number; active: boolean }>;
      edges: Array<{ from: string; rel: string; to: string }>;
    };
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const e of graph.edges) {
      // every edge endpoint resolves — the client never draws dangling links
      expect(graph.nodes.some((n) => n.id === e.from)).toBe(true);
      expect(graph.nodes.some((n) => n.id === e.to)).toBe(true);
    }
    const js = await fetch(`${console_.url}/graph.js`, { headers: { cookie } });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  test("architecture tab renders the diagram behind auth", async () => {
    const cookie = await login();
    const anon = await fetch(`${console_.url}/architecture`, { redirect: "manual" });
    expect(anon.status).toBe(302);
    const res = await fetch(`${console_.url}/architecture`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain("gateway :8090");
    expect(body).toContain("single writer");
    expect(body).toContain(`href="/logout"`); // the nav logout control
  });

  test("expiry tile grades urgency", () => {
    const now = new Date("2026-08-27T00:00:00Z");
    const tile = expiryTile(
      [
        { name: "soon", expires: "2026-08-30" },
        { name: "later", expires: "2026-09-10" },
        { name: "fine", expires: "2027-08-01" },
      ],
      now,
    );
    expect(tile.cls).toBe("bad");
    expect(tile.html).toContain("soon");
    expect(tile.html).toMatch(/3d/);
  });
});

describe("sub pinning", () => {
  test("a stranger authenticates but is refused, and sees their sub", async () => {
    const pinned = startConsole(
      loadConfig({
        BRAIN_VAULT_PATH: vault,
        CONSOLE_PORT: String(CONSOLE_PORT + 1),
        CONSOLE_SESSION_SECRET: "test-secret-test-secret",
        CONSOLE_ISSUER: idp.issuer,
        CONSOLE_CLIENT_ID: "brain-console",
        CONSOLE_ALLOWED_SUB: "the-owner",
      }),
    );
    try {
      idp.sub = "some-stranger";
      const start = await fetch(`${pinned.url}/login`, { redirect: "manual" });
      const oauthCookie = (start.headers.get("set-cookie") ?? "").split(";")[0] as string;
      const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
      const callback = await fetch(authorize.headers.get("location") ?? "", {
        redirect: "manual",
        headers: { cookie: oauthCookie },
      });
      expect(callback.status).toBe(403);
      expect(await callback.text()).toContain("some-stranger");
    } finally {
      idp.sub = "owner-sub";
      pinned.stop();
    }
  });
});
