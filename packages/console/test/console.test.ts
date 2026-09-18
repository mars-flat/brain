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
  // A node whose edges cover the non-node target cases: one points at an
  // episode (derived_from provenance), one dangles at nothing.
  writeFileSync(
    join(vault, "nodes", "concept", "edge-target-cases.md"),
    `---
id: edge-target-cases
type: concept
title: "Edge target cases"
created: 2026-08-28
updated: 2026-08-28
status: active
confidence: high
derived_from: ["[[2026-03-14-disk-failure-postmortem]]"]
about: ["[[ghost-node]]"]
summary: >
  Test fixture: edges to an episode and to a nonexistent node.
---
`,
  );
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
  // A synthetic audit trail for the analytics panel (W1.7): the console
  // only reads ts + event, so fake hashes are fine here. One event sits
  // outside the 7-day window and one line is torn — both must vanish
  // silently, not break the page.
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const audit = (ts: string, event: Record<string, unknown>) =>
    JSON.stringify({ seq: 1, ts, prev: "x", event, hash: "x" });
  writeFileSync(
    join(vault, "_index", "audit.jsonl"),
    `${[
      audit(ago(1), {
        type: "decision",
        principal: "owner",
        surface: "http",
        urn: "brain.recall",
        kind: "read",
        effect: "allow",
        argsDigest: "sha256:d1",
      }),
      audit(ago(1), {
        type: "call",
        principal: "owner",
        surface: "http",
        urn: "brain.recall",
        argsDigest: "sha256:d1",
        outcome: "ok",
        ms: 42,
      }),
      audit(ago(2), {
        type: "decision",
        principal: "owner",
        surface: "http",
        urn: "files.delete_everything",
        kind: "admin",
        effect: "deny",
        argsDigest: "sha256:d2",
      }),
      audit(ago(3), {
        type: "error",
        principal: "owner",
        surface: "http",
        urn: "brain.note",
        argsDigest: "sha256:d3",
        outcome: "MCP error -32001: Request timed out",
        ms: 40000,
      }),
      audit(ago(30), { type: "rate_limited", principal: "owner", surface: "http", urn: "-" }),
      audit(ago(9 * 24), {
        type: "call",
        principal: "owner",
        surface: "cli",
        urn: "ancient.tool",
        outcome: "ok",
        ms: 5,
      }),
      "this line is torn and not json",
    ].join("\n")}\n`,
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
      TASKS_DB_PATH: join(vault, "tasks", "tasks.db"), // scratch, never the tmpdir-wide default
      TASKS_TZ: "America/Toronto",
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

  test("the full code+PKCE round-trip issues a working session; the root lands on tasks", async () => {
    const cookie = await login();
    const home = await fetch(`${console_.url}/`, { headers: { cookie }, redirect: "manual" });
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/tasks"); // tasks is the front door (2026-09-18)
    const tasks = await fetch(`${console_.url}/tasks`, { headers: { cookie } });
    expect(tasks.status).toBe(200);
    expect(await tasks.text()).toContain("<h1>tasks</h1>");
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

  test("edge targets that aren't nodes never render dead /node/ links", async () => {
    const cookie = await login();
    const res = await fetch(`${console_.url}/node/edge-target-cases`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // episode target → anchored link into the vault tab's episodes view
    expect(body).toContain(`href="/vault?view=episodes#2026-03-14-disk-failure-postmortem"`);
    expect(body).not.toContain(`href="/node/2026-03-14-disk-failure-postmortem"`);
    // dangling target → plain text, labeled, unlinked
    expect(body).toContain("not in graph");
    expect(body).not.toContain(`href="/node/ghost-node"`);
    // and the anchor actually exists in the episodes view
    const eps = await fetch(`${console_.url}/vault?view=episodes`, { headers: { cookie } });
    expect(await eps.text()).toContain(`id="2026-03-14-disk-failure-postmortem"`);
  });

  test("vault tab toggles between nodes and episodes; old routes redirect", async () => {
    const cookie = await login();
    const nodesView = await fetch(`${console_.url}/vault`, { headers: { cookie } });
    expect(nodesView.status).toBe(200);
    const nodesBody = await nodesView.text();
    expect(nodesBody).toContain(`class="seg"`); // the nodes/episodes toggle
    expect(nodesBody).toContain(`href="/vault?view=episodes"`);
    const epsView = await fetch(`${console_.url}/vault?view=episodes`, { headers: { cookie } });
    expect(await epsView.text()).toContain("newest first");
    // standalone routes are gone but bookmarks land where the content went
    const oldEps = await fetch(`${console_.url}/episodes`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(oldEps.status).toBe(302);
    expect(oldEps.headers.get("location")).toBe("/vault?view=episodes");
    const graph = await fetch(`${console_.url}/graph`, { headers: { cookie } });
    expect(graph.status).toBe(200); // /graph is a real route again (2026-09-18)
    expect(await graph.text()).toContain("<canvas");
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

  test("audit panel: stats, charts, and latest calls from the trailing 7 days", async () => {
    const cookie = await login();
    const body = await (await fetch(`${console_.url}/dashboard`, { headers: { cookie } })).text();
    expect(body).toContain(`id="audit"`);
    expect(body).toContain("calls executed · 7d");
    expect(body).toContain("1 denied, 1 rate-limited");
    expect(body).toContain(`<svg`); // the hourly outcome bars
    expect(body).toContain("gateway calls per hour");
    expect(body).toContain("brain.recall"); // top tools + latest calls
    expect(body).toContain(">42<"); // the ok call's duration in the table
    expect(body).toContain("denied");
    expect(body).toContain("rate-limited");
    expect(body).toContain(`<td class="muted">read</td>`); // kind joined from the decision line
    expect(body).not.toContain("ancient.tool"); // outside the window
    expect(body).not.toContain("this line is torn"); // malformed input vanishes
  });

  test("graph tab: page, data, and script all serve behind auth", async () => {
    const cookie = await login();
    expect((await fetch(`${console_.url}/graph`, { redirect: "manual" })).status).toBe(302);
    const pageRes = await fetch(`${console_.url}/graph`, { headers: { cookie } });
    expect(pageRes.status).toBe(200);
    const body = await pageRes.text();
    expect(body).toContain("<canvas");
    expect(body).toContain(`data-type="concept"`); // legend chip for a type the example vault has
    expect(body).toContain(`id="gs-repel"`); // the Obsidian-style settings panel
    expect(body).toContain(`id="gs-arrows"`);
    const dataRes = await fetch(`${console_.url}/graph.json`, { headers: { cookie } });
    const graph = (await dataRes.json()) as {
      nodes: Array<{ id: string; type: string; degree: number; active: boolean }>;
      edges: Array<{ from: string; rel: string; to: string }>;
    };
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      (graph.nodes as Array<{ summary?: string }>).some((n) => (n.summary ?? "").length > 0),
    ).toBe(true); // hover cards need summaries
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

  test("manual refresh drops caches once per minute, authed only", async () => {
    const cookie = await login();
    const anon = await fetch(`${console_.url}/dashboard/refresh`, {
      method: "POST",
      redirect: "manual",
    });
    expect(anon.status).toBe(302); // stranger → login bounce, no cache drop
    const first = await fetch(`${console_.url}/dashboard/refresh`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/dashboard?refreshed=1");
    const page = await fetch(`${console_.url}/dashboard?refreshed=1`, { headers: { cookie } });
    expect(await page.text()).toContain("refreshed — every card refetched");
    const second = await fetch(`${console_.url}/dashboard/refresh`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    expect(second.status).toBe(303);
    expect(second.headers.get("location")).toMatch(/\/dashboard\?throttled=\d+/);
    const throttledPage = await fetch(`${console_.url}${second.headers.get("location")}`, {
      headers: { cookie },
    });
    expect(await throttledPage.text()).toContain("throttled — next refresh in");
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

describe("tasks (§16) — the console's one write path", () => {
  const post = (
    cookie: string,
    path: string,
    fields: Record<string, string | string[]>,
    headers: Record<string, string> = {},
  ) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields))
      for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return fetch(`${console_.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: console_.url, ...headers },
      body,
    });
  };
  const get = async (cookie: string, path: string) =>
    (await fetch(`${console_.url}${path}`, { headers: { cookie } })).text();
  async function csrfFor(cookie: string): Promise<string> {
    const body = await get(cookie, "/tasks/new");
    return /name="csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
  }
  const idFrom = (res: Response) =>
    (res.headers.get("location") ?? "").slice("/tasks/".length).split("?")[0] as string;

  test("the tab renders behind auth, empty at first, with the bar, the rule, the nav entry, the CSP, and its script", async () => {
    expect((await fetch(`${console_.url}/tasks`, { redirect: "manual" })).status).toBe(302);
    const cookie = await login();
    const res = await fetch(`${console_.url}/tasks`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("nothing open");
    expect(body).toContain(`href="/tasks"`);
    expect(body).toContain("form-action 'self'");
    expect(body).toContain("America/Toronto");
    expect(body).toContain(`class="bar"`);
    expect(body).toContain(`<hr class="rule">`);
    expect(body).toContain(`href="/tasks/tags"`);
    const js = await fetch(`${console_.url}/tasks.js`, { headers: { cookie } });
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(await js.text()).toContain("showModal");
  });

  test("the new-task form: custom interval and time inputs exist but are CSS-hidden until chosen", async () => {
    const cookie = await login();
    const form = await get(cookie, "/tasks/new");
    expect(form).toContain(`class="interval-pick"`);
    expect(form).toContain(`name="interval_custom"`);
    expect(form).toContain(`class="due-pick"`);
    expect(form).toContain(`type="date" name="due"`);
    expect(form).toContain(`name="has_time"`); // unchecked by default
    expect(form).not.toContain(`name="has_time" checked`);
    expect(form).toContain(`type="time" name="time"`);
    // the hide rules ride the page CSS, keyed on :has()
    expect(form).toContain(
      "option:not([value=custom]):checked) input[name=interval_custom] { display:none; }",
    );
    expect(form).toContain(
      "input[name=has_time]:not(:checked)) input[type=time] { display:none; }",
    );
  });

  test("a POST without the token, from another origin, or anonymous writes nothing", async () => {
    const cookie = await login();
    const csrf = await csrfFor(cookie);
    expect(csrf.length).toBeGreaterThan(20);
    expect((await post(cookie, "/tasks", { title: "x", interval: "1w" })).status).toBe(403);
    expect(
      (
        await post(
          cookie,
          "/tasks",
          { title: "x", interval: "1w", csrf },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(cookie, "/tasks", { title: "x", interval: "1w", csrf: `${csrf.slice(0, -2)}zz` }))
        .status,
    ).toBe(403);
    const anon = await fetch(`${console_.url}/tasks`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: console_.url },
      body: new URLSearchParams({ title: "x", interval: "1w", csrf }),
    });
    expect(anon.status).toBe(302); // login bounce, nothing written
    expect(await get(cookie, "/tasks")).not.toContain(">x<");
  });

  test("create (date-only) → list → done prompt (yes default) → rolled a week out → retire → reopen timed", async () => {
    const cookie = await login();
    const csrf = await csrfFor(cookie);
    const created = await post(cookie, "/tasks", {
      csrf,
      title: "water plants",
      notes: "the fern",
      interval: "1w",
      anchor: "completion",
      due: "",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toMatch(/^\/tasks\/[A-Za-z0-9_-]+\?ok=created$/);
    const id = idFrom(created);
    const list = await get(cookie, "/tasks");
    expect(list).toContain("water plants");
    expect(list).toContain(`href="/tasks?tag=every%201%20week"`); // the interval is a tag
    expect(list).toContain(`href="/tasks/${id}/close?kind=completed"`);
    expect(list).toContain("text-decoration:underline"); // titles read as links
    const detail0 = await get(cookie, `/tasks/${id}`);
    // date-only: the due line carries no clock time (history timestamps always do)
    const dueLine = /in 7 days<\/span>\s*<span class="muted">([^<]+)</.exec(detail0)?.[1] ?? "";
    expect(dueLine).toMatch(/2026$/);
    expect(dueLine).not.toMatch(/[AP]M/);
    const prompt = await get(cookie, `/tasks/${id}/close?kind=completed`);
    expect(prompt).toContain("schedule again?");
    expect(prompt).toContain(`value="yes" checked`); // the owner's default
    const done = await post(cookie, `/tasks/${id}/close`, {
      csrf,
      kind: "completed",
      repeat: "yes",
    });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/tasks?ok=done-rolled");
    const detail = await get(cookie, `/tasks/${id}`);
    expect(detail).toContain("done · on time");
    expect(detail).toContain("next due");
    expect(detail).toContain("in 7 days");
    expect(detail).toContain("1 closed");
    // the detail page's shape: colored action trio, history toggle, edit modal
    expect(detail).toContain(`class="btn good"`);
    expect(detail).toContain(`class="btn warn"`);
    expect(detail).toContain(`class="btn bad"`);
    expect(detail).toContain("<details");
    expect(detail).toContain("history");
    expect(detail).toContain(`<dialog id="edit">`);
    expect(detail).toContain(`data-dialog="edit"`);
    expect(detail).toContain(`formmethod="dialog"`);
    expect(detail).toContain(`src="/tasks.js"`);
    const retired = await post(cookie, `/tasks/${id}/retire`, { csrf });
    expect(retired.headers.get("location")).toBe(`/tasks/${id}?ok=retired`);
    const retiredList = await get(cookie, "/tasks?view=retired");
    expect(retiredList).toContain("water plants");
    expect(retiredList).toContain(`href="/tasks/${id}/purge"`); // delete forever, retired only
    expect(
      (
        await fetch(`${console_.url}/tasks/${id}/close?kind=completed`, {
          headers: { cookie },
          redirect: "manual",
        })
      ).status,
    ).toBe(303);
    const reopened = await post(cookie, `/tasks/${id}/reopen`, {
      csrf,
      due: "2026-12-01",
      has_time: "on",
      time: "09:00",
    });
    expect(reopened.status).toBe(303);
    const again = await get(cookie, `/tasks/${id}`);
    expect(again).toMatch(/Dec 1, 2026(,| at) 9:00 AM/); // timed, rendered in TASKS_TZ
    expect(again).toContain("reopened");
    // and back to date-only via reschedule without the time toggle
    const moved = await post(cookie, `/tasks/${id}/reschedule`, { csrf, due: "2026-12-02" });
    expect(moved.headers.get("location")).toBe(`/tasks/${id}?ok=rescheduled`);
    const dated = await get(cookie, `/tasks/${id}`);
    expect(dated).toContain("Dec 2, 2026");
    expect(dated).not.toMatch(/Dec 2, 2026(,| at) \d/); // date-only again: no clock
  });

  test("tags: managed on their own page, assigned by checkbox, filterable, built-ins read-only", async () => {
    const cookie = await login();
    const csrf = await csrfFor(cookie);
    const tagsEmpty = await get(cookie, "/tasks/tags");
    expect(tagsEmpty).toContain("no tags yet");
    expect(tagsEmpty).toContain("built-in");
    expect(
      (await post(cookie, "/tasks/tags", { csrf, name: "retired" })).headers.get("location"),
    ).toMatch(/err=.*built-in/);
    expect(
      (await post(cookie, "/tasks/tags", { csrf, name: "home" })).headers.get("location"),
    ).toBe("/tasks/tags?ok=tag-created");
    const tagsPage = await get(cookie, "/tasks/tags");
    expect(tagsPage).toContain(`value="home"`);
    const tid = /\/tasks\/tags\/(\d+)\/rename/.exec(tagsPage)?.[1] as string;
    expect(tid).toBeTruthy();
    // the task form now offers it as a read-only checkbox list
    expect(await get(cookie, "/tasks/new")).toContain(`name="tags" value="home"`);
    const a = idFrom(
      await post(cookie, "/tasks", { csrf, title: "sweep", interval: "1w", tags: ["home"] }),
    );
    idFrom(await post(cookie, "/tasks", { csrf, title: "untagged", interval: "1w" }));
    const all = await get(cookie, "/tasks");
    expect(all).toContain(`href="/tasks?tag=home"`);
    const filtered = await get(cookie, "/tasks?tag=home");
    expect(filtered).toContain("sweep");
    expect(filtered).not.toContain("untagged");
    expect(filtered).toContain("filtered by");
    expect(await get(cookie, `/tasks/${a}`)).toContain(`name="tags" value="home" checked`);
    // rename flows through to the task; delete removes it from the task
    expect(
      (await post(cookie, `/tasks/tags/${tid}/rename`, { csrf, name: "house" })).headers.get(
        "location",
      ),
    ).toBe("/tasks/tags?ok=tag-renamed");
    expect(await get(cookie, `/tasks/${a}`)).toContain(`href="/tasks?tag=house"`);
    expect(
      (await post(cookie, `/tasks/tags/${tid}/delete`, { csrf })).headers.get("location"),
    ).toBe("/tasks/tags?ok=tag-deleted");
    expect(await get(cookie, `/tasks/${a}`)).not.toContain(`href="/tasks?tag=house"`);
    // derived tags list with counts and cannot be posted to
    const tagsAfter = await get(cookie, "/tasks/tags");
    expect(tagsAfter).toContain(`href="/tasks?tag=every%201%20week"`);
    expect(tagsAfter).toContain("· interval");
    expect(tagsAfter).toContain("· status");
  });

  test("permanent delete: retired only, confirmed on its own page, gone afterwards", async () => {
    const cookie = await login();
    const csrf = await csrfFor(cookie);
    const id = idFrom(await post(cookie, "/tasks", { csrf, title: "temp", interval: "1d" }));
    const tooEarly = await fetch(`${console_.url}/tasks/${id}/purge`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(tooEarly.status).toBe(303);
    expect(tooEarly.headers.get("location")).toMatch(/err=.*retire/);
    expect((await post(cookie, `/tasks/${id}/purge`, { csrf })).headers.get("location")).toMatch(
      /err=.*retired/,
    );
    await post(cookie, `/tasks/${id}/retire`, { csrf });
    const confirm = await get(cookie, `/tasks/${id}/purge`);
    expect(confirm).toContain("delete forever");
    expect(confirm).toContain("no undo");
    const purged = await post(cookie, `/tasks/${id}/purge`, { csrf });
    expect(purged.headers.get("location")).toBe("/tasks?view=retired&ok=purged");
    expect((await fetch(`${console_.url}/tasks/${id}`, { headers: { cookie } })).status).toBe(404);
  });

  test("rule violations come back as a notice on the form, never a 500; bad ids 404", async () => {
    const cookie = await login();
    const csrf = await csrfFor(cookie);
    const bad = await post(cookie, "/tasks", { csrf, title: "   ", interval: "1w" });
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toMatch(/^\/tasks\/new\?err=/);
    const form = await get(cookie, bad.headers.get("location") as string);
    expect(form).toContain("title is required");
    const badInterval = await post(cookie, "/tasks", {
      csrf,
      title: "x",
      interval: "custom",
      interval_custom: "soonish",
    });
    expect(badInterval.headers.get("location")).toMatch(/unreadable/);
    expect((await fetch(`${console_.url}/tasks/nope`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${console_.url}/tasks/..%2Fetc`, { headers: { cookie } })).status).toBe(
      404,
    );
    expect((await fetch(`${console_.url}/tasks/tags/9/nope`, { headers: { cookie } })).status).toBe(
      404,
    );
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
