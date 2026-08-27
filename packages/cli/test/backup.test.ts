/**
 * brain backup (§3.1): the tarball carries everything a restore needs —
 * markdown, the vault's own git history, and the SQLite index whose
 * salience/ledger state markdown cannot reproduce (§5.2) — and the vault
 * pushes to its remote when it has one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupVault } from "../src/backup.ts";

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function mkVault(root: string): string {
  const vault = join(root, "vault");
  mkdirSync(join(vault, "nodes", "concept"), { recursive: true });
  mkdirSync(join(vault, "_index"), { recursive: true });
  writeFileSync(join(vault, "BRAIN.md"), "# schema\n");
  writeFileSync(join(vault, "nodes", "concept", "a-fact.md"), "---\nid: a-fact\n---\n");
  writeFileSync(join(vault, "_index", "brain.db"), "not-really-sqlite");
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "test@example.invalid");
  git(vault, "config", "user.name", "test");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "seed");
  return vault;
}

describe("brain backup (§3.1)", () => {
  test("tarball restores markdown, git history, and the index", () => {
    const root = mkdtempSync(join(tmpdir(), "backup-"));
    const vault = mkVault(root);

    const res = backupVault(vault, join(root, "out.tar.gz"), new Date("2026-08-27T21:00:00Z"));
    expect(res.pushed).toBe("no-remote");
    expect(res.bytes).toBeGreaterThan(0);

    const restore = mkdtempSync(join(tmpdir(), "restore-"));
    const untar = Bun.spawnSync(["tar", "-xzf", res.outPath, "-C", restore]);
    expect(untar.exitCode).toBe(0);
    const restored = join(restore, "vault");
    for (const f of ["BRAIN.md", "nodes/concept/a-fact.md", "_index/brain.db", ".git/HEAD"]) {
      expect(Bun.file(join(restored, f)).size).toBeGreaterThan(0);
    }
    // The restored vault is a working git repo with the same history.
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: restored });
    expect(log.stdout.toString()).toContain("seed");
  });

  test("pushes to origin when the vault has a remote", () => {
    const root = mkdtempSync(join(tmpdir(), "backup-push-"));
    const bare = join(root, "remote.git");
    mkdirSync(bare);
    git(bare, "init", "-q", "--bare");
    const vault = mkVault(root);
    git(vault, "remote", "add", "origin", bare);

    const res = backupVault(vault, join(root, "out.tar.gz"));
    expect(res.pushed).toBe(true);
    const remoteLog = Bun.spawnSync(["git", "log", "--oneline", "--all"], { cwd: bare });
    expect(remoteLog.stdout.toString()).toContain("seed");
  });
});
