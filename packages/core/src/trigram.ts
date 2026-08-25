/**
 * Character-trigram similarity (§5.7): the third and last entity-resolution
 * signal — deterministic, testable, no model.
 */

export function trigrams(s: string): Set<string> {
  const norm = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!norm) return new Set();
  const padded = `  ${norm}  `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}
