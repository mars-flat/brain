/**
 * Zone-aware time helpers (§16.3), model-free and library-free: Intl does
 * the zone math. Instants are unix ms everywhere in storage and on the
 * wire; a zone matters only at the day boundary ("due today") and in what
 * a human reads.
 */

export const DAY_MS = 86_400_000;

/** A usable IANA zone, or UTC when the candidate is absent or unknown. */
export function resolveTz(candidate: string | undefined): string {
  const tz = candidate?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of an instant in a zone. */
export function wallOf(ms: number, tz: string): Wall {
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDate(ms: number, tz: string): string {
  const w = wallOf(ms, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** "YYYY-MM-DDTHH:mm" — what a datetime-local input wants. */
export function wallString(ms: number, tz: string): string {
  const w = wallOf(ms, tz);
  return `${localDate(ms, tz)}T${pad(w.hour)}:${pad(w.minute)}`;
}

function offsetAt(ms: number, tz: string): number {
  const w = wallOf(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Inverse of wallString: a wall time in a zone → the instant. Two fixed-point
 * steps handle DST edges; a time inside a spring-forward gap lands after it.
 */
export function instantOf(wall: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(wall.trim());
  if (!m) throw new Error(`unreadable date/time "${wall}" (want YYYY-MM-DDTHH:mm)`);
  const [y, mo, d, h = "0", mi = "0", s = "0"] = m.slice(1) as string[];
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (!Number.isFinite(asUtc)) throw new Error(`unreadable date/time "${wall}"`);
  let guess = asUtc - offsetAt(asUtc, tz);
  guess = asUtc - offsetAt(guess, tz);
  return guess;
}

/** ISO with an explicit offset → Date.parse; a bare wall time → the zone. */
export function parseWhen(text: string, tz: string): number {
  const s = text.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`unreadable date/time "${text}"`);
    return ms;
  }
  return instantOf(s, tz);
}

/** Whole local days from `now` to `at` — negative is the past. */
export function dayDelta(at: number, now: number, tz: string): number {
  const a = Date.parse(`${localDate(at, tz)}T00:00:00Z`);
  const n = Date.parse(`${localDate(now, tz)}T00:00:00Z`);
  return Math.round((a - n) / DAY_MS);
}

/** "today", "tomorrow", "in 3 days", "2 days overdue" — relative to local days. */
export function describeDue(at: number, now: number, tz: string): string {
  const d = dayDelta(at, now, tz);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 1) return `in ${d} days`;
  return `${-d} days overdue`;
}

/** "Thu, Sep 24, 2026, 9:00 AM" in the zone. */
export function formatWhen(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}
