# BRAIN.md — Layer 3 schema

The only hand-written layer (§5.1). Everything the consolidator generates must
conform to this file; lint enforces it nightly.

## Node types

`project` · `decision` · `concept` · `entity` · `person` · `preference` ·
`constraint` · `artifact` · `event`

A node is a markdown note under `nodes/<type>/`. The folder is organization
only — **identity is the basename**, which must equal the frontmatter `id`,
be kebab-case, and be unique across the whole vault. Links are bare basenames
(`[[caddy-reverse-proxy]]`, never `[[decision/caddy-reverse-proxy]]`), quoted
when they appear in frontmatter list properties.

`summary` must stand alone at ~100–150 tokens — it is the middle render tier.
`salience` never appears in frontmatter; it lives only in the derived index.

## Edge vocabulary (closed)

| Relation | Meaning | Decay δ |
|---|---|---|
| `supersedes` | replaces an older node | 1.0 — **always followed to the terminal node, ignoring budget** |
| `contradicts` | conflicts with | 1.0 — **counterpart always pulled in and labeled** |
| `caused_by` | exists because of | 0.85 |
| `depends_on` | requires | 0.80 |
| `part_of` | component of | 0.75 |
| `about` | topically concerns | 0.60 |
| `example_of` | instance of | 0.60 |
| `authored_by` | attribution | 0.50 |
| `derived_from` | provenance to episode | 0.40 |
| `mentioned_with` | weak co-occurrence | 0.30 — pruned first under pressure |

One direction on disk; inverses are derived into the index at rebuild.
`sources:` frontmatter is the normal way provenance is written — the indexer
materializes each entry as a `derived_from` edge to the episode.

## Traversal defaults

Seed top-k 8 · max 3 hops · budget 4000 tokens · tiers full ≈600t /
summary ≈140t / stub ≈15t · score = Σ paths (bm25 · Π δ) · salience^0.3 ·
recency^0.2 · recency half-life 180 days · ties break (score DESC, id ASC).

## Lint expectations

Basename uniqueness is a hard error. Contradicting `active` nodes must carry
`contradicts` edges. Superseded nodes keep `status: superseded`. The
`## Links` body block mirrors frontmatter edges and is regenerated on drift.
Near-duplicates (trigram similarity > 0.85) get merge proposals, not silent
merges.
