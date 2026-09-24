# Testing & CI/CD

> Part of [`architecture/`](./README.md). Section numbers (§N) are stable across files — grep them.

## 8. Test-driven development

### 8.1 Order of work — contracts, then tests, then code

Every phase follows: **write the contract → write failing tests against it → implement until green → refactor.** In a monorepo the discipline holds because `packages/contracts` has no dependencies and is written first, in Phase 0, before any service exists.

### 8.2 Test pyramid

```mermaid
flowchart TB
    E2E["<b>E2E</b> — few, slow<br/>compose stack up, real SQLite,<br/>fake Discord + fake upstream MCP,<br/>full conversation → episode → node"]
    INT["<b>Integration</b> — moderate<br/>real SQLite, real vault fixture,<br/>real OAuth flow vs mock AS,<br/>real MCP transport"]
    CON["<b>Contract</b> — fast, exhaustive<br/>every schema validated both ways;<br/>adapter conformance suites;<br/>golden retrieval packs"]
    UNIT["<b>Unit</b> — many, instant<br/>pure core: traversal, packing,<br/>policy eval, scoring, tiering"]

    UNIT --> CON --> INT --> E2E
```

Core is **pure** — no I/O, no clock, no randomness (`Clock` is a port) — so the entire traversal and packing engine is unit-testable with plain in-memory fixtures and is fully deterministic.

### 8.3 Invariants worth property-testing

These are the claims the system makes. Generate random graphs with `fast-check` and assert they never break:

| Invariant | Statement |
|---|---|
| **Budget** | `tokens(pack) ≤ budget` for every graph, query, and budget |
| **Supersedes** | If any node in a pack is superseded, its terminal successor is also in the pack |
| **Contradicts** | If a node with a `contradicts` edge is included, its counterpart is included and flagged |
| **Pins** | A pinned node renders at full tier whenever included, at any budget |
| **No drop** | With an unconstrained budget, every node traversal reaches appears at *some* tier and the omission list is empty (the tested form, `invariants.test.ts`). Under a real budget the §5.5 downgrade-never-drop rule names what was left out in the pack footer; that half is by construction, not by property test |
| **Determinism** | Same graph + query + budget + clock **+ calibration state** → byte-identical pack |
| **Idempotent consolidation** | Ingesting the same episode twice produces zero new nodes |
| **Reservation** | Concurrent consolidation of overlapping episodes never creates duplicate ids |
| **Round-trip** | `parse(render(node)) == node` for every valid node |
| **Rebuild** | `brain rebuild` from markdown reproduces a **semantically equivalent** index |
| **Basename uniqueness** | No two notes in the vault share a basename (§5.2) |

The rebuild invariant is what lets you trust that markdown is really the source of truth — but note the wording. **SQLite files are not byte-reproducible**: page ordering, freelist reuse, and rowid assignment all vary between runs, so a hash comparison would fail forever and for no useful reason. What `rebuild.test.ts` actually asserts, for two independent rebuilds of the example vault: identical rows in the `nodes`, `edges`, `aliases`, `episodes` and `pins` tables, and byte-identical packs for a fixed set of three queries. FTS content is not dumped (it is derived from `nodes`, which is), and the §5.5 noise floor is not compared by that test — it is recomputed from a versioned deterministic probe battery, and `recall.test.ts` covers that rebuild writes it and recall reads it, so same vault → same floor holds by construction. That's the property you actually care about; the audit of 2026-09-24 narrowed this paragraph to what the test proves.

### 8.4 Specific high-risk test targets

- **SSRF guard** — table-driven over *host and scheme classification*: `http://`, `169.254.169.254`, `127.0.0.1`, `10.0.0.1`, `[::1]` are refused, localhost-over-http only with the explicit dev opt-in (`ssrf.test.ts`). The guard's fetch wrapper also refuses redirects (`redirect: "error"`), caps the body (`maxBytes`) and times out (`timeoutMs`), but those three are not table-tested, and **DNS rebinding is not handled at all** — the check is on the hostname, not the resolved address. *(Status 2026-09-01, still true 2026-09-24: the guard is built and deliberately unwired — no production fetch goes through it. Its intended consumer, the dynamic client-metadata fetch (§4), arrives at P6. Today's outbound fetches are operator-configured or legitimately private-endpoint (the console's IMDS probe), so blanket-wiring would break them.)*
- **`iss` validation (RFC 9207) and PKCE method checks** — these are the *client's* job, not the gateway's: the gateway is a resource server and never sees an authorization response. The clients here are Claude Code (its own code, not tested in this repo) and the console's OIDC client, which always sends `S256` and does not inspect `code_challenge_methods_supported`. **Neither is tested in this repo**; an earlier revision listed both as gateway test targets, which was wrong.
- **Token passthrough** — assert that no inbound token value ever appears in an outbound upstream request. Implemented as a proxy-level assertion in integration tests, so it cannot regress silently.
- **Policy** — every rule with matching and non-matching inputs, plus default-fallthrough.
- **Allowlist** *(P6, not built)* — non-allowlisted Discord ids produce *no* response at all.

### 8.5 Retrieval evaluation

Retrieval quality is a tuning problem, so it needs a measurement harness from day one:

- `examples/vault-example/` — a **synthetic** vault (~80 nodes, no personal data, safe to publish) with a `queries.yaml` of question → expected-node-ids.
- `brain eval` reports three numbers per suite — **recall** (expected nodes present in the pack), **placement** (expected nodes at or above their required tier) and **conflicts** (expected contradiction pairs surfaced) — plus tokens used.
- CI runs it and **fails on regression** against a committed baseline.
- This is also how you settle §1 empirically: if lexical recall plateaus below target, the `Embedder` port earns its keep. If not, you never pay for a model.

**The adversarial paraphrase suite** (added 2026-08-31, after the main suite
saturated at 1.0 — a ceiling-hit eval can't detect the lexical↔semantic gap).
`brain eval --paraphrase` runs `queries-paraphrase.yaml`: questions phrased in
deliberately different vocabulary than their target nodes. Expectations
flagged `paraphrase: true` are **mechanically enforced** to share zero
content-word stems with the target's indexed text — the FTS porter tokenizer
itself is the authority (a single-term MATCH against the target row), because
hand-authored "paraphrases" turn out to overlap invisibly more than half the
time. A flagged target can therefore never be a BM25 seed, so any pack
appearance is graph-traversal recovery. The suite scores the two stages
separately:

- **seed-recall** — expected nodes BM25 found lexically
- **pack-recall / ¶-recall** — expected (and zero-overlap) nodes in the final pack
- **recovery** — unseeded expected nodes rescued by traversal (the §1 bet, as a number)
- **placement** — expected nodes at or above their required tier
- **abstention** — `expect: []` probes with vault-adjacent vocabulary on
  foreign topics answered with silence, not a confident wrong pack

Enforcement violations always fail the run — a suite whose queries lexically
reach their targets measures nothing. CI gates both suites against committed
baselines; the paraphrase baseline records honest misses, and the gate is
no-regression, not perfection. The main suite staying at 1.0 is a hard
constraint on any retrieval tuning (§5.5 parameters); the paraphrase metrics
are what tuning is allowed to move. An abstention probe fails only when
answered **confidently** — a hedged pack is the designed degradation.

**`brain tune`** is how the §5.5 constants earn their values: a coarse-grid
sweep (~1,600 candidates, no model, ~10 minutes) over the abstention
weights/bands, feasible = original suite at 1.0, objective = the paraphrase
aggregates. Deterministic and stable across reruns (ties break toward
current values). The chosen constants are applied to `DEFAULT_RECALL_PARAMS`
by hand with provenance in the comment, and the two baselines gate them
forever after. Rerun it before touching any retrieval constant.

### 8.6 CI/CD

```mermaid
flowchart LR
    PR["Pull request"] --> A["lint · typecheck · dep-cruiser<br/>(no vendor imports in core)"]
    A --> B["example vault is fresh<br/>(regenerate → no diff)"]
    B --> C["unit + contract + integration<br/>bun test: SQLite, mock AS, fake MCP"]
    C --> D["brain eval — both suites<br/>retrieval regression gate"]
    D --> E["bun audit"]
    E --> F["e2e — compose stack smoke"]
    F --> S["scan.yml (parallel):<br/>gitleaks · CodeQL"]
    S --> G{"main?"}
    G -->|no| H["✅ status checks"]
    G -->|yes| I["build multi-arch image<br/>→ GHCR + SBOM + provenance"]
    I --> J["deploy: GitHub OIDC → Entra workload identity<br/><b>zero stored cloud keys</b>"]
    J --> K["SSM run: compose pull && up -d"]
    K --> L["brain doctor smoke test"]
    L -->|fail| M["auto-rollback to previous tag"]
```

*(The diagram is `ci.yml` as it runs on 2026-09-24: there is no coverage threshold and no image scanner — an earlier revision drew a coverage gate and a Trivy stage that were never built; dependency risk is covered by `bun audit` at high severity plus Dependabot, §9.3.)*

**GitHub Actions OIDC → Entra ID workload identity federation.** No client secret and no service-principal password anywhere in the repo or in Actions secrets — `azure/login` exchanges the workflow's OIDC token for a short-lived credential. The federated credential is pinned to `repo:mars-flat/brain:ref:refs/heads/main`, so a fork or a PR branch cannot assume it. In a public repo this is not a nicety — it removes the most valuable thing an attacker could hope to find.

Deployment itself is `az vm run-command invoke` against the VM (the Azure analog of SSM run) executing `docker compose pull && up -d`. No inbound port, no SSH key in CI.

*Implemented at P5 (2026-08-27), `deploy.yml` + `deploy/vm/deploy.sh`:* the deploying identity is an Entra app registration whose `AZURE_CLIENT_ID`/`TENANT_ID`/`SUBSCRIPTION_ID` are repo **variables**, not secrets — there is nothing secret to store. Its role grant (Virtual Machine Contributor, which is what `run-command` needs) is configured in the Azure portal and is not recorded anywhere in this repo — the private `azure/azure-config.md` documents the cost-guard identity, not this one. The image job publishes multi-arch (amd64 for CI, arm64 for the VM) to GHCR with SBOM + max provenance on every main push. Two mechanics worth knowing: `run-command` does not propagate script exit codes, so the on-VM script speaks a `DEPLOY-OK` / `ROLLED-BACK` / `ROLLBACK-FAILED` marker contract the workflow greps; and while the VM doesn't exist yet the deploy job skips cleanly, so the pipeline was landed and green before provisioning. The rollback target is simply the previous `TAG=` in the VM's compose `.env`; `docker compose up --wait` (gateway healthcheck) plus `brain doctor` are the smoke gate — preceded by a vault ownership normalize + index rebuild, because root-context ops (deploys, ad-hoc pulls) otherwise strand root-owned files the uid-1000 consolidator can't write (`deploy/vm/vault-pull.sh` is the safe ad-hoc path). **Manual redeploy is `workflow_dispatch` on `main` only**: the federated credential is pinned to `refs/heads/main`, so a dispatch from any other ref fails at `azure/login`; the image is tagged with the dispatched sha, but the on-VM script does `git reset --hard origin/main` before running `deploy.sh`, so what redeploys is main's HEAD — not an arbitrary commit. (The header comment in `deploy.yml` still says "any commit"; it is the comment that is wrong.)

**Branch protection:** all four checks (`checks`, `repo-split-guard`, `gitleaks`, `codeql`) are **Required** on `main`; no force-push or deletion (admins included); secret-scanning push protection and private vulnerability reporting on. **Work lands via branch → PR → auto-merge once pre-merge CI is green** (owner directive, post-P2) — `gh pr merge --auto --rebase`, rebase-merge so the per-commit narrative survives, branch deleted on merge. Direct pushes of unchecked SHAs to `main` are refused as a consequence. Two deliberate softenings remain: no required review (single maintainer — a review requirement would deadlock self-merges) and no required signed commits (the implementing agent's commits are unsigned).

---

---

[← Index](./README.md)
