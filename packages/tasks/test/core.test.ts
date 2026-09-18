/**
 * The recurrence rules as properties (§8.3 style, §16.2 claims): a task has
 * at most one open occurrence; a late task never piles up; due-anchored
 * rolls keep their cadence phase and land in the future; the event log
 * replays to the row; and the whole thing is deterministic.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  ANCHORS,
  type Anchor,
  type CloseKind,
  closeTask,
  createTask,
  foldEvents,
  formatInterval,
  nextDue,
  parseInterval,
  type Task,
  TaskError,
} from "../src/core.ts";
import { openTasksDb, TaskStore } from "../src/store.ts";
import { DAY_MS } from "../src/time.ts";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOUR = 3_600_000;

function task(over: Partial<Task> = {}): Task {
  const base = createTask(
    { title: "water plants", intervalMs: 7 * DAY_MS, dueAt: T0 },
    T0 - DAY_MS,
    "t1",
  ).task;
  return { ...base, ...over };
}

describe("close → next occurrence", () => {
  test("due-anchored: a late task advances ONE step to the first future slot — never one per missed interval", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 * 24 }).map((h) => h * HOUR),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 60 * 24 * 60 }).map((m) => m * 60_000),
        (interval, missed, jitter) => {
          const t = task({ anchor: "due", intervalMs: interval });
          const now = T0 + missed * interval + (jitter % interval);
          const { task: after, events } = closeTask(t, "completed", {}, now);
          expect(after.status).toBe("open");
          expect(after.dueAt as number).toBeGreaterThan(now);
          expect((after.dueAt as number) - interval).toBeLessThanOrEqual(now);
          expect(((after.dueAt as number) - T0) % interval).toBe(0);
          expect(events.map((e) => e.kind)).toEqual(["completed", "rolled"]);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("completion-anchored: next = now + interval, however late", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 90 }).map((d) => d * DAY_MS),
        fc.integer({ min: -DAY_MS, max: 400 * DAY_MS }),
        (interval, lateness) => {
          const t = task({ anchor: "completion", intervalMs: interval });
          const now = T0 + lateness;
          const after = closeTask(t, "cancelled", {}, now).task;
          expect(after.dueAt).toBe(now + interval);
        },
      ),
    );
  });

  test("repeat=false retires; a one-off retires by default", () => {
    const r = closeTask(task(), "completed", { repeat: false }, T0);
    expect(r.task.status).toBe("retired");
    expect(r.task.dueAt).toBeNull();
    expect(r.events.map((e) => e.kind)).toEqual(["completed", "retired"]);
    const oneOff = closeTask(task({ intervalMs: null }), "completed", {}, T0);
    expect(oneOff.task.status).toBe("retired");
  });

  test("a one-off asked to repeat needs a manual date; manual dates must be in the future", () => {
    expect(() => closeTask(task({ intervalMs: null }), "completed", { repeat: true }, T0)).toThrow(
      TaskError,
    );
    const placed = closeTask(
      task({ intervalMs: null }),
      "completed",
      { repeat: true, nextDueAt: T0 + 3 * DAY_MS },
      T0,
    );
    expect(placed.task.dueAt).toBe(T0 + 3 * DAY_MS);
    expect(placed.events[1]?.detail.manual).toBe(true);
    expect(() => closeTask(task(), "completed", { nextDueAt: T0 - 1 }, T0)).toThrow(/future/);
  });

  test("closing anything but an open task is a rule violation, not a crash", () => {
    const retired = closeTask(task(), "completed", { repeat: false }, T0).task;
    expect(() => closeTask(retired, "completed", {}, T0)).toThrow(TaskError);
    expect(() => nextDue(task({ intervalMs: null }), T0)).toThrow(TaskError);
  });

  test("lateness is recorded on the close event, clamped at zero", () => {
    expect(closeTask(task(), "completed", {}, T0 + HOUR).events[0]?.detail.lateMs).toBe(HOUR);
    expect(closeTask(task(), "completed", {}, T0 - HOUR).events[0]?.detail.lateMs).toBe(0);
  });
});

// ── model-based: random op sequences against the real store ───────────────

type Op =
  | { op: "create"; title: string; interval: number | null; anchor: Anchor }
  | { op: "advance"; ms: number }
  | {
      op: "close";
      which: number;
      kind: CloseKind;
      repeat: boolean | undefined;
      manualDays: number | null;
    }
  | { op: "reschedule"; which: number; deltaDays: number }
  | {
      op: "edit";
      which: number;
      interval: number | null | undefined;
      anchor: Anchor | undefined;
      title: string | undefined;
    }
  | { op: "retire"; which: number }
  | { op: "reopen"; which: number };

const arbInterval = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 1, max: 90 }).map((d) => d * DAY_MS),
  fc.integer({ min: 1, max: 12 }).map((h) => h * HOUR),
);
const arbAnchor = fc.constantFrom(...ANCHORS);
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    op: fc.constant("create" as const),
    title: fc.constantFrom("water plants", "pay rent", "backup laptop"),
    interval: arbInterval,
    anchor: arbAnchor,
  }),
  fc.record({ op: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 400 * DAY_MS }) }),
  fc.record({
    op: fc.constant("close" as const),
    which: fc.nat(20),
    kind: fc.constantFrom<CloseKind>("completed", "cancelled"),
    repeat: fc.option(fc.boolean(), { nil: undefined }),
    manualDays: fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }),
  }),
  fc.record({
    op: fc.constant("reschedule" as const),
    which: fc.nat(20),
    deltaDays: fc.integer({ min: -30, max: 60 }),
  }),
  fc.record({
    op: fc.constant("edit" as const),
    which: fc.nat(20),
    interval: fc.option(arbInterval, { nil: undefined }),
    anchor: fc.option(arbAnchor, { nil: undefined }),
    title: fc.option(fc.constantFrom("renamed", "again"), { nil: undefined }),
  }),
  fc.record({ op: fc.constant("retire" as const), which: fc.nat(20) }),
  fc.record({ op: fc.constant("reopen" as const), which: fc.nat(20) }),
);

/** Runs the ops with a fake monotonic clock and counter ids; asserts invariants after each. */
function run(ops: Op[]): TaskStore {
  let now = T0;
  let n = 0;
  const store = new TaskStore(
    openTasksDb(":memory:"),
    () => now,
    () => `t${++n}`,
  );
  const pick = (which: number): Task | undefined => {
    const all = store.list("all");
    return all.length ? all[which % all.length] : undefined;
  };
  for (const op of ops) {
    try {
      switch (op.op) {
        case "create":
          store.create({ title: op.title, intervalMs: op.interval, anchor: op.anchor });
          break;
        case "advance":
          now += op.ms;
          break;
        case "close": {
          const before = pick(op.which);
          if (!before) break;
          const nextDueAt = op.manualDays == null ? undefined : now + op.manualDays * DAY_MS;
          const after = store.close(before.id, op.kind, { repeat: op.repeat, nextDueAt });
          expect(after.closes).toBe(before.closes + 1);
          expect(after.lastClosedAt).toBe(now);
          if (after.status === "open") {
            expect(after.dueAt as number).toBeGreaterThan(now);
            if (nextDueAt === undefined && before.intervalMs) {
              if (before.anchor === "completion") expect(after.dueAt).toBe(now + before.intervalMs);
              else {
                expect(
                  ((after.dueAt as number) - (before.dueAt as number)) % before.intervalMs,
                ).toBe(0);
                // the first slot strictly after max(now, due): late tasks land within one
                // interval of now; early closes keep the following slot
                expect((after.dueAt as number) - before.intervalMs).toBeLessThanOrEqual(
                  Math.max(now, before.dueAt as number),
                );
              }
            }
          } else expect(after.dueAt).toBeNull();
          break;
        }
        case "reschedule": {
          const t = pick(op.which);
          if (t) store.reschedule(t.id, now + op.deltaDays * DAY_MS);
          break;
        }
        case "edit": {
          const t = pick(op.which);
          if (t)
            store.update(t.id, { intervalMs: op.interval, anchor: op.anchor, title: op.title });
          break;
        }
        case "retire": {
          const t = pick(op.which);
          if (t) store.retire(t.id);
          break;
        }
        case "reopen": {
          const t = pick(op.which);
          if (t) store.reopen(t.id);
          break;
        }
      }
    } catch (err) {
      // Rule violations (closing a retired task, reopening an open one…)
      // are expected under random ops; anything else is a real bug.
      if (!(err instanceof TaskError)) throw err;
    }
    for (const t of store.list("all")) {
      expect(t.status === "open").toBe(t.dueAt != null); // one open occurrence, or none
      expect(t.updatedAt).toBeGreaterThanOrEqual(t.createdAt);
    }
  }
  return store;
}

describe("store under random operation sequences", () => {
  test("the event log replays to the row, for every task, after any history", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 40 }), (ops) => {
        const store = run(ops);
        for (const t of store.list("all")) expect(foldEvents(store.events(t.id))).toEqual(t);
      }),
      { numRuns: 150 },
    );
  });

  test("same ops + same clock → identical rows and logs (determinism)", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 30 }), (ops) => {
        const a = run(ops);
        const b = run(ops);
        expect(a.list("all")).toEqual(b.list("all"));
        for (const t of a.list("all")) expect(a.events(t.id)).toEqual(b.events(t.id));
      }),
      { numRuns: 60 },
    );
  });

  test("events only ever accumulate; a no-op edit or same-date reschedule writes nothing", () => {
    let now = T0;
    const store = new TaskStore(openTasksDb(":memory:"), () => now);
    const t = store.create({ title: "x", intervalMs: DAY_MS });
    expect(store.events(t.id)).toHaveLength(1);
    now += HOUR;
    expect(store.update(t.id, { title: "x" })).toEqual(t);
    expect(store.reschedule(t.id, t.dueAt as number)).toEqual(t);
    expect(store.events(t.id)).toHaveLength(1);
    store.update(t.id, { title: "y" });
    expect(store.events(t.id)).toHaveLength(2);
  });
});

describe("intervals as humans write them", () => {
  test("parse ↔ format round-trips for hours, days, weeks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.constantFrom<[string, string]>(["h", "hour"], ["d", "day"], ["w", "week"]),
        (n, [short, long]) => {
          const ms = parseInterval(`${n}${short}`) as number;
          expect(parseInterval(`${n} ${long}s`)).toBe(ms);
          expect(parseInterval(formatInterval(ms))).toBe(ms);
        },
      ),
    );
  });

  test("none/empty is a one-off; garbage is a rule violation", () => {
    expect(parseInterval("none")).toBeNull();
    expect(parseInterval("")).toBeNull();
    expect(parseInterval(undefined)).toBeNull();
    expect(formatInterval(null)).toBe("one-off");
    expect(() => parseInterval("soon")).toThrow(TaskError);
    expect(() => parseInterval("0d")).toThrow(TaskError);
    expect(formatInterval(14 * DAY_MS)).toBe("2 weeks");
    expect(formatInterval(10 * DAY_MS)).toBe("10 days");
  });
});
