/**
 * Audit log (§4.2 box 8): append-only JSONL, hash-chained — entry N's hash
 * covers entry N and entry N-1's hash, so any edit or deletion breaks the
 * chain from that point on. Arguments are logged as digests, never values:
 * the audit trail must not become a secret store.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEvent {
  type: "decision" | "call" | "confirm_issued" | "confirm_spent" | "error" | "rate_limited";
  principal: string;
  surface: string;
  urn: string;
  kind?: string;
  effect?: string;
  ruleIndex?: number;
  argsDigest?: string;
  outcome?: string;
  /** Upstream call duration — on call/error events only (W1.7 analytics). */
  ms?: number;
}

interface AuditLine {
  seq: number;
  ts: string;
  prev: string;
  event: AuditEvent;
  hash: string;
}

const GENESIS = "0".repeat(64);

function sha256hex(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

export function digestArgs(args: unknown): string {
  return `sha256:${sha256hex(JSON.stringify(args ?? null))}`;
}

export class AuditLog {
  private seq = 0;
  private prev = GENESIS;

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const parsed = JSON.parse(last) as AuditLine;
        this.seq = parsed.seq;
        this.prev = parsed.hash;
      }
    }
  }

  append(event: AuditEvent): AuditLine {
    const entry = {
      seq: this.seq + 1,
      ts: this.clock().toISOString(),
      prev: this.prev,
      event,
    };
    const hash = sha256hex(JSON.stringify(entry));
    const line: AuditLine = { ...entry, hash };
    appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.seq = line.seq;
    this.prev = hash;
    return line;
  }

  static verify(path: string): { ok: boolean; entries: number; breakAt: number | null } {
    if (!existsSync(path)) return { ok: true, entries: 0, breakAt: null };
    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    let prev = GENESIS;
    for (const [i, raw] of lines.entries()) {
      const { hash, ...entry } = JSON.parse(raw) as AuditLine;
      if (entry.prev !== prev || entry.seq !== i + 1 || sha256hex(JSON.stringify(entry)) !== hash) {
        return { ok: false, entries: lines.length, breakAt: i + 1 };
      }
      prev = hash;
    }
    return { ok: true, entries: lines.length, breakAt: null };
  }
}
