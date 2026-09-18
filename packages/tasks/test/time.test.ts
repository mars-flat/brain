/**
 * Zone helpers (§16.3): the wall ↔ instant round-trip holds in every zone,
 * DST included; relative descriptions follow local days, not 24h windows.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  DAY_MS,
  describeDue,
  instantOf,
  localDate,
  parseWhen,
  resolveTz,
  wallString,
} from "../src/time.ts";

const ZONES = ["UTC", "America/Toronto", "Europe/London", "Asia/Kolkata", "Australia/Sydney"];

describe("wall ↔ instant", () => {
  test("instantOf(wallString(t)) reads back as the same wall time, DST edges included", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2020, 0, 1) / 60_000, max: Date.UTC(2035, 0, 1) / 60_000 }),
        fc.constantFrom(...ZONES),
        (minutes, tz) => {
          const ms = minutes * 60_000;
          const wall = wallString(ms, tz);
          expect(wallString(instantOf(wall, tz), tz)).toBe(wall);
        },
      ),
      { numRuns: 400 },
    );
  });

  test("known offsets", () => {
    expect(instantOf("2026-09-24T09:00", "America/Toronto")).toBe(Date.UTC(2026, 8, 24, 13, 0));
    expect(instantOf("2026-01-24T09:00", "America/Toronto")).toBe(Date.UTC(2026, 0, 24, 14, 0));
    expect(instantOf("2026-09-24", "UTC")).toBe(Date.UTC(2026, 8, 24));
    expect(() => instantOf("next tuesday", "UTC")).toThrow(/unreadable/);
  });

  test("parseWhen: explicit offsets win, bare wall times use the zone", () => {
    expect(parseWhen("2026-09-24T09:00:00Z", "America/Toronto")).toBe(Date.UTC(2026, 8, 24, 9));
    expect(parseWhen("2026-09-24T09:00:00-04:00", "UTC")).toBe(Date.UTC(2026, 8, 24, 13));
    expect(parseWhen("2026-09-24T09:00", "America/Toronto")).toBe(Date.UTC(2026, 8, 24, 13));
  });
});

describe("local days", () => {
  test("describeDue counts local days, so 'today' can straddle midnight UTC", () => {
    const now = Date.UTC(2026, 8, 17, 23, 30);
    const tonight = Date.UTC(2026, 8, 18, 1, 0);
    expect(describeDue(tonight, now, "America/Toronto")).toBe("today");
    expect(describeDue(tonight, now, "UTC")).toBe("tomorrow");
    expect(describeDue(now + 3 * DAY_MS, now, "UTC")).toBe("in 3 days");
    expect(describeDue(now - DAY_MS, now, "UTC")).toBe("yesterday");
    expect(describeDue(now - 5 * DAY_MS, now, "UTC")).toBe("5 days overdue");
    expect(localDate(now, "Asia/Tokyo")).toBe("2026-09-18");
  });

  test("resolveTz falls back to UTC on nonsense", () => {
    expect(resolveTz("America/Toronto")).toBe("America/Toronto");
    expect(resolveTz("Mars/Olympus")).toBe("UTC");
    expect(resolveTz(undefined)).toBe("UTC");
    expect(resolveTz("  ")).toBe("UTC");
  });
});
