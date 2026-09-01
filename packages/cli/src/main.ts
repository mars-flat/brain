#!/usr/bin/env bun
/**
 * The brain CLI (§10): init | rebuild | recall | eval | doctor | ingest |
 * consolidate | note | pin | lint | secret. backup arrives at P5.
 *
 * BRAIN_VAULT_PATH is required with no default (§9.1) — a missing value
 * fails loudly rather than silently writing memory somewhere git-tracked.
 * Bun auto-loads .env from the working directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BrainStore, loadVault, openDb, rebuild } from "@brain/brainstore";
import {
  type Extractor,
  ensureConsolidatorTables,
  ingestEpisode,
  LlmExtractor,
  MarkerExtractor,
  type QueuedEpisode,
  type RunReport,
  runBatchCycle,
  runConsolidator,
  ulid,
  writePin,
} from "@brain/consolidator";
import type { EpisodeEnvelope } from "@brain/contracts";
import { recall } from "@brain/core";
import { OpenAiModelClient } from "@brain/model-openai";
import { SqliteQueue } from "@brain/queue-sqlite";
import { FileSecretStore } from "@brain/secrets-file";
import { backupVault } from "./backup.ts";
import { formatReport, regressions, runEval, toBaseline } from "./eval.ts";
import { formatTuneReport, runTune } from "./tune.ts";
import {
  formatParaReport,
  paraRegressions,
  runParaphraseEval,
  toParaBaseline,
} from "./eval-paraphrase.ts";
import { runLint } from "./lint-cmd.ts";

const USAGE = `brain — graph memory over an Obsidian vault

Usage:
  brain init [--vault <path>]        scaffold a vault + its own git repo
  brain rebuild [--vault <path>]     markdown → _index/brain.db
  brain recall <query> [--budget N] [--hops N] [--as-of YYYY-MM-DD]
  brain expand <id…> [--tier full|summary|stub]  promote nodes; bumps salience (§5.5)
  brain eval [--check] [--update] [--paraphrase]   --paraphrase = adversarial suite (§8.5)
  brain tune [--out report.json]     sweep abstention params against both suites (§8.5)
  brain doctor
  brain ingest <envelope.json> [--now]           validate, store, enqueue (§5.7)
  brain consolidate [--extractor marker|openai]  run the single writer once
  brain consolidate --batch                      one Batch-API cadence tick (§5.8)
  brain note <text…> [--type <t>]                capture directly (enqueue + run)
  brain pin <node-id> --correction "…" --reason "…"
  brain lint [--apply]                           proposals; --apply = mechanical fixes
  brain secret set|list|rm <name> [value]        south-bound upstream credentials (§4.3)
  brain backup [--out <tar.gz>]                  push vault remote + tarball (§3.1 step 1)

All commands take --vault <path>; default comes from BRAIN_VAULT_PATH
(required, no default). Extraction uses OpenAI when OPENAI_API_KEY is set,
else the deterministic @node marker grammar.`;

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
  if (out.result.cold_start) {
    console.log("(cold start — the graph is empty or thin; capture aggressively instead, §5.6)");
    return;
  }
  console.log(out.result.pack === "" ? "(no matching memory)" : out.result.pack);
}

function cmdExpand(vault: string, ids: string[], tier: "full" | "summary" | "stub"): void {
  const file = dbPath(vault);
  if (!existsSync(file)) cmdRebuild(vault);
  const store = new BrainStore(openDb(file));
  const graph = store.loadGraph();
  const bodies = tier === "full" ? store.getBodies(ids) : new Map<string, string>();
  const found: string[] = [];
  for (const id of ids) {
    const n = graph.nodes.get(id);
    if (!n) {
      console.log(`(unknown node: ${id})`);
      continue;
    }
    found.push(id);
    const head = `${n.type}/${n.id} — ${n.title}`;
    if (tier === "stub") console.log(head);
    else if (tier === "summary") console.log(`${head}\n${n.summary}`);
    else console.log(`${head}\n${n.summary}\n\n${bodies.get(id) ?? ""}`.trimEnd());
  }
  // Expand is the demand signal — salience accrues here, not on recall (§5.5).
  store.bumpSalience(found, new Date().toISOString());
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

function cmdEvalParaphrase(vault: string, check: boolean, update: boolean): void {
  const report = runParaphraseEval(vault);
  console.log(formatParaReport(report));
  const baselineFile = join(vault, "eval-paraphrase-baseline.json");

  // A suite whose queries lexically reach their targets measures nothing —
  // enforcement failures are always fatal, baseline or not.
  if (report.violations.length) {
    console.error(`FAIL: ${report.violations.length} zero-overlap enforcement violation(s)`);
    process.exit(1);
  }
  if (update) {
    writeFileSync(baselineFile, `${JSON.stringify(toParaBaseline(report), null, 2)}\n`);
    console.log(`baseline written: ${baselineFile}`);
  }
  if (check) {
    if (!existsSync(baselineFile)) {
      console.error(`FAIL: no baseline at ${baselineFile} — run brain eval --paraphrase --update`);
      process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
    const regs = paraRegressions(baseline, report);
    if (regs.length) {
      console.error("FAIL: paraphrase-suite regression vs committed baseline:");
      for (const r of regs) console.error(`  - ${r}`);
      process.exit(1);
    }
    console.log("paraphrase baseline check: no regressions");
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
log.md
index.md
lint-proposals.md
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
  console.log('seed it: `brain note \'@node person "Your Name" id:me summary:"…"\'` —');
  console.log("ten nodes on day one is what makes traversal work (§5.6).");
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

function pickExtractor(flag: string | undefined): Extractor {
  const key = process.env.OPENAI_API_KEY;
  if (flag === "marker") return new MarkerExtractor();
  if (flag === "openai" || (flag === undefined && key)) {
    if (!key) {
      console.error("error: --extractor openai needs OPENAI_API_KEY");
      process.exit(2);
    }
    return new LlmExtractor(new OpenAiModelClient(key));
  }
  console.log("(no OPENAI_API_KEY — using the deterministic @node marker extractor)");
  return new MarkerExtractor();
}

function printRunReport(report: RunReport): void {
  if (report.locked) {
    console.log("another consolidator holds the run lock — try again shortly (§5.7)");
    return;
  }
  for (const p of report.processed) {
    console.log(
      `✓ ${p.basename}: +${p.newNodes.length} nodes [${p.newNodes.join(", ")}], ` +
        `+${p.edgeAdditions} edges, ${p.statusChanges} superseded, ${p.quarantined} quarantined`,
    );
    for (const w of p.warnings) console.warn(`  warning: ${w}`);
  }
  for (const s of report.skipped) console.log(`· ${s} already consolidated`);
  for (const w of report.waiting) console.log(`… ${w} waiting on batch extraction (§5.8)`);
  for (const r of report.retried) console.log(`↻ ${r.episodeId} will retry: ${r.reason}`);
  for (const d of report.deadLettered)
    console.error(`✗ ${d.episodeId} dead-lettered to quarantine/: ${d.reason}`);
  if (
    !report.processed.length &&
    !report.skipped.length &&
    !report.waiting.length &&
    !report.retried.length &&
    !report.deadLettered.length
  )
    console.log("queue empty — nothing to consolidate");
}

async function cmdConsolidate(vault: string, extractorFlag: string | undefined): Promise<void> {
  const db = openDb(dbPath(vault));
  ensureConsolidatorTables(db);
  const report = await runConsolidator({
    vaultPath: vault,
    db,
    extractor: pickExtractor(extractorFlag),
  });
  printRunReport(report);
}

/** One cadence tick of batched consolidation (§12 Q4): collect → promote → drain → stage. */
async function cmdConsolidateBatch(vault: string): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error("error: brain consolidate --batch needs OPENAI_API_KEY");
    process.exit(2);
  }
  const db = openDb(dbPath(vault));
  ensureConsolidatorTables(db);
  const cycle = await runBatchCycle({ vaultPath: vault, db, model: new OpenAiModelClient(key) });
  for (const c of cycle.collected)
    console.log(
      c.error
        ? `⇣ batch ${c.batchId} FAILED whole (episodes stay pending): ${c.error}`
        : `⇣ batch ${c.batchId} collected: ${c.ok} ok, ${c.failed} failed`,
    );
  for (const p of cycle.promoted)
    console.log(
      p.error
        ? `⇡ batch create for upload ${p.uploadId} failed (staged, retrying next tick): ${p.error}`
        : `⇡ created batch ${p.batchId} from upload ${p.uploadId}`,
    );
  printRunReport(cycle.run);
  if (cycle.uploadId)
    console.log(
      `⇡ staged upload ${cycle.uploadId} (${cycle.staged.length} episodes) — batch next tick`,
    );
}

async function cmdIngest(
  vault: string,
  file: string,
  runNow: boolean,
  extractorFlag: string | undefined,
): Promise<void> {
  const db = openDb(dbPath(vault));
  ensureConsolidatorTables(db);
  const queue = new SqliteQueue<QueuedEpisode>(db);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const basenames = new Set(loadVault(vault).episodes.map((e) => e.basename));
  const result = await ingestEpisode(vault, queue, raw, basenames);
  console.log(`ingested ${result.episodeId} as episodes/…/${result.basename}.md — queued`);
  if (runNow) await cmdConsolidate(vault, extractorFlag);
}

async function cmdNote(
  vault: string,
  text: string,
  type: string | undefined,
  extractorFlag: string | undefined,
): Promise<void> {
  // brain.note never writes the graph directly (§5.10) — it enqueues a tiny
  // high-trust episode and, for CLI ergonomics, runs the writer immediately.
  const now = new Date();
  const content =
    text.trimStart().startsWith("@node") || !type
      ? text
      : `@node ${type} ${JSON.stringify(text.slice(0, 80))} summary:${JSON.stringify(text)}`;
  const episode: EpisodeEnvelope = {
    schema_version: 1,
    episode_id: `ep_${ulid(now)}`,
    principal: "owner",
    surface: "cli",
    harness: "brain-cli",
    trust: "high",
    started_at: now.toISOString().replace(/\.\d+Z$/, "Z"),
    ended_at: now.toISOString().replace(/\.\d+Z$/, "Z"),
    turns: [
      {
        seq: 0,
        kind: "message",
        role: "user",
        content,
        ts: now.toISOString().replace(/\.\d+Z$/, "Z"),
      },
    ],
    labels: ["note"],
  };
  const db = openDb(dbPath(vault));
  ensureConsolidatorTables(db);
  const queue = new SqliteQueue<QueuedEpisode>(db);
  const basenames = new Set(loadVault(vault).episodes.map((e) => e.basename));
  await ingestEpisode(vault, queue, episode, basenames);
  await cmdConsolidate(vault, extractorFlag);
}

function cmdPin(vault: string, nodeId: string, correction: string, reason: string): void {
  const db = openDb(dbPath(vault));
  rebuild(db, loadVault(vault));
  const store = new BrainStore(db);
  if (!store.nodeFile(nodeId)) {
    console.error(`error: no node with id "${nodeId}"`);
    process.exit(2);
  }
  const pin = writePin(vault, nodeId, correction, reason, new Date());
  rebuild(db, loadVault(vault));
  console.log(`pinned ${nodeId} (${pin.pinId}) — the correction now rides every full render`);
}

async function cmdSecret(vault: string, rest: string[]): Promise<void> {
  const store = new FileSecretStore(
    join(vault, "secrets", "store.json"),
    join(vault, "secrets", "master.key"),
  );
  const [sub, name] = rest;
  switch (sub) {
    case "set": {
      if (!name) {
        console.error("error: brain secret set <name> [value]  (value read from stdin if omitted)");
        process.exit(2);
      }
      const value = rest[2] ?? (await Bun.stdin.text()).trim();
      if (!value) {
        console.error("error: empty secret value");
        process.exit(2);
      }
      await store.set(name, value);
      console.log(
        `secret "${name}" stored (envelope-encrypted). Reference it as \${secret:${name}} in config/servers.yaml.`,
      );
      break;
    }
    case "list":
      for (const k of await store.list(name ?? "")) console.log(k);
      break;
    case "rm":
      if (!name) {
        console.error("error: brain secret rm <name>");
        process.exit(2);
      }
      await store.delete(name);
      console.log(`secret "${name}" removed`);
      break;
    default:
      console.error("usage: brain secret set|list|rm …");
      process.exit(2);
  }
}

function cmdLint(vault: string, apply: boolean): void {
  const { findings, proposalPath, applied } = runLint(vault, apply, new Date());
  const errors = findings.filter((f) => f.severity === "error").length;
  console.log(
    `${findings.length} finding(s) (${errors} error) → ${proposalPath} — review in Obsidian`,
  );
  for (const f of findings.slice(0, 12)) {
    console.log(`  ${f.severity === "error" ? "✗" : "·"} ${f.check}: ${f.subject} — ${f.detail}`);
  }
  if (findings.length > 12) console.log(`  … ${findings.length - 12} more in the proposal file`);
  for (const a of applied) console.log(`  applied: ${a}`);
  if (errors && !apply) process.exit(1);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    vault: { type: "string" },
    budget: { type: "string" },
    hops: { type: "string" },
    "as-of": { type: "string" },
    check: { type: "boolean", default: false },
    paraphrase: { type: "boolean", default: false },
    update: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    now: { type: "boolean", default: false },
    batch: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    extractor: { type: "string" },
    out: { type: "string" },
    type: { type: "string" },
    tier: { type: "string" },
    correction: { type: "string" },
    reason: { type: "string" },
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
  case "expand": {
    if (!rest.length) {
      console.error("error: brain expand <id…>");
      process.exit(2);
    }
    const tier = (values.tier ?? "full") as "full" | "summary" | "stub";
    cmdExpand(vaultPath(values.vault), rest, tier);
    break;
  }
  case "eval":
    if (values.paraphrase) cmdEvalParaphrase(vaultPath(values.vault), values.check, values.update);
    else cmdEval(vaultPath(values.vault), values.check, values.update);
    break;
  case "tune": {
    const vault = vaultPath(values.vault);
    let lastPct = -1;
    const report = runTune(vault, (done, total) => {
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct > lastPct) {
        lastPct = pct;
        process.stderr.write(`  sweep ${pct}% (${done}/${total})\n`);
      }
    });
    console.log(formatTuneReport(report));
    if (values.out) {
      writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`report written: ${values.out}`);
    }
    break;
  }
  case "doctor":
    cmdDoctor(vaultPath(values.vault));
    break;
  case "ingest": {
    const file = rest[0];
    if (!file) {
      console.error("error: brain ingest <envelope.json>");
      process.exit(2);
    }
    await cmdIngest(vaultPath(values.vault), file, values.now, values.extractor);
    break;
  }
  case "consolidate":
    if (values.batch) await cmdConsolidateBatch(vaultPath(values.vault));
    else await cmdConsolidate(vaultPath(values.vault), values.extractor);
    break;
  case "note": {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error("error: brain note <text>");
      process.exit(2);
    }
    await cmdNote(vaultPath(values.vault), text, values.type, values.extractor);
    break;
  }
  case "pin": {
    const nodeId = rest[0];
    if (!nodeId || !values.correction || !values.reason) {
      console.error('error: brain pin <node-id> --correction "…" --reason "…"');
      process.exit(2);
    }
    cmdPin(vaultPath(values.vault), nodeId, values.correction, values.reason);
    break;
  }
  case "backup": {
    const res = backupVault(vaultPath(values.vault), values.out);
    const pushMsg =
      res.pushed === "no-remote"
        ? "no remote configured"
        : res.pushed
          ? "pushed to origin"
          : "PUSH FAILED — tarball still written";
    console.log(`backup: ${res.outPath} (${(res.bytes / 1024).toFixed(0)} KiB) — ${pushMsg}`);
    if (res.pushed === false) process.exit(1);
    break;
  }
  case "lint":
    cmdLint(vaultPath(values.vault), values.apply);
    break;
  case "secret":
    await cmdSecret(vaultPath(values.vault), rest);
    break;
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(2);
}
