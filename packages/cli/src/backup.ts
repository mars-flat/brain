/**
 * brain backup (§3.1 migration runbook, step 1): push the vault to its
 * private remote when one exists, then tarball the whole vault directory —
 * markdown AND `_index/brain.db`, because salience and the consolidator
 * ledger live only in SQLite (§5.2) and a restore without them silently
 * loses state the markdown cannot reproduce. Restore = untar as vault/,
 * `docker compose up`, `brain doctor` (§3.1 steps 2–4).
 *
 * Since §16 the tarball also carries the tasks store — `tasks/` beside
 * `vault/` — snapshotted with VACUUM INTO first: it is a live WAL database
 * with two writers, and a raw copy of one mid-transaction is torn.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface BackupResult {
  outPath: string;
  /** true/false = push attempted; "no-remote" = local-only vault. */
  pushed: boolean | "no-remote";
  bytes: number;
  /** Whether a tasks store was found beside the vault and included (§16.3). */
  tasks: "included" | "absent";
}

/** A consistent copy of a live SQLite file, WAL and all, into `dest`. */
function snapshotSqlite(src: string, dest: string): void {
  const db = new Database(src, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

export function backupVault(
  vaultPath: string,
  outPath?: string,
  now = new Date(),
  tasksDir = join(dirname(resolve(vaultPath)), "tasks"),
): BackupResult {
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

  const tarArgs = ["-czf", out, "-C", dirname(vault), basename(vault)];
  let tasks: BackupResult["tasks"] = "absent";
  let stage: string | undefined;
  const tasksDb = join(tasksDir, "tasks.db");
  if (existsSync(tasksDb)) {
    stage = mkdtempSync(join(tmpdir(), "brain-backup-"));
    mkdirSync(join(stage, "tasks"));
    snapshotSqlite(tasksDb, join(stage, "tasks", "tasks.db"));
    tarArgs.push("-C", stage, "tasks");
    tasks = "included";
  }
  try {
    const tar = Bun.spawnSync(["tar", ...tarArgs], { stderr: "pipe" });
    if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString().trim()}`);
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
  return { outPath: out, pushed, bytes: Bun.file(out).size, tasks };
}
