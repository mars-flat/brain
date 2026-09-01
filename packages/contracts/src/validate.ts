/**
 * Minimal validation helpers for the hand-written guards. Contracts has zero
 * dependencies (§8.1), so runtime validation is implemented here rather than
 * pulled in; the contract tests assert these guards agree with an independent
 * JSON Schema validator on every fixture.
 */

export type GuardResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type Guard<T> = (value: unknown) => GuardResult<T>;

function ok<T>(value: T): GuardResult<T> {
  return { ok: true, value };
}

export function fail<T>(errors: string[]): GuardResult<T> {
  return { ok: false, errors };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class Checker {
  readonly errors: string[] = [];

  fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  string(
    path: string,
    v: unknown,
    opts: { pattern?: RegExp; patternName?: string; minLength?: number; maxLength?: number } = {},
  ): v is string {
    if (typeof v !== "string") {
      this.fail(path, `expected string, got ${typeName(v)}`);
      return false;
    }
    if (opts.minLength !== undefined && v.length < opts.minLength) {
      this.fail(path, `expected at least ${opts.minLength} character(s)`);
      return false;
    }
    if (opts.maxLength !== undefined && v.length > opts.maxLength) {
      this.fail(path, `expected at most ${opts.maxLength} characters`);
      return false;
    }
    if (opts.pattern && !opts.pattern.test(v)) {
      this.fail(path, `does not match ${opts.patternName ?? String(opts.pattern)}`);
      return false;
    }
    return true;
  }

  enum<const T extends readonly string[]>(path: string, v: unknown, allowed: T): v is T[number] {
    if (typeof v !== "string" || !allowed.includes(v)) {
      this.fail(path, `expected one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}`);
      return false;
    }
    return true;
  }

  stringArray(
    path: string,
    v: unknown,
    opts: {
      pattern?: RegExp;
      patternName?: string;
      minLength?: number;
      unique?: boolean;
      minItems?: number;
    } = {},
  ): v is string[] {
    if (!Array.isArray(v)) {
      this.fail(path, `expected array, got ${typeName(v)}`);
      return false;
    }
    if (opts.minItems !== undefined && v.length < opts.minItems) {
      this.fail(path, `expected at least ${opts.minItems} item(s)`);
      return false;
    }
    let good = true;
    v.forEach((item, i) => {
      good =
        this.string(`${path}/${i}`, item, {
          pattern: opts.pattern,
          patternName: opts.patternName,
          minLength: opts.minLength,
        }) && good;
    });
    if (good && opts.unique !== false && new Set(v).size !== v.length) {
      this.fail(path, "items must be unique");
      good = false;
    }
    return good;
  }

  /** Reject properties not in the allowed set — the schema's additionalProperties:false. */
  noExtraKeys(path: string, v: Record<string, unknown>, allowed: readonly string[]): boolean {
    let good = true;
    for (const key of Object.keys(v)) {
      if (!allowed.includes(key)) {
        this.fail(`${path}/${key}`, "unknown property");
        good = false;
      }
    }
    return good;
  }

  result<T>(value: T): GuardResult<T> {
    return this.errors.length === 0 ? ok(value) : fail(this.errors);
  }
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
