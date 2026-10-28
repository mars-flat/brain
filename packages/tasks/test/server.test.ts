/**
 * The tasks.* tool surface over a real MCP client connection (§16.5): ten
 * tools, reads annotated read-only, the create → complete → due lifecycle,
 * date-only vs timed due values, tags, and rule violations surfacing as
 * tool errors rather than protocol crashes.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTasksServer, TASK_TOOL_NAMES } from "../src/server.ts";
import { openTasksDb, TaskStore } from "../src/store.ts";
import { DAY_MS } from "../src/time.ts";

const TZ = "America/Toronto";
const T0 = Date.UTC(2026, 8, 17, 12, 0, 0); // 08:00 Toronto
let now = T0;
let client: Client;
let store: TaskStore;

beforeAll(async () => {
  store = new TaskStore(
    openTasksDb(":memory:"),
    () => now,
    () => `id${Math.random().toString(36).slice(2, 8)}`,
    TZ,
  );
  const server = buildTasksServer(store, { tz: TZ }, () => now);
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
  has_time: boolean;
  due: string | null;
  due_human: string | null;
  interval: string;
  anchor: string;
  closes: number;
  tags: string[];
};

const isoUtc = (y: number, m: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi)).toISOString();

describe("tool surface", () => {
  test("sixteen tools; reads carry readOnlyHint, writes carry no destructive hint", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TASK_TOOL_NAMES].sort());
    expect(tools).toHaveLength(16);
    const ann = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
    for (const r of ["list", "get", "due", "proposals"])
      expect(ann.get(r)).toHaveProperty("readOnlyHint", true);
    for (const w of [
      "create",
      "complete",
      "cancel",
      "reschedule",
      "update",
      "retire",
      "reopen",
      "propose",
      "accept_proposal",
      "dismiss_proposal",
      "restore_proposal",
      "dismiss_stale_proposals",
    ]) {
      expect(ann.get(w)).not.toHaveProperty("readOnlyHint");
      expect(ann.get(w)).not.toHaveProperty("destructiveHint");
    }
  });
});

describe("lifecycle through the tools", () => {
  test("create (date-only by default) → complete rolls → due buckets it → cancel with repeat=false retires → reopen timed", async () => {
    const created = await call("create", {
      title: "water plants",
      interval: "1w",
      notes: "the fern",
    });
    expect(created.isError).toBe(false);
    const t = created.out.task as TaskOut;
    expect(t.status).toBe("open");
    expect(t.interval).toBe("1 week");
    expect(t.has_time).toBe(false);
    expect(t.due_at).toBe(isoUtc(2026, 9, 24, 16)); // noon Toronto (EDT) on the day a week out
    expect(t.due).toBe("in 7 days");
    expect(t.due_human).toBe("Thu, Sep 24, 2026"); // no clock time on a date-only task

    now = T0 + 8 * DAY_MS; // a day late
    const done = await call("complete", { id: t.id });
    const rolled = done.out.task as TaskOut;
    expect(rolled.closes).toBe(1);
    expect(rolled.has_time).toBe(false);
    expect(rolled.due_at).toBe(isoUtc(2026, 10, 2, 16)); // noon Toronto, a week from now's day
    expect((done.out.events as Array<{ kind: string }>).map((e) => e.kind)).toEqual([
      "completed",
      "rolled",
    ]);

    now = T0 + 15 * DAY_MS + 3_600_000; // Oct 2, 09:00 Toronto — the due day
    const due = await call("due", { horizon_days: 3 });
    expect((due.out.today as TaskOut[]).map((x) => x.id)).toEqual([t.id]);
    expect(due.out.needs_attention).toBe(1);
    expect(due.out.tz).toBe(TZ);

    const skipped = await call("cancel", { id: t.id, repeat: false });
    expect((skipped.out.task as TaskOut).status).toBe("retired");
    expect((await call("list", { status: "open" })).out.tasks).toEqual([]);
    expect(((await call("list", { status: "retired" })).out.tasks as TaskOut[])[0]?.id).toBe(t.id);

    const back = await call("reopen", { id: t.id, due_at: "2026-10-05T09:00" });
    expect((back.out.task as TaskOut).due_at).toBe(isoUtc(2026, 10, 5, 13));
    expect((back.out.task as TaskOut).has_time).toBe(true);
    const full = await call("get", { id: t.id });
    expect((full.out.events as unknown[]).length).toBe(6);
  });

  test("due values: bare date → date-only at noon; wall time or ISO → timed", async () => {
    now = T0;
    const dated = (await call("create", { title: "rent", interval: "30d", due_at: "2026-10-01" }))
      .out.task as TaskOut;
    expect(dated.has_time).toBe(false);
    expect(dated.due_at).toBe(isoUtc(2026, 10, 1, 16));
    const timed = (
      await call("create", { title: "call", interval: "none", due_at: "2026-10-01T09:00" })
    ).out.task as TaskOut;
    expect(timed.has_time).toBe(true);
    expect(timed.due_at).toBe(isoUtc(2026, 10, 1, 13));
    expect(timed.due_human).toContain("9:00 AM");
    const rescheduled = (await call("reschedule", { id: timed.id, due_at: "2026-10-03" })).out
      .task as TaskOut;
    expect(rescheduled.has_time).toBe(false);
    expect(rescheduled.due_at).toBe(isoUtc(2026, 10, 3, 16));
  });

  test("update changes the interval and anchor without moving the occurrence; tags assign by existing name", async () => {
    now = T0;
    store.createTag("home");
    const t = (await call("create", { title: "bins", interval: "30d", due_at: "2026-10-01T09:00" }))
      .out.task as TaskOut;
    const edited = (
      await call("update", { id: t.id, interval: "4w", anchor: "due", tags: ["home"] })
    ).out.task as TaskOut;
    expect(edited.interval).toBe("4 weeks");
    expect(edited.anchor).toBe("due");
    expect(edited.due_at).toBe(t.due_at);
    expect(edited.tags).toEqual(["home"]);
    expect(((await call("list", { tag: "home" })).out.tasks as TaskOut[]).map((x) => x.id)).toEqual(
      [t.id],
    );
    expect((await call("update", { id: t.id, tags: ["nope"] })).text).toMatch(/no such tag/);
    const retired = (await call("retire", { id: t.id })).out.task as TaskOut;
    expect(retired.status).toBe("retired");
  });

  test("rule violations and bad input are tool errors, not crashes", async () => {
    expect((await call("create", { title: "   ", interval: "1d" })).isError).toBe(true);
    expect((await call("create", { title: "x", interval: "soonish" })).text).toMatch(/unreadable/);
    expect((await call("create", { title: "x", interval: "1d", due_at: "tuesday" })).text).toMatch(
      /unreadable/,
    );
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

describe("proposed tasks through the tools", () => {
  test("propose → proposals → fold → accept creates a task; duplicates report, never error", async () => {
    const source = {
      kind: "gmail",
      account: "g-test",
      from: "LEARN",
      subject: "A3 posted",
      received_at: now,
    };
    const p1 = await call("propose", {
      title: "CS 348 A3 due",
      kind: "university",
      entity: "CS348 A3",
      dedupe_key: "gmail:g-test:m1",
      thread_key: "gmail:g-test:t1",
      source,
      due_at: "2026-09-24",
      confidence: 0.8,
    });
    expect(p1.isError).toBe(false);
    expect(p1.out.outcome).toBe("created");
    const prop = p1.out.proposal as {
      id: string;
      due_at: string;
      has_time: boolean;
      due_human: string;
    };
    expect(prop.has_time).toBe(false);
    expect(prop.due_human).toMatch(/Sep 24/);
    const listed = await call("proposals");
    expect((listed.out.proposals as unknown[]).length).toBe(1);
    expect(listed.out.counts).toEqual({ pending: 1, accepted: 0, dismissed: 0 });
    const p2 = await call("propose", {
      title: "A3 extended",
      kind: "university",
      entity: "cs-348 a3",
      dedupe_key: "gmail:g-test:m2",
      source: { ...source, subject: "A3 extended" },
    });
    expect(p2.out.outcome).toBe("folded");
    const bad = await call("propose", {
      title: "x",
      kind: "chore",
      entity: "x",
      dedupe_key: "k",
      source,
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/kind must be/);
    const noInterval = await call("accept_proposal", { id: prop.id });
    expect(noInterval.isError).toBe(false); // interval "none" → one-off
    const task = noInterval.out.task as TaskOut & { title: string };
    expect(task.status).toBe("open");
    expect((noInterval.out.proposal as { status: string; task_id: string }).task_id).toBe(task.id);
    const dup = await call("propose", {
      title: "CS 348 A3 due",
      kind: "university",
      entity: "CS348 A3",
      dedupe_key: "gmail:g-test:m3",
      source,
    });
    expect(dup.out).toMatchObject({ outcome: "duplicate", reason: "accepted" });
    // Proposals never surface as tasks.
    const due = await call("due", { horizon_days: 60 });
    const all = [
      due.out.overdue,
      due.out.today,
      due.out.upcoming,
      due.out.later,
    ].flat() as TaskOut[];
    expect(all.some((t) => t.id === task.id)).toBe(true);
    expect((await call("list", { status: "open" })).out.tasks).toHaveLength(all.length);
  });

  test("dismiss → restore → stale trim", async () => {
    const source = { kind: "session" };
    const p = await call("propose", {
      title: "review/cancel Netflix",
      kind: "subscription",
      entity: "netflix",
      dedupe_key: "session:1",
      source,
    });
    const id = (p.out.proposal as { id: string }).id;
    expect((await call("dismiss_proposal", { id })).out.proposal).toMatchObject({
      status: "dismissed",
      dismiss_reason: "owner",
    });
    expect(
      (
        await call("propose", {
          title: "Netflix receipt",
          kind: "subscription",
          entity: "Netflix",
          dedupe_key: "session:2",
          source,
        })
      ).out,
    ).toMatchObject({ outcome: "duplicate", reason: "dismissed" });
    expect((await call("restore_proposal", { id })).out.proposal).toMatchObject({
      status: "pending",
    });
    now += 8 * DAY_MS;
    expect((await call("dismiss_stale_proposals", { older_than_days: 7 })).out.dismissed).toBe(1);
    expect((await call("restore_proposal", { id: "nope" })).isError).toBe(true);
  });
});
