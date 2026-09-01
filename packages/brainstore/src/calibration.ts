/**
 * The noise floor (§5.5): what does a BM25 "match" score when the query is
 * topically foreign to THIS vault? A fixed battery of pseudo-queries drawn
 * from an out-of-domain wordlist is run against the index at every rebuild,
 * and the distribution of their top-1 scores is stored in `meta`. Recall
 * standardizes its best seed against it — the constant θ_seed rotted because
 * absolute BM25 magnitudes shift with corpus size and term statistics, and a
 * threshold tuned at 81 nodes is wrong at 1,000.
 *
 * The battery is deterministic: seeded PRNG, versioned, reproducible — the
 * calibration tuple is state, not wall-clock behavior, so §8.3 determinism
 * holds as "same vault snapshot + same calibration state → same pack".
 * Occasional collisions between the wordlist and vault content are expected
 * and harmless: the floor is a distribution, not a single probe.
 */

import type { Database } from "bun:sqlite";

export const PROBE_BATTERY_VERSION = 1;

/** Deliberately scattered domains: chemistry, sailing, anatomy, law, geology,
 *  textiles, astronomy, music theory, meteorology, carpentry. */
const NOISE_WORDS = [
  "isotope", "alkaline", "polymer", "titration", "catalyst", "benzene",
  "spinnaker", "mizzen", "keel", "bowsprit", "halyard", "rudder",
  "ganglion", "myelin", "femur", "platelet", "alveoli", "tendon",
  "chancery", "tort", "probate", "easement", "affidavit", "lien",
  "basalt", "moraine", "stratum", "feldspar", "aquifer", "magma",
  "jacquard", "selvedge", "worsted", "bobbin", "twill", "chenille",
  "quasar", "perihelion", "nebula", "parallax", "albedo", "corona",
  "arpeggio", "cadence", "fugue", "tremolo", "sonata", "clef",
  "cumulonimbus", "isobar", "derecho", "graupel", "monsoon", "squall",
  "mortise", "tenon", "chamfer", "rabbet", "dovetail", "kerf",
] as const;

const PROBE_COUNT = 48;
const WORDS_PER_PROBE = 3;

/** mulberry32 — tiny, seeded, deterministic. Never Math.random (§8.3). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildNoiseProbes(): string[] {
  const rnd = mulberry32(0xb841f);
  const probes: string[] = [];
  for (let i = 0; i < PROBE_COUNT; i++) {
    const words: string[] = [];
    for (let j = 0; j < WORDS_PER_PROBE; j++) {
      words.push(NOISE_WORDS[Math.floor(rnd() * NOISE_WORDS.length)] as string);
    }
    probes.push(words.join(" "));
  }
  return probes;
}

export interface CalibrationInfo {
  /** Mean and stddev of top-1 raw -bm25 across the noise battery. */
  mu: number;
  sigma: number;
  battery: number;
}

export function computeCalibration(seedSearch: (query: string, k: number) => Array<{ raw: number }>): CalibrationInfo {
  const tops = buildNoiseProbes().map((p) => seedSearch(p, 1)[0]?.raw ?? 0);
  const mu = tops.reduce((s, x) => s + x, 0) / tops.length;
  const variance = tops.reduce((s, x) => s + (x - mu) ** 2, 0) / tops.length;
  return { mu, sigma: Math.sqrt(variance), battery: PROBE_BATTERY_VERSION };
}

export function writeCalibration(db: Database, cal: CalibrationInfo): void {
  db.query(
    "INSERT INTO meta (key, value) VALUES ('calibration', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(cal));
}

export function readCalibration(db: Database): CalibrationInfo | null {
  const row = db.query("SELECT value FROM meta WHERE key = 'calibration'").get() as {
    value: string;
  } | null;
  if (!row) return null;
  const cal = JSON.parse(row.value) as CalibrationInfo;
  return cal.battery === PROBE_BATTERY_VERSION ? cal : null;
}
