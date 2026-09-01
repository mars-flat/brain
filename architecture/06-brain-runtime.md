# The Brain — Retrieval & Writes

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

### 5.5 Retrieval — seed, traverse, pack (no model anywhere)

```mermaid
flowchart TB
    Q["Query + token budget B"]

    subgraph Seed["1 — SEED (FTS5 BM25, no model)"]
        F1["match title + aliases + tags + summary"]
        F2["porter stemmer, terms OR-joined"]
        F3["top-k entry nodes, k≈8"]
        F4["abstention score A(q):<br/>confident · hedged · abstain-to-catalog"]
    end

    subgraph Trav["2 — TRAVERSE"]
        B1["weighted BFS, max 3 hops"]
        B2["score(n) = Σ_paths seed(s)·Π δ_rel·Π damp<br/>× salience^0.3 × recency^0.2"]
        B3["hard rules: supersedes to terminal,<br/>pull contradicts, attach pins"]
        B4["prune: marginal &lt; θ_prune, frontier &gt; 200"]
    end

    subgraph Pack["3 — PACK"]
        K1["sort by score / token-cost"]
        K2["greedy tier assignment<br/>full ≈600t → summary ≈140t → stub ≈15t"]
        K3["frontier nodes become stubs<br/>with expand handles"]
    end

    Q --> F1 --> F2 --> F3 --> F4 --> B1 --> B2 --> B3 --> B4 --> K1 --> K2 --> K3 --> OUT["Context pack ≤ B"]
```

**Tiering is the whole trick.** A node is never dropped for scoring low — it is **downgraded**. The top-3 **eligible** nodes render full, ranks 4–12 as summaries, 13–60 as one-line stubs. Every stub carries its id, so the model can call `brain.expand(["decision/x"])` mid-conversation and promote exactly what it needs.

**Full slots are query-anchored** (added 2026-08-31, from the paraphrase
suite's findings): a node may hold a full slot only if it was a seed, within
1 hop of one, or pinned — hubs that qualify purely via long-path
accumulation share a single full slot. Ranking decides who is *in* the pack;
eligibility decides who gets the expensive tiers. Once every eligible node
is full and budget still remains, the restriction lifts (scarcity is the
thing being protected), so a five-node graph with a 4k budget still renders
everything full.

Three details pinned at P1 (the implementation is in `packages/core`): the rank bands are **minimums** — leftover budget upgrades nodes in rank order, so a five-node graph with a 4k budget renders everything full; when even all-stubs exceeds the budget, the tail is omitted **explicitly** (counted in the pack footer with the first few ids; the full list rides in `result.omitted`), never silently — the footer listing is capped because an unbounded one made omission move a node's cost into the footer instead of freeing it, emptying packs on long-id vaults at small budgets (fixed 2026-09-01); and token costs are `ceil(chars/4)` — deterministic and dependency-free, which is what the budget invariant actually needs, since §5.5's tier sizes were always approximations.

The agent always knows the *shape* of what it knows at ~15 tokens per fact, and pays full price only for what it reads. This is the same progressive-disclosure pattern as `tools.search → tools.describe`, applied to memory instead of capability.

```
score(n) = Σ over paths s→n [ bm25_norm(s) · Π_{e∈path} δ_rel(e) · Π_{m∈path} damp(m) ]
           · salience(n)^0.3 · recency(n)^0.2

damp(m) = (1 + degree(m) / medianDegree)^-α        α = 0.5
```

**The damp term** (added 2026-08-31): Σ-over-paths is a funnel — every path
in a dense graph flows through the high-degree nodes, so the same hubs
outscored query-relevant nodes on *every* query (measured: one hub took a
full slot on 2 of 3 unrelated real-vault queries). Each node a path arrives
at damps the mass by its connectivity relative to the vault's own median
degree — the PageRank intuition applied to the funnel. Degree stats are
computed per-recall from the graph slice (pure, cheap, nothing stored);
"hub" means degree ≥ max(4, p95) *of this vault*, so nothing rots as the
graph grows. α = 0 recovers undamped scoring exactly. The draft's companion
idea — capping Σ at one path per seed — is **not built**: damping alone
moved the eval numbers, and the cap would have killed legitimate
multi-path corroboration along with the funnel.

`salience` is a usage counter with exponential decay, bumped when the model **`brain.expand`s a node** — explicit demand — never when a node merely renders. It lives **only in SQLite**, never in the note (§5.2). `recency = exp(-age_days / 180)`. The exponents are deliberately gentle: relevance dominates, recency breaks ties. **All of these are starting values to tune against the eval set in §8.5.** *(Changed 2026-08-31: the original bump-on-full-render was a rich-get-richer loop with no relevance signal in it — hub nodes rendered full because of salience earned by rendering full, which the paraphrase suite caught as hubs squatting the full tier on unrelated queries. Recall is now a pure read.)*

One seed-stage correction from P1 stands: **prefix queries were dropped** — porter stems the index, so a prefix star on a full word (`training*`) *misses* its own stem (`train`); plain OR-joined terms with porter on both sides is strictly better.

**The abstention gate** (2026-08-31; supersedes the P1 scalar θ_seed). The
adversarial suite (§8.5) showed θ_seed's bands overlap in both directions —
obscurely-phrased real questions topped out at 4.2–4.6 raw (starved) while a
topically-foreign probe hit 5.5 (confidently answered). BM25 encodes term
rarity, not topical relevance; no constant separates the two. The gate is now
a four-feature score, pure arithmetic over the index and graph:

```
A(q) = 0.5·z + 1.0·coverage + 0.5·cohesion − 0.5·hub_frac
```

- **z** — best seed standardized against the **noise floor**: at every
  rebuild, a versioned battery of 48 seeded-PRNG probe queries from an
  out-of-domain wordlist runs against the fresh index, and the distribution
  (μ, σ) of their top-1 scores lands in the `meta` table. "How far above
  *this vault's* coincidence level," not an absolute number that rots as the
  corpus grows.
- **coverage** — fraction of the query's content terms matching anything
  (garbage rides one rare word; real queries land several).
- **cohesion** — fraction of seed pairs within 2 hops of each other (a real
  topic seeds one linked neighborhood). Weak in dense small vaults, as
  predicted; the tune left it at half weight.
- **hub_frac** — seeds that are hubs (degree ≥ max(4, p95)) match
  everything a little, and count against.

Three bands instead of answer-or-empty: **A ≥ 2.5 confident** (normal tiered
pack, `confidence: "high"`); **2.0 ≤ A < 2.5 hedged** — the pack flattens to
summaries/stubs behind a `LOW CONFIDENCE` banner, because a weak lexical
match must not be dressed up as a ranked answer; **A < 2.0 abstain** — the
pack is the **vault catalog** as one-line stubs (budget-capped, §5.6-style
explicit), never a fabricated neighborhood. Explicit caller `seeds` bypass
the gate; young graphs (<50 nodes) and pre-calibration indexes fall back to
the legacy θ. Weights come from `brain tune` (§8.5), which holds the
original suite at 1.0 as a hard constraint — after tuning, the paraphrase
suite scores 1.0 on ¶-recall, recovery, placement, and abstention.

**Ties break by node id, always.** FTS5 returns equal-scoring rows in rowid order, and rowids change when the index is rebuilt — so an unstable sort would make identical queries return different packs before and after `brain rebuild`. Every ranking step sorts by `(score DESC, id ASC)`. This is what makes the determinism invariant in §8.3 actually hold.

```
── CONTEXT PACK (3,847 / 4,000 tokens · 41 nodes · 3 hops) ──
[FULL]    decision/gateway-runs-on-ec2         612t
[FULL]    constraint/discord-needs-no-ingress  488t
[SUMMARY] preference/minimal-ops-surface       142t
[SUMMARY] concept/ports-and-adapters           156t
  ... 9 more summaries
[STUB]    decision/run-everything-locally  ⚠ superseded by gateway-runs-on-ec2
[STUB]    person/... · project/... · 26 more
⚠ CONFLICT: concept/single-binary contradicts decision/split-edge-and-core
→ expand any stub with brain.expand(ids)
```

### 5.6 Cold start

You're starting from an empty vault, so the first weeks matter more than they would with bulk ingest.

- `brain.recall` on an empty or thin graph returns `{ pack: "", nodes: [], cold_start: true }` — an explicit signal, never a fabricated context.
- The system prompt instructs: on `cold_start`, skip recall and lean on `brain.note` to capture aggressively.
- **`brain init` seeds a small scaffold**: `project/`, `preference/`, and `person/me` nodes from a short interview. Ten nodes on day one is the difference between traversal working and traversal having nothing to traverse.
- The consolidator runs with a **lower extraction threshold for the first 200 nodes**, then tightens. Early over-capture is cheap; lint merges duplicates later.

### 5.7 Write path — consolidation

Chats **never** write to the graph synchronously.

```mermaid
stateDiagram-v2
    [*] --> Queued: harness POSTs episode envelope
    Queued --> Extracting: single-writer consolidator
    Extracting --> Resolving: cheap model extracts candidate<br/>facts, decisions, entities, preferences
    Resolving --> Reserving: match to existing nodes<br/>(FTS5 + alias table + trigram similarity)
    Reserving --> Merging: ATOMIC node-id reservation
    Merging --> Linting: write nodes + typed edges
    Linting --> Committed: check pins, contradictions, schema
    Committed --> [*]: git commit, append log.md, reindex

    Extracting --> Failed: model error
    Failed --> Queued: backoff, max 3
    Merging --> Conflict: two candidates claim one id
    Conflict --> Merging: retry under lock
    Linting --> Quarantine: pin violation or low confidence
    Quarantine --> [*]: surfaced for review in Obsidian
```

Four load-bearing properties, each fixing a documented llm-wiki failure mode:

1. **Single writer + atomic reservation.** Parallel ingests forking one concept into three near-duplicate pages is the most-reported problem. A queue with one consumer plus a reservation table removes the race by construction.
2. **Pins survive.** If a change contradicts a pin on the target node → quarantine, never overwrite.
3. **Quarantine, not silent acceptance.** Low-confidence extractions and anything `provenance: untrusted` land in `quarantine/` — which is a folder in your Obsidian vault, so review is just reading notes and dragging them out.
4. **Git commit per run.** Full audit trail; `git revert` is a working undo for memory.

**Entity resolution without embeddings** uses three cheap signals in order: exact id/alias match → FTS5 BM25 on title+aliases → trigram (Jaccard on character 3-grams) over titles. Ambiguity above a threshold goes to quarantine rather than guessing. Deterministic, testable, no model.

**Episode envelope** — the single integration point for memory:

```json
{
  "schema_version": 1,
  "episode_id": "ep_01J...",
  "principal": "owner",
  "surface": "discord",
  "harness": "agent-runtime",
  "trust": "medium",
  "started_at": "2026-08-24T20:00:00Z",
  "ended_at": "2026-08-24T20:42:00Z",
  "turns": [
    { "seq": 0, "kind": "message", "role": "user", "content": "...", "ts": "..." },
    { "seq": 1, "kind": "tool_call", "urn": "github.issues.create",
      "args": {}, "result_digest": "sha256:...", "ts": "..." },
    { "seq": 2, "kind": "message", "role": "assistant", "content": "...", "ts": "..." }
  ],
  "labels": ["architecture"]
}
```

Two corrections from revision 2, both of which would have hurt at implementation time:

- **`schema_version` is mandatory.** This is the one contract every future harness writes against; without a version field, changing it later means silently misparsing old episodes.
- **One ordered `turns` array, not parallel `messages` and `tool_calls` arrays.** Real transcripts interleave, and extraction quality depends heavily on *what happened in what order* — "he asked X, the tool returned Y, then he decided Z" is the shape most decisions have. Two parallel arrays throw that ordering away and make the consolidator guess.

P0 pinned the details in `packages/contracts/episode.schema.json`: `seq` must be **strictly increasing but may have gaps** (a harness that filters turns keeps original positions), `episode_id` is `ep_` + a 26-char Crockford ULID, `result_digest` is `sha256:<64 hex>`, and message `role` is `user | assistant | system`.

Any harness that can POST this gets the brain. That's the whole contract.

**Cadence:** debounced ~10 minutes after a conversation goes idle, plus a nightly pass. Not per-message — per-message extraction produces a graph full of noise.

Three P2 implementation notes. Extraction is an interface with two implementations: the LLM path (structured outputs, `medium` effort) and a **deterministic `@node` marker grammar** — `@node <type> "Title" summary:"…" edge:rel=target` — which powers the tests, works offline, and gives `brain note` a precise hand-capture syntax. The consolidator stores each episode **twice**: readable markdown plus the canonical JSON envelope, so Layer 1 really is regenerable if the schema improves (§5.1). And extraction runs **synchronously**, not via the Batch API yet — batch is a flat cost discount with a 24h ceiling (§5.8), which is the wrong trade until the P5 deploy makes consolidation a background cadence; the port hides the switch.

### 5.9 Lint

Nightly. Output is a **proposal file in the vault**, not a mutation — you approve with `brain lint --apply`.

| Check | Action |
|---|---|
| Contradictions | Two `active` nodes asserting incompatible things → add `contradicts`, flag |
| Stale | `active`, unreferenced 90d, newer node covers it → propose `supersedes` |
| Orphans | No edges → propose links or merge |
| Near-duplicates | Trigram similarity > 0.85 on title+summary → propose merge |
| Broken links | Wikilink to nonexistent note → repair or drop |
| Property/body drift | `## Links` block disagrees with frontmatter → regenerate |
| Pin violations | Generated content contradicts a pin → revert, escalate |
| Summary drift | `summary` no longer reflects body → regenerate |
| Salience decay | Apply exponential decay across all nodes |

**Blocking is mandatory, or lint does not terminate.** Contradiction and near-duplicate checks are pairwise, and all-pairs at 10⁴ nodes is 5×10⁷ comparisons — infeasible for trigrams and absurd for an LLM pass. Every pairwise check runs only within a **candidate block**:

- same `type` **and** at least one shared `tag`, **or**
- within 2 hops of each other in the graph, **or**
- top-20 FTS5 matches for the node's own title

…and only for nodes **touched since the last lint run**, tracked by a watermark. That turns a quadratic sweep into a few thousand comparisons per night. Full sweeps are available as `brain lint --full` for occasional use, and are expected to take minutes, not seconds.

P2 shipped the mechanical checks (broken links, orphans, near-duplicates/stale with blocking, links-mirror drift, missing pin targets, salience decay) with `--apply` limited to the mechanical fixes — drift re-render, broken-link drops, decay. The two model-assisted checks (semantic contradictions, summary drift) and the watermark wait until the nightly LLM pass exists; every pass is currently a full pass, which is milliseconds at 10² nodes.

### 5.10 Brain MCP contract

```
brain.recall(query, budget_tokens=4000, hops=3, types?, seeds?, as_of?)
  -> { pack, nodes:[{id,tier,score}], conflicts, expand_handles, cold_start,
       confidence: "high" | "low" | "none" }   # graded gate, §5.5 (2026-08-31)
brain.expand(ids[], tier)            -> upgraded renders
brain.neighbors(id, rels?, depth=1)  -> subgraph edge list
brain.note(text, links?, type?)      -> { pending_id }   # enqueues, never writes directly
brain.pin(node_id, correction, reason) -> { pin_id }     # survives all future generation
brain.timeline(query?, from?, to?)   -> episodes, chronological
brain.trace(node_id)                 -> provenance chain to source episodes
brain.ingest(episode)                -> { episode_id, processed, retried }   # P5, §6.4
```

`brain.trace` gives every claim a citation back to the episode it came from.

**`brain.ingest` (added at P5)** is the remote form of `brain ingest --now`: a harness delivers a full §5.7 envelope over MCP instead of running the CLI on the box. Same path — validate, trust-gate, store, enqueue, run the single writer — and redelivery is idempotent via the ledger, so a hook can retry blindly. It is `brain:write`-scoped and, uniquely among writes, policy-**allowed** (not confirmed) for the `http`/`cli` surfaces: SessionEnd is headless, §6.5 already grants high-trust surfaces direct memory writes, and the tool revalidates every envelope itself.

**`as_of` ships in two stages** — revision 2 understated this. True git time-travel means checking out the vault at a timestamp and building a throwaway index for that tree: minutes of work per query, and a second index path to maintain.

- **P1 — cheap version.** Filter the *current* graph to nodes with `created <= as_of`, and treat `supersedes` edges created after `as_of` as not yet existing. Answers "what did I know in June" correctly for anything additive. Milliseconds, no extra machinery.
- **Later, optional — true version.** `git worktree` at the nearest commit before `as_of`, build a temp index, query, discard. Only worth building if the cheap version proves misleading in practice.

The cheap version is wrong only where a node was *edited in place* rather than superseded — which the lint rules already discourage, since superseding is the documented way to change a decision.

---

[← Index](./README.md)
