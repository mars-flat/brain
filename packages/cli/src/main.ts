#!/usr/bin/env bun
/**
 * The brain CLI (§10): init | rebuild | recall | eval | doctor.
 * lint and backup arrive with their phases.
 *
 * BRAIN_VAULT_PATH is required with no default (§9.1) — a missing value
 * fails loudly rather than silently writing memory somewhere git-tracked.
 * Bun auto-loads .env from the working directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BrainStore, loadVault, openDb, rebuild } from "@brain/brainstore";
import { recall } from "@brain/core";
import { formatReport, regressions, runEval, toBaseline } from "./eval.ts";

const USAGE = `brain — graph memory over an Obsidian vault

Usage:
  brain init [--vault <path>]        scaffold a vault + its own git repo
  brain rebuild [--vault <path>]     markdown → _index/brain.db
  brain recall <query> [--vault <path>] [--budget N] [--hops N] [--as-of YYYY-MM-DD]
  brain eval [--vault <path>] [--check] [--update]
  brain doctor [--vault <path>]

The vault path comes from --vault or BRAIN_VAULT_PATH (required, no default).`;

function vaultPath(flag: string | undefined): string {
  const p = flag ?? process.env.BRAIN_VAULT_PATH;
  if (!p) {
    console.error(
      "error: no vault path. Set BRAIN_VAULT_PATH (copy .env.example → .env) or pass --vault (§9.1).",
    );
    process.exit(2);
  }
  return resolve(p);
}

function dbPath(vault: string): string {
  mkdirSync(join(vault, "_index"), { recursive: true });
  return join(vault, "_index", "brain.db");
}

function cmdRebuild(vault: string): void {
  const loaded = loadVault(vault);
  const db = openDb(dbPath(vault));
  const report = rebuild(db, loaded);
  console.log(
    `rebuilt ${join(vault, "_index/brain.db")}: ${report.nodes} nodes, ${report.edges} edges, ` +
      `${report.episodes} episodes, ${report.pins} pins, ${report.aliases} aliases`,
  );
  for (const d of report.danglingEdges) console.warn(`  dangling: ${d.from} —${d.rel}→ ${d.to}`);
  for (const w of report.warnings) console.warn(`  warning: ${w}`);
}

function cmdRecall(
  vault: string,
  query: string,
  opts: { budget?: string; hops?: string; "as-of"?: string },
): void {
  const file = dbPath(vault);
  if (!existsSync(file)) cmdRebuild(vault);
  const store = new BrainStore(openDb(file));
  const out = recall(
    store,
    {
      query,
      budget_tokens: opts.budget ? Number(opts.budget) : undefined,
      hops: opts.hops ? Number(opts.hops) : undefined,
      as_of: opts["as-of"],
    },
    new Date(),
  );
  store.bumpSalience(out.fullTier, new Date().toISOString());
  if (out.result.cold_start) {
    console.log("(cold start — the graph is empty or thin; capture aggressively instead, §5.6)");
    return;
  }
  console.log(out.result.pack === "" ? "(no matching memory)" : out.result.pack);
}

function cmdEval(vault: string, check: boolean, update: boolean): void {
  const report = runEval(vault);
  console.log(formatReport(report));
  const baselineFile = join(vault, "eval-baseline.json");

  if (update) {
    writeFileSync(baselineFile, `${JSON.stringify(toBaseline(report), null, 2)}\n`);
    console.log(`baseline written: ${baselineFile}`);
  }
  if (report.recall < report.recallTarget) {
    console.error(`FAIL: recall ${report.recall.toFixed(4)} below target ${report.recallTarget}`);
    process.exit(1);
  }
  if (check) {
    if (!existsSync(baselineFile)) {
      console.error(`FAIL: no baseline at ${baselineFile} — run brain eval --update`);
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
    const regs = regressions(baseline, report);
    if (regs.length) {
      console.error("FAIL: retrieval regression vs committed baseline:");
      for (const r of regs) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.log("baseline check: no regressions");
  }
}

const BRAIN_MD = `# BRAIN.md — Layer 3 schema

The only hand-written layer (§5.1). See the example vault's BRAIN.md in the
code repo for the full reference. Node types: project · decision · concept ·
entity · person · preference · constraint · artifact · event. Edges:
supersedes · contradicts · caused_by · depends_on · part_of · about ·
example_of · authored_by · derived_from · mentioned_with. Ids are kebab-case
basenames, globally unique; links are quoted bare-basename wikilinks;
salience never appears in frontmatter.
`;

const VAULT_GITIGNORE = `_index/
.obsidian/workspace*.json
.obsidian/cache
.env
.DS_Store
`;

function cmdInit(vault: string): void {
  mkdirSync(vault, { recursive: true });
  for (const dir of ["nodes", "episodes", "pins", "quarantine", "config", ".obsidian"]) {
    mkdirSync(join(vault, dir), { recursive: true });
  }
  const writeIfAbsent = (rel: string, content: string) => {
    const p = join(vault, rel);
    if (!existsSync(p)) writeFileSync(p, content);
  };
  writeIfAbsent("BRAIN.md", BRAIN_MD);
  writeIfAbsent(".gitignore", VAULT_GITIGNORE);
  writeIfAbsent(
    ".obsidian/app.json",
    `${JSON.stringify({ newLinkFormat: "shortest", useMarkdownLinks: false }, null, 2)}\n`,
  );
  if (!existsSync(join(vault, ".git"))) {
    const res = Bun.spawnSync(["git", "init"], { cwd: vault });
    if (res.exitCode !== 0) console.warn("warning: git init failed — do it manually (§9.1)");
  }
  console.log(`vault ready at ${vault} (its own git repo, no remote — §9.1)`);
  console.log("next: set BRAIN_VAULT_PATH in .env, then `brain rebuild`");
  console.log("note: the seed interview (§5.6) arrives with the write path in P2 —");
  console.log("      until then, create your first nodes by hand in Obsidian.");
}

function cmdDoctor(vault: string): void {
  let bad = 0;
  const check = (name: string, ok: boolean, hint = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !hint ? "" : ` — ${hint}`}`);
    if (!ok) bad++;
  };
  check("vault path exists", existsSync(vault), `missing: ${vault}`);
  check(
    "vault is its own git repo",
    existsSync(join(vault, ".git")),
    "run: git init inside the vault (§9.1 layer 1)",
  );
  const loaded = existsSync(vault) ? loadVault(vault) : null;
  check(
    "vault parses clean",
    loaded !== null && loaded.errors.length === 0,
    loaded?.errors.map((e) => `${e.filePath}: ${e.message}`).join("; ") ?? "",
  );
  const db = join(vault, "_index", "brain.db");
  const hasDb = existsSync(db);
  check("index exists", hasDb, "run: brain rebuild");
  if (hasDb && loaded) {
    const store = new BrainStore(openDb(db));
    const counts = store.counts();
    check(
      "index is fresh",
      counts.nodes === loaded.nodes.length,
      `index has ${counts.nodes} nodes, vault has ${loaded.nodes.length} — run: brain rebuild`,
    );
  }
  process.exit(bad === 0 ? 0 : 1);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    vault: { type: "string" },
    budget: { type: "string" },
    hops: { type: "string" },
    "as-of": { type: "string" },
    check: { type: "boolean", default: false },
    update: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 2);
}

switch (command) {
  case "init":
    cmdInit(vaultPath(values.vault));
    break;
  case "rebuild":
    cmdRebuild(vaultPath(values.vault));
    break;
  case "recall": {
    const query = rest.join(" ").trim();
    if (!query) {
      console.error("error: brain recall <query>");
      process.exit(2);
    }
    cmdRecall(vaultPath(values.vault), query, values);
    break;
  }
  case "eval":
    cmdEval(vaultPath(values.vault), values.check, values.update);
    break;
  case "doctor":
    cmdDoctor(vaultPath(values.vault));
    break;
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(2);
}
