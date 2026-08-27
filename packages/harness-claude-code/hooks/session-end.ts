/**
 * Claude Code SessionEnd hook (§6.4 Mode A): transcript → canonical envelope
 * → `brain ingest --now`. Delivery is the local CLI, not the POST in §6.4 —
 * the brain has no HTTP surface until P5; this script is where that swap
 * lands. Every failure path exits 0: memory capture must never break the
 * user's session, and a missed episode is recoverable (the transcript stays
 * on disk) while a broken SessionEnd is not.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodeIdFor, normalizeEpisode } from "../src/normalize.ts";

/** Below either floor the session is too thin to be worth an extraction call. */
const MIN_USER_TURNS = 2;
const MIN_USER_CHARS = Number(process.env.BRAIN_SESSION_MIN_CHARS ?? "200");

function skip(reason: string): never {
  console.error(`brain session-end: ${reason} — not ingested`);
  process.exit(0);
}

function alreadyIngested(vault: string, episodeId: string): boolean {
  const root = join(vault, "episodes");
  if (!existsSync(root)) return false;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(".json") && readFileSync(path, "utf8").includes(episodeId))
        return true;
    }
  }
  return false;
}

/**
 * SessionEnd fires after the session UI is gone, so a system toast is the
 * only "logged to memory" bar the user can actually see. Best-effort:
 * macOS only, and a missing/failing osascript is silently ignored.
 */
function notify(consolidateOut: string): void {
  if (process.platform !== "darwin") return;
  const nodes = consolidateOut.match(/\+(\d+) nodes/)?.[1];
  const quarantined = consolidateOut.match(/(\d+) quarantined/)?.[1];
  let detail = nodes === undefined ? "episode stored" : `+${nodes} nodes`;
  if (quarantined !== undefined && quarantined !== "0") detail += `, ${quarantined} quarantined`;
  const message = `session logged — ${detail}`;
  Bun.spawnSync(
    ["osascript", "-e", `display notification ${JSON.stringify(message)} with title "brain"`],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
}

function main(): void {
  let input: { session_id?: string; transcript_path?: string };
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as typeof input;
  } catch {
    skip("unreadable hook input");
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const vault = process.env.BRAIN_VAULT_PATH ?? join(projectDir, "vault");
  // Clean clones have no vault (§9.1) — the hook must be inert there.
  if (!existsSync(join(vault, "BRAIN.md"))) skip(`no vault at ${vault}`);
  if (!input.session_id || !input.transcript_path || !existsSync(input.transcript_path))
    skip("no transcript");
  if (alreadyIngested(vault, episodeIdFor(input.session_id))) skip("episode already in the vault");

  let envelope: ReturnType<typeof normalizeEpisode>;
  try {
    envelope = normalizeEpisode({
      sessionId: input.session_id,
      transcriptJsonl: readFileSync(input.transcript_path, "utf8"),
    });
  } catch (err) {
    skip(`normalize failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const userTurns = envelope.turns.filter((t) => t.kind === "message" && t.role === "user");
  const userChars = userTurns.reduce(
    (n, t) => n + (t.kind === "message" ? t.content.length : 0),
    0,
  );
  if (userTurns.length < MIN_USER_TURNS || userChars < MIN_USER_CHARS)
    skip(`session too small (${userTurns.length} user turns, ${userChars} chars)`);

  const file = join(mkdtempSync(join(tmpdir(), "brain-episode-")), "episode.json");
  writeFileSync(file, JSON.stringify(envelope));
  // cwd = project dir so bun auto-loads .env (OPENAI_API_KEY → LLM extractor).
  const run = Bun.spawnSync(
    [
      "bun",
      join(projectDir, "packages/cli/src/main.ts"),
      "ingest",
      file,
      "--now",
      "--vault",
      vault,
    ],
    { cwd: projectDir, stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  );
  const out = run.stdout?.toString() ?? "";
  if (out) process.stderr.write(out);
  if (run.exitCode !== 0) console.error(`brain session-end: ingest exited ${run.exitCode}`);
  else notify(out);
  process.exit(0);
}

main();
