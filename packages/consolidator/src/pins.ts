/**
 * Pins (§5.7, §5.10): owner-issued corrections that survive all future
 * generation. A pin is a small note under pins/ — frontmatter locates it,
 * the body is the correction that rides along with every full-tier render
 * of the target node.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitCommitVault } from "./run.ts";

export interface WrittenPin {
  pinId: string;
  filePath: string;
}

export function writePin(
  vaultPath: string,
  nodeId: string,
  correction: string,
  reason: string,
  now: Date,
  gitCommit = true,
): WrittenPin {
  const dir = join(vaultPath, "pins");
  mkdirSync(dir, { recursive: true });
  const pinId = `pin-${nodeId}-${now.toISOString().slice(0, 10)}-${now.getTime() % 100000}`;
  const content = [
    "---",
    `pin_id: ${pinId}`,
    `node_id: ${nodeId}`,
    `created: ${now.toISOString().slice(0, 10)}`,
    `reason: ${JSON.stringify(reason)}`,
    "---",
    "",
    correction,
    "",
  ].join("\n");
  const filePath = join(dir, `${pinId}.md`);
  writeFileSync(filePath, content);
  if (gitCommit) gitCommitVault(vaultPath, `pin ${nodeId}: ${reason.slice(0, 60)}`);
  return { pinId, filePath };
}

/** Crockford-base32 ULID for episode ids (ep_ prefix added by callers). */
export function ulid(now: Date = new Date()): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ts = now.getTime();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  let rand = "";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) rand += ALPHABET[(bytes[i] as number) % 32];
  return time + rand;
}
