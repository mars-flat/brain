# Design Principles

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 1. Direct answer on #5: you were right, and it's simpler than you think

You said *"using a whole embedding model for BM25 is doing too much."* One correction, because it changes the decision in your favour:

**BM25 is not an embedding model.** It's a lexical ranking function — term frequency, inverse document frequency, document-length normalization. Pure arithmetic over a word index. **SQLite's FTS5 extension ships with BM25 built in.** Zero model, zero network, zero extra dependency. It was the *embeddings* alongside it that needed a model, and we're cutting those.

**Can it be grep instead?** It can, but you'd be trading down:

| | grep / ripgrep | SQLite FTS5 + BM25 |
|---|---|---|
| Ranking | none — match or no match | BM25 relevance ordering |
| Tokenization | substring only | word-aware, `porter` stemmer (`deploying` matches `deployment`) |
| Query syntax | regex | `AND`/`OR`/`NEAR`/prefix/phrase |
| Cost at 10⁴ notes | full filesystem scan every query | indexed lookup, sub-millisecond |
| Extra dependency | none | **none** — already in SQLite |
| Snippet extraction | manual | `snippet()` / `highlight()` built in |

FTS5 is strictly better than grep at identical dependency cost. The recommendation is **FTS5 BM25, no model, Phase 1**.

**What we lose without embeddings, and why it mostly doesn't matter here.** Pure lexical search can't match *"where should this run"* to a note titled *"Deployment topology."* Three mitigations, none needing a model:

1. **Traversal does the semantic work.** You only need *one* lexical hit anywhere in the neighbourhood. Hit `constraint/whatsapp-needs-webhook` on the literal word "webhook", and one hop pulls in the deployment decision, the preference that shaped it, and the superseded alternative. This is the strongest argument for a graph over flat RAG: **the edges are hand-built semantic index, and they were free** — the consolidator wrote them when it had full conversational context, which is exactly when relatedness is easiest to judge.
2. **Aliases.** Obsidian has a native `aliases` property. The consolidator populates it with synonyms and phrasings seen in conversation, and they're indexed into FTS. This is a hand-maintained synonym table that costs nothing and is directly editable by you in Obsidian.
3. **Graceful degradation.** If BM25 returns nothing above threshold, `brain.recall` returns `index.md` — the whole catalog as one-line stubs, a few thousand tokens — and lets the model pick seeds itself. A frontier model reading a table of contents is a perfectly good retriever, and it needs no vector math.

**The seam stays open.** `Embedder` is a port with a `NullEmbedder` default. If recall proves insufficient after real use, `EmbedderOpenAI` drops in and hybrid fusion turns on by config. Measure first (§8.5 has the eval harness); add the model only if the numbers demand it.

---

---

[← Index](./README.md)
