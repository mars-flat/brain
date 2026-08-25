# Model Routing & Cost

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

### 5.8 Model routing and cost

**Model: `gpt-5.6-luna` (OpenAI).** Everything the design depends on is supported — structured outputs with JSON Schema (the consolidator's hard requirement, §5.7), function calling, prompt caching, and a 1.05M context window. The provider swap cost nothing architecturally because `ModelClient` was already a port.

| Job | Effort | Transport | Effective rate (in / out per MTok) |
|---|---|---|---|
| Conversation (P6 Discord) | `max` | streaming, prompt-cached | $0.20 / $1.20 · cached in **$0.02** |
| Consolidation extraction | **`medium`** | **Batch API** | **$0.10 / $0.60** |
| Lint proposals | **`low`** | **Batch API** | same |
| Summary regeneration | **`low`** | **Batch API** | same |

Behind a `ModelClient` port with `chat` / `structured` / `batch` methods, so provider swaps stay config.

#### Reasoning effort is now the dominant cost variable — not the model

This is the single biggest change from the Anthropic plan, and it inverts where the tuning attention goes.

Luna's input is extraordinarily cheap ($0.20/MTok, or **$0.02 cached — a 90% discount**), but **reasoning tokens bill as output at $1.20/MTok — six times the input rate.** Effort levels run `none · low · medium (default) · high · xhigh · max`, and each step up generates more reasoning. So the cost of a call is set almost entirely by how hard you told it to think, not by how much context you gave it.

You said `max`. **Keep it for conversation, drop it for the background jobs.** Extraction against a fixed JSON schema and mechanical lint checks are not reasoning-limited tasks — `max` there buys nothing and multiplies the bill ~4×:

```
episode ≈ 15k input + output varies entirely by effort
  medium:  15k × $0.10/M  +   2k × $0.60/M  ≈ $0.0027   → 300/mo ≈ $0.81
  max:     15k × $0.10/M  +  16k × $0.60/M  ≈ $0.0111   → 300/mo ≈ $3.33
```

Both are cheap in absolute terms — which is the real headline. **Set effort per job in config, not globally**, and let §8.5's eval harness tell you whether `medium` extraction is actually worse than `max` before paying for it.

#### Watch the 272k threshold

Prompts over **272K input tokens** bill at **2× input and 1.5× output — applied to the entire request**, not just the overage. It's a cliff, not a ramp.

Nothing in the design goes near it: recall packs are capped at 4k (§5.5) and episodes run ~15k. The one way to hit it is a monster Claude Code session transcript. **Guard it in the consolidator:** reject or chunk any episode over ~200k tokens rather than letting one runaway session quietly cost 2× on a request that was already the month's largest.

#### What it actually costs

| Phase | Workload | Estimate |
|---|---|---|
| **P2–P5** (brain only) | ~10 episodes/day + nightly lint, batched, `medium`/`low` | **~$1–4/month** |
| **P6 onward** (Discord live) | + ~20 messages/day, ~3 calls each, prompt-cached, `max` | **+$7–25/month** |

Roughly **4–5× cheaper than the Anthropic plan** at equivalent settings — and the input caching is what does most of it. The stable prefix (system prompt, node schema, edge vocabulary, and within a conversation the context pack) reads at $0.02/MTok, so context is nearly free and reasoning is what you pay for.

Three things drive the total, in order: **effort level per job**, **how many conversations you have**, and **whether background work is batched**. Note what's absent: **nothing scales with vault size.** Retrieval is capped at the recall budget, so cost per turn stays flat whether the graph holds 100 nodes or 100,000. That property is why this stays affordable as the brain grows.

**Set a usage limit in the OpenAI platform dashboard before P2.** Azure budgets cannot see OpenAI spend (§3.2) — it is a completely separate bill with a completely separate control.

**Everything background goes through the Batch API — it is a flat 50% discount and the workload is already shaped for it.** Consolidation is debounced ten minutes and lint runs nightly (§5.7, §5.9); neither is latency-sensitive, which is exactly the Batch API's trade (most batches finish within an hour, 24h ceiling). Structured outputs, prompt caching, and tools all work inside a batch, so the consolidator's schema-validated extraction needs no redesign.

One consequence worth knowing: batched consolidation means a conversation's nodes may not exist for up to an hour, so two conversations close together won't see each other's extractions. The nightly full pass reconciles. For a personal system this is a non-issue; if it ever bites, that specific episode can go through the sync path.

**Prompt caching on the extraction prompt.** The consolidator sends the same system prompt, node schema, and edge vocabulary with every episode — a stable prefix of a few thousand tokens. Cache it: reads bill at ~0.1×, writes at 1.25×, so it pays for itself from the second episode onward. Keep the episode itself *after* the cache breakpoint (§5.7 — caching is prefix-matched, so volatile content last).

#### Why not drive the consolidator off a chat subscription

The recurring cost dodge — pipe episodes through a CLI in a cron job, billed to a chat subscription instead of the API. It usually runs. It is still the wrong tool, for reasons that are technical before they are contractual:

| | |
|---|---|
| **No schema-constrained output** | The consolidator depends on JSON Schema validated at the API layer, so a malformed extraction is *retried* rather than written. A chat CLI returns text; you'd hand-parse and hope, and §5.7's "quarantine on low confidence" degrades into "quarantine on parse failure" |
| **No Batch API** | The 50% discount doesn't exist on that path |
| **Quota contention** | Subscription limits are shared with your interactive use and roll on an opaque window. 300 consolidations a month compete with your own work, in both directions |
| **Auth breaks unattended** | OAuth refresh tokens hard-expire, and on a headless VM you cannot re-run an interactive login. The job dies silently weeks later — the worst failure shape for a memory system, since you lose episodes without noticing |
| **Terms** | Subscriptions cover interactive use; an unattended backend service is what the API is for. Read the current terms yourself, but don't architect around the answer being yes |

At Luna's rates the whole argument is moot anyway: **P2–P5 costs about a dollar a month.** There is nothing left to dodge.

---

[← Index](./README.md)
