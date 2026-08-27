/**
 * Claude Code statusline (§6.4): ambient brain state at the bottom of every
 * session — model · dir · node count · time since the last consolidation.
 * The complement to the SessionEnd toast: the toast says "logged" after the
 * UI is gone; this confirms it the moment the next session starts. Must be
 * fast and never fail loudly — any error degrades to `model · dir`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

interface StatusInput {
  model?: { display_name?: string };
  workspace?: { project_dir?: string; current_dir?: string };
}

function countNodes(vault: string): number {
  const root = join(vault, "nodes");
  if (!existsSync(root)) return 0;
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else if (entry.name.endsWith(".md")) n++;
    }
  }
  return n;
}

function lastIngest(vault: string): string | null {
  const run = Bun.spawnSync(
    ["git", "-C", vault, "log", "-1", "--grep=^consolidate", "--format=%ct"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const epoch = Number(run.stdout?.toString().trim());
  if (!epoch) return null;
  const mins = Math.max(0, Math.round((Date.now() / 1000 - epoch) / 60));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
}

let input: StatusInput = {};
try {
  input = JSON.parse(readFileSync(0, "utf8")) as StatusInput;
} catch {
  // no stdin (e.g. run by hand) — degrade to defaults
}
const model = input.model?.display_name ?? "claude";
const dir = basename(input.workspace?.current_dir ?? process.cwd());
const projectDir = input.workspace?.project_dir ?? process.cwd();
const vault = process.env.BRAIN_VAULT_PATH ?? join(projectDir, "vault");

let line = `${model} · ${dir}`;
try {
  if (existsSync(join(vault, "BRAIN.md"))) {
    const when = lastIngest(vault);
    line += ` · 🧠 ${countNodes(vault)} nodes${when ? ` · last ingest ${when}` : ""}`;
  }
} catch {
  // brain segment is optional; the statusline itself is not
}
console.log(line);
