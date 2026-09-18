/**
 * Reconcile one Google account's Gmail filters with a declarative spec
 * (packages/mcp-google/src/filter-spec.ts) — labels created, filters
 * created, optional backfill of existing mail. Runs on the laptop against
 * Google directly, the way scripts/google-auth.ts does: the refresh token
 * comes from the vault's encrypted secret store, the client credentials
 * from .env. Nothing is deleted, ever — unmanaged filters are listed for
 * the owner to handle through mail_delete_filter.
 *
 *   bun scripts/gmail-filters.ts plan  <account> <spec.yaml>
 *   bun scripts/gmail-filters.ts apply <account> <spec.yaml> [--backfill [--since 45d]]
 *
 * The spec for a real account lives in the private vault
 * (config/gmail-filters/<account>.yaml); examples/vault-example carries the
 * synthetic shape. Needs the gmail.settings.basic scope — re-consent an
 * account minted before 2026-09-18 first.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileSecretStore } from "../adapters/secrets-file/src/index.ts";
import {
  backfillQuery,
  parseFilterSpec,
  planFilters,
  resolveLabelIds,
} from "../packages/mcp-google/src/filter-spec.ts";
import {
  mailBatchModify,
  mailCreateFilter,
  mailCreateLabel,
  mailListFilters,
  mailListIds,
  mailListLabels,
} from "../packages/mcp-google/src/gmail.ts";
import { GoogleClient } from "../packages/mcp-google/src/google.ts";

const [cmd, account, specPath, ...rest] = process.argv.slice(2);
const usage = () => {
  console.error(
    "usage: bun scripts/gmail-filters.ts plan|apply <account> <spec.yaml> [--backfill [--since 45d]]",
  );
  process.exit(2);
};
if (!cmd || !account || !specPath || !["plan", "apply"].includes(cmd)) usage();
const backfill = rest.includes("--backfill");
const sinceIdx = rest.indexOf("--since");
const since = sinceIdx >= 0 ? (rest[sinceIdx + 1] ?? "") : "45d";
if (!/^\d+[dmy]$/.test(since)) {
  console.error(`--since wants a Gmail window like 45d, got "${since}"`);
  process.exit(2);
}

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const VAULT = process.env.BRAIN_VAULT_PATH;
if (!CLIENT_ID || !CLIENT_SECRET || !VAULT) {
  console.error(
    "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / BRAIN_VAULT_PATH missing (see .env.example)",
  );
  process.exit(2);
}
const storePath = join(VAULT, "secrets", "store.json");
const keyPath = join(VAULT, "secrets", "master.key");
if (!existsSync(storePath) || !existsSync(keyPath)) {
  // FileSecretStore would mint a fresh key + empty store at a wrong path —
  // refuse rather than quietly create a second secret store.
  console.error(`no secret store at ${storePath} — is BRAIN_VAULT_PATH the vault?`);
  process.exit(2);
}
const refreshToken = await new FileSecretStore(storePath, keyPath).get(`google/${account}`);
if (!refreshToken) {
  console.error(`no secret google/${account} — consent first: bun scripts/google-auth.ts`);
  process.exit(2);
}

const spec = parseFilterSpec(Bun.YAML.parse(readFileSync(specPath as string, "utf8")));
if (spec.account !== account) {
  console.error(`spec is for account "${spec.account}", not "${account}"`);
  process.exit(2);
}

const g = new GoogleClient({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  refreshToken,
});

let { labels } = await mailListLabels(g);
const { filters: existing } = await mailListFilters(g);
let plan = planFilters(spec, labels, existing);

const describe = (a: { add_label_ids?: string[]; remove_label_ids?: string[] }) => {
  const parts: string[] = [];
  if (a.add_label_ids?.length) parts.push(`+${a.add_label_ids.join(",")}`);
  if (a.remove_label_ids?.length) parts.push(`-${a.remove_label_ids.join(",")}`);
  return parts.join(" ");
};

console.log(`account ${account}: ${labels.length} labels, ${existing.length} filters`);
console.log(
  `labels to create: ${plan.createLabels.length ? plan.createLabels.join(", ") : "none"}`,
);
for (const f of plan.filters)
  console.log(
    `${f.existing ? "exists " : "CREATE "} ${f.rule.name.padEnd(24)} ${describe(f.action).padEnd(28)} ${f.criteria.query}`,
  );
if (plan.unmanaged.length) {
  console.log(`unmanaged filters (not in the spec; left alone):`);
  for (const f of plan.unmanaged)
    console.log(`  ${f.id}  ${describe(f.action)}  ${JSON.stringify(f.criteria)}`);
}

if (cmd === "plan") process.exit(0);

for (const name of plan.createLabels) {
  const l = await mailCreateLabel(g, name);
  console.log(`created label ${l.name} (${l.id})`);
}
if (plan.createLabels.length) {
  labels = (await mailListLabels(g)).labels;
  plan = resolveLabelIds(plan, labels);
}

let created = 0;
for (const f of plan.filters) {
  if (f.existing) continue;
  const made = await mailCreateFilter(g, { criteria: f.criteria, action: f.action });
  created += 1;
  console.log(`created filter ${made.id} for "${f.rule.name}"`);
}
console.log(`filters created: ${created}`);

if (!backfill) process.exit(0);

// Backfill: filters only touch mail that arrives after they exist; existing
// matches get the same actions here. Id-only listing (no metadata fan-out,
// §W2 concurrency note) then batchModify in slabs of 500.
let touched = 0;
for (const f of plan.filters) {
  const query = backfillQuery(f.rule, since);
  let page: string | undefined;
  let n = 0;
  do {
    const res = await mailListIds(g, { query, max_results: 500, page_token: page });
    if (res.ids.length) {
      await mailBatchModify(g, {
        message_ids: res.ids,
        add_label_ids: f.action.add_label_ids,
        remove_label_ids: f.action.remove_label_ids,
      });
      n += res.ids.length;
    }
    page = res.next_page_token;
  } while (page);
  touched += n;
  console.log(`backfill ${f.rule.name.padEnd(24)} ${String(n).padStart(5)} messages`);
}
console.log(`FILTERS-OK ${account} created=${created} backfilled=${touched} since=${since}`);
