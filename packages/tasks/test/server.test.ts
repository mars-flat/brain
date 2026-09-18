/**
 * The tasks.* tool surface over a real MCP client connection (§16.5): ten
 * tools, reads annotated read-only, the create → complete → due lifecycle,
 * and rule violations surfacing as tool errors rather than protocol crashes.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTasksServer, TASK_TOOL_NAMES } from "../src/server.ts";
import { openTasksDb, TaskStore } from "../src/store.ts";
import { DAY_MS } from "../src/time.ts";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);
let now = T0;
let client: Client;

beforeAll(async () => {
  const store = new TaskStore(
    openTasksDb(":memory:"),
    () => now,
    () => `id${Math.random().toString(36).slice(2, 8)}`,
  );
  const server = buildTasksServer(store, { tz: "America/Toronto" }, () => now);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    text: (res.content as Array<{ text?: string }>)?.[0]?.text ?? "",
    out: (res.structuredContent ?? {}) as Record<string, unknown>,
  };
}

type TaskOut = {
  id: string;
  status: string;
  due_at: string | null;
  due: string | null;
  interval: string;
  anchor: string;
  closes: number;
};

describe("tool surface", () => {
  test("ten tools; reads carry readOnlyHint, writes carry no destructive hint", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TASK_TOOL_NAMES].sort());
    expect(tools).toHaveLength(10);
    const ann = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
    for (const r of ["list", "get", "due"]) expect(ann.get(r)).toHaveProperty("readOnlyHint", true);
    for (const w of ["create", "complete", "cancel", "reschedule", "update", "retire", "reopen"]) {
      expect(ann.get(w)).not.toHaveProperty("readOnlyHint");
      expect(ann.get(w)).not.toHaveProperty("destructiveHint");
    }
  });
});

describe("lifecycle through the tools", () => {
  test("create → complete rolls by default → due buckets it → cancel with repeat=false retires → reopen", async () => {
    const created = await call("create", {
      title: "water plants",
      interval: "1w",
      notes: "the fern",
    });
    expect(created.isError).toBe(false);
    const t = created.out.task as TaskOut;
    expect(t.status).toBe("open");
    expect(t.interval).toBe("1 week");
    expect(t.due_at).toBe(new Date(T0 + 7 * DAY_MS).toISOString());
    expect(t.due).toBe("in 7 days");

    now = T0 + 8 * DAY_MS; // a day late
    const done = await call("complete", { id: t.id });
    const rolled = done.out.task as TaskOut;
    expect(rolled.closes).toBe(1);
    expect(rolled.due_at).toBe(new Date(now + 7 * DAY_MS).toISOString());
    expect((done.out.events as Array<{ kind: string }>).map((e) => e.kind)).toEqual([
      "completed",
      "rolled",
    ]);

    now = T0 + 15 * DAY_MS + 3_600_000; // due day, an hour past
    const due = await call("due", { horizon_days: 3 });
    expect((due.out.today as TaskOut[]).map((x) => x.id)).toEqual([t.id]);
    expect(due.out.needs_attention).toBe(1);
    expect(due.out.tz).toBe("America/Toronto");

    const skipped = await call("cancel", { id: t.id, repeat: false });
    expect((skipped.out.task as TaskOut).status).toBe("retired");
    expect((await call("list", { status: "open" })).out.tasks).toEqual([]);
    expect(((await call("list", { status: "retired" })).out.tasks as TaskOut[])[0]?.id).toBe(t.id);

    const back = await call("reopen", { id: t.id, due_at: "2026-10-05T09:00" });
    expect((back.out.task as TaskOut).due_at).toBe(
      new Date(Date.UTC(2026, 9, 5, 13)).toISOString(),
    );
    const full = await call("get", { id: t.id });
    expect((full.out.events as unknown[]).length).toBe(6);
  });

  test("update changes the interval and anchor without moving the occurrence; reschedule moves it", async () => {
    now = T0;
    const t = (await call("create", { title: "rent", interval: "30d", due_at: "2026-10-01T09:00" }))
      .out.task as TaskOut;
    const edited = (await call("update", { id: t.id, interval: "4w", anchor: "due" })).out
      .task as TaskOut;
    expect(edited.interval).toBe("4 weeks");
    expect(edited.anchor).toBe("due");
    expect(edited.due_at).toBe(t.due_at);
    const moved = (await call("reschedule", { id: t.id, due_at: "2026-10-02T09:00" })).out
      .task as TaskOut;
    expect(moved.due_at).not.toBe(t.due_at);
    const retired = (await call("retire", { id: t.id })).out.task as TaskOut;
    expect(retired.status).toBe("retired");
  });

  test("rule violations and bad input are tool errors, not crashes", async () => {
    expect((await call("create", { title: "   ", interval: "1d" })).isError).toBe(true);
    expect((await call("create", { title: "x", interval: "soonish" })).text).toMatch(/unreadable/);
    expect((await call("complete", { id: "nope" })).text).toMatch(/no task/);
    expect((await call("reschedule", { id: "nope" })).text).toMatch(/due_at is required/);
    expect((await call("list", { status: "weird" })).isError).toBe(true);
    expect((await call("bogus", {})).text).toMatch(/unknown tool/);
    const oneOff = (await call("create", { title: "once", interval: "none" })).out.task as TaskOut;
    expect(oneOff.interval).toBe("one-off");
    const done = await call("complete", { id: oneOff.id });
    expect((done.out.task as TaskOut).status).toBe("retired");
  });
});
