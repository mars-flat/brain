/**
 * brain backup (§3.1 migration runbook, step 1): push the vault to its
 * private remote when one exists, then tarball the whole vault directory —
 * markdown AND `_index/brain.db`, because salience and the consolidator
 * ledger live only in SQLite (§5.2) and a restore without them silently
 * loses state the markdown cannot reproduce. Restore = untar as vault/,
 * `docker compose up`, `brain doctor` (§3.1 steps 2–4).
 */

import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export interface BackupResult {
  outPath: string;
  /** true/false = push attempted; "no-remote" = local-only vault. */
  pushed: boolean | "no-remote";
  bytes: number;
}

export function backupVault(vaultPath: string, outPath?: string, now = new Date()): BackupResult {
  const vault = resolve(vaultPath);
  if (!existsSync(vault)) throw new Error(`no vault at ${vault}`);
  const stamp = now.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const out = resolve(outPath ?? `brain-backup-${stamp}.tar.gz`);

  let pushed: BackupResult["pushed"] = "no-remote";
  const remotes = Bun.spawnSync(["git", "remote"], { cwd: vault });
  if (remotes.exitCode === 0 && remotes.stdout.toString().trim() !== "") {
    const push = Bun.spawnSync(["git", "push", "-q", "origin", "HEAD"], { cwd: vault });
    pushed = push.exitCode === 0;
  }

  const tar = Bun.spawnSync(["tar", "-czf", out, "-C", dirname(vault), basename(vault)], {
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString().trim()}`);
  return { outPath: out, pushed, bytes: Bun.file(out).size };
}
