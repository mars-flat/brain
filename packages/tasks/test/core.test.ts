/**
 * The recurrence rules as properties (§8.3 style, §16.2 claims): a task has
 * at most one open occurrence; a late task never piles up; due-anchored
 * rolls keep their cadence phase and land in the future; date-only tasks
 * stay pinned to local noon across DST; the event log replays to the row;
 * and the whole thing is deterministic.
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
  isReservedTagName,
  nextDue,
  normalizeTagName,
  parseInterval,
  type Task,
  TaskError,
} from "../src/core.ts";
import { openTasksDb, TaskStore } from "../src/store.ts";
import { DAY_MS, localDate, wallOf } from "../src/time.ts";

const T0 = Date.UTC(2026, 8, 17, 12, 0, 0);
const HOUR = 3_600_000;

/** A timed weekly task due at T0, created a day earlier. */
function task(over: Partial<Task> = {}): Task {
  const base = createTask(
    { title: "water plants", intervalMs: 7 * DAY_MS, dueAt: T0, hasTime: true },
    T0 - DAY_MS,
    "t1",
  ).task;
  return { ...base, ...over };
}

describe("close → next occurrence (timed tasks)", () => {
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

describe("date-only tasks (§16.2): a day, pinned to local noon", () => {
  const TZ = "America/Toronto";
  const noonOn = (y: number, m: number, d: number) => {
    // Toronto noon is 16:00Z in summer (EDT) and 17:00Z in winter (EST).
    const t = Date.UTC(y, m - 1, d, 16, 0);
    return wallOf(t, TZ).hour === 12 ? t : t + HOUR;
  };

  test("created without a time → noon on the local day, hasTime false by default", () => {
    const created = createTask(
      { title: "x", intervalMs: DAY_MS, dueAt: Date.UTC(2026, 8, 24, 3, 30) }, // 23:30 Sep 23 local
      T0,
      "d1",
      TZ,
    ).task;
    expect(created.hasTime).toBe(false);
    expect(wallOf(created.dueAt as number, TZ)).toMatchObject({
      month: 9,
      day: 23,
      hour: 12,
      minute: 0,
    });
  });

  test("a weekly Monday task stays on Mondays at noon across the DST change", () => {
    let t = createTask(
      { title: "bins", intervalMs: 7 * DAY_MS, anchor: "due", dueAt: noonOn(2026, 10, 19) },
      T0,
      "d2",
      TZ,
    ).task;
    for (let i = 0; i < 6; i++) {
      // done on time each week; Nov 1 2026 is the fall-back Sunday in Toronto
      t = closeTask(t, "completed", {}, t.dueAt as number, TZ).task;
      const w = wallOf(t.dueAt as number, TZ);
      expect(w.hour).toBe(12);
      expect(w.minute).toBe(0);
      expect(new Date(t.dueAt as number).getUTCDay()).toBe(1); // Monday (noon local is same UTC day)
    }
    expect(localDate(t.dueAt as number, TZ)).toBe("2026-11-30");
  });

  test("completion-anchored date-only roll lands on noon of the day interval-from-now", () => {
    const t = createTask({ title: "x", intervalMs: 3 * DAY_MS, dueAt: T0 }, T0, "d3", TZ).task;
    const now = Date.UTC(2026, 8, 20, 2, 0); // 22:00 Sep 19 local
    const after = closeTask(t, "completed", {}, now, TZ).task;
    expect(after.hasTime).toBe(false);
    expect(localDate(after.dueAt as number, TZ)).toBe("2026-09-22");
    expect(wallOf(after.dueAt as number, TZ).hour).toBe(12);
  });

  test("a manual date-only placement may be today (the day is the unit), never yesterday", () => {
    const t = createTask({ title: "x", intervalMs: DAY_MS, dueAt: T0 }, T0, "d4", TZ).task;
    const now = Date.UTC(2026, 8, 24, 20, 0); // 16:00 Sep 24 local, past noon
    const today = closeTask(t, "completed", { nextDueAt: now, nextHasTime: false }, now, TZ).task;
    expect(localDate(today.dueAt as number, TZ)).toBe("2026-09-24");
    expect(() =>
      closeTask(t, "completed", { nextDueAt: now - DAY_MS, nextHasTime: false }, now, TZ),
    ).toThrow(/future/);
  });

  test("giving a timed placement to a date-only task makes it timed, and vice versa", () => {
    const t = createTask({ title: "x", intervalMs: DAY_MS, dueAt: T0 }, T0, "d5", TZ).task;
    const timed = closeTask(
      t,
      "completed",
      { nextDueAt: Date.UTC(2026, 8, 25, 13, 0), nextHasTime: true },
      T0,
      TZ,
    ).task;
    expect(timed.hasTime).toBe(true);
    expect(timed.dueAt).toBe(Date.UTC(2026, 8, 25, 13, 0));
    expect(timed.dueAt).not.toBe(noonOn(2026, 9, 25));
  });
});

// ── model-based: random op sequences against the real store ───────────────

type Op =
  | { op: "create"; title: string; interval: number | null; anchor: Anchor; hasTime: boolean }
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
  | { op: "reopen"; which: number }
  | { op: "purge"; which: number };

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
    hasTime: fc.boolean(),
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
  fc.record({ op: fc.constant("purge" as const), which: fc.nat(20) }),
);

/** Runs the ops with a fake monotonic clock and counter ids; asserts invariants after each. */
function run(ops: Op[], tz = "UTC"): TaskStore {
  let now = T0;
  let n = 0;
  const store = new TaskStore(
    openTasksDb(":memory:"),
    () => now,
    () => `t${++n}`,
    tz,
  );
  const pick = (which: number): Task | undefined => {
    const all = store.list("all");
    return all.length ? all[which % all.length] : undefined;
  };
  for (const op of ops) {
    try {
      switch (op.op) {
        case "create":
          store.create({
            title: op.title,
            intervalMs: op.interval,
            anchor: op.anchor,
            hasTime: op.hasTime,
          });
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
            const due = after.dueAt as number;
            if (after.hasTime) expect(due).toBeGreaterThan(now);
            else {
              // date-only: pinned to noon, today or later
              expect(wallOf(due, tz)).toMatchObject({ hour: 12, minute: 0, second: 0 });
              expect(localDate(due, tz) >= localDate(now, tz)).toBe(true);
            }
            if (nextDueAt === undefined && before.intervalMs && before.hasTime) {
              if (before.anchor === "completion") expect(due).toBe(now + before.intervalMs);
              else {
                expect((due - (before.dueAt as number)) % before.intervalMs).toBe(0);
                expect(due - before.intervalMs).toBeLessThanOrEqual(
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
        case "purge": {
          const t = pick(op.which);
          if (t) {
            store.purge(t.id); // throws unless retired
            expect(store.get(t.id)).toBeNull();
            expect(store.events(t.id)).toEqual([]);
          }
          break;
        }
      }
    } catch (err) {
      // Rule violations (closing a retired task, purging an open one…)
      // are expected under random ops; anything else is a real bug.
      if (!(err instanceof TaskError)) throw err;
    }
    for (const t of store.list("all")) {
      expect(t.status === "open").toBe(t.dueAt != null); // one open occurrence, or none
      expect(t.updatedAt).toBeGreaterThanOrEqual(t.createdAt);
      if (t.dueAt != null && !t.hasTime) expect(wallOf(t.dueAt, tz).hour).toBe(12);
    }
  }
  return store;
}

describe("store under random operation sequences", () => {
  test("the event log replays to the row, for every task, after any history (UTC and Toronto)", () => {
    fc.assert(
      fc.property(
        fc.array(arbOp, { maxLength: 40 }),
        fc.constantFrom("UTC", "America/Toronto"),
        (ops, tz) => {
          const store = run(ops, tz);
          for (const t of store.list("all")) expect(foldEvents(store.events(t.id))).toEqual(t);
        },
      ),
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
    const t = store.create({ title: "x", intervalMs: DAY_MS, hasTime: true });
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

describe("tag names", () => {
  test("trimmed and single-spaced; empty, long, and built-in names are refused", () => {
    expect(normalizeTagName("  home   chores ")).toBe("home chores");
    expect(() => normalizeTagName("   ")).toThrow(/required/);
    expect(() => normalizeTagName("x".repeat(41))).toThrow(/too long/);
    for (const reserved of ["open", "Retired", "one-off", "every 2 days", "EVERY week"]) {
      expect(isReservedTagName(reserved)).toBe(true);
      expect(() => normalizeTagName(reserved)).toThrow(/built-in/);
    }
    expect(isReservedTagName("everyday")).toBe(false);
  });
});
