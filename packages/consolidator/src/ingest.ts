/**
 * Ingestion (§5.7): validate the envelope, refuse untrusted (§6.5 — never),
 * guard the 272k pricing cliff (§5.8), write the episode to Layer 0 (both
 * the readable markdown and the canonical JSON envelope, so Layer 1 can be
 * regenerated if the schema improves), and enqueue for the single writer.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Queue } from "@brain/contracts";
import { type EpisodeEnvelope, validateEpisode } from "@brain/contracts";
import { estimateTokens, slugify } from "@brain/core";
import { renderTranscript } from "./extract.ts";

/** §5.8: reject anything that could go near the 272k threshold. */
const MAX_EPISODE_TOKENS = 200_000;

export interface IngestResult {
  episodeId: string;
  basename: string;
  queued: boolean;
}

export class IngestError extends Error {}

export function episodeBasename(episode: EpisodeEnvelope, taken: Set<string>): string {
  const date = episode.started_at.slice(0, 10);
  const firstUser = episode.turns.find((t) => t.kind === "message" && t.role === "user");
  const slugSource =
    episode.labels?.[0] ??
    (firstUser?.kind === "message" ? firstUser.content.split(/\s+/).slice(0, 5).join(" ") : "") ??
    "episode";
  const base = `${date}-${slugify(slugSource) || "episode"}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

export function renderEpisodeFile(episode: EpisodeEnvelope): string {
  return [
    "---",
    `episode_id: ${episode.episode_id}`,
    `started_at: ${episode.started_at}`,
    `ended_at: ${episode.ended_at}`,
    `surface: ${episode.surface}`,
    `harness: ${episode.harness}`,
    `trust: ${episode.trust}`,
    `labels: [${(episode.labels ?? []).join(", ")}]`,
    "---",
    "",
    renderTranscript(episode),
    "",
  ].join("\n");
}

export async function ingestEpisode(
  vaultPath: string,
  queue: Queue<{ episodeId: string; basename: string }>,
  raw: unknown,
  existingBasenames: Set<string>,
): Promise<IngestResult> {
  const verdict = validateEpisode(raw);
  if (!verdict.ok)
    throw new IngestError(`invalid episode envelope:\n  ${verdict.errors.join("\n  ")}`);
  const episode = verdict.value;

  if (episode.trust === "untrusted")
    throw new IngestError("untrusted episodes never write memory (§6.5)");
  const tokens = estimateTokens(renderTranscript(episode));
  if (tokens > MAX_EPISODE_TOKENS)
    throw new IngestError(
      `episode ≈${tokens} tokens exceeds the ${MAX_EPISODE_TOKENS} guard (§5.8 pricing cliff) — chunk it upstream`,
    );

  const [y, m] = [episode.started_at.slice(0, 4), episode.started_at.slice(5, 7)];
  const dir = join(vaultPath, "episodes", y, m);
  mkdirSync(dir, { recursive: true });

  const basename = episodeBasename(episode, existingBasenames);
  const mdPath = join(dir, `${basename}.md`);
  if (!existsSync(mdPath)) {
    writeFileSync(mdPath, renderEpisodeFile(episode));
    writeFileSync(join(dir, `${basename}.json`), `${JSON.stringify(episode, null, 2)}\n`);
  }

  await queue.enqueue({ episodeId: episode.episode_id, basename });
  return { episodeId: episode.episode_id, basename, queued: true };
}
