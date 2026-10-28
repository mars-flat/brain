/**
 * One tick (§16.8): for every Gmail upstream the gateway reports up, read
 * what is new in the inbox and the lanes, triage headers in one model call,
 * extract tasks from the survivors' bodies, propose them, and — organize
 * on — file the mail per the disposition table. Everything goes through
 * the gateway; the only writes are `tasks.propose` and `mail_modify_labels`.
 *
 * Order matters for safety: the marker label is applied LAST, after every
 * propose for the batch returned, so a tick that dies halfway leaves its
 * remainder unmarked for the next tick, and the store's message-key net
 * absorbs any repeat.
 */

import type { ModelClient } from "@brain/contracts";
import {
  ARCHIVED_LABEL,
  assertLabelChange,
  CONFIDENCE_FLOOR,
  type Disposition,
  type ExtractItem,
  extractRequest,
  type Header,
  labelBatches,
  looksAutomated,
  MARKER_LABEL,
  MAX_MESSAGES_PER_ACCOUNT,
  PAGE_SIZE,
  parseExtract,
  parseTriage,
  proposeArgs,
  searchQuery,
  TRIAGE_BATCH,
  type TriageVerdict,
  triageRequest,
} from "./core.ts";
import type { ToolCaller } from "./gateway.ts";

export interface AccountConfig {
  /** Extra labels to scan besides the inbox (owner, Q9). */
  lanes?: string[];
  /** Prompt text: "this is the university account". */
  hint?: string;
}

export interface TickOptions {
  gateway: ToolCaller;
  model: ModelClient;
  modelName: string;
  tz: string;
  /** Gmail newer_than for the search: "2d" normally, "3d" on the first run. */
  window: string;
  /** Write nothing: no propose, no labels. */
  dryRun: boolean;
  /** Apply lanes and archive (PR D). Off = proposals and the marker only. */
  organize: boolean;
  capPerAccount: number;
  accounts?: Record<string, AccountConfig>;
  /** Only these servers (e.g. from --account); default every g-* that is up. */
  only?: string[];
  log: (line: string) => void;
  now?: () => number;
}

export interface AccountSummary {
  account: string;
  scanned: number;
  pages: number;
  triagedIn: number;
  extracted: number;
  created: number;
  folded: number;
  duplicate: number;
  matchedExisting: number;
  droppedLow: number;
  capped: number;
  marked: number;
  /** Left unmarked on purpose (cap or an unexplained propose result) — re-read next tick. */
  unmarked: number;
  labeled: number;
  archived: number;
  kept: number;
  warnings: string[];
}

interface Label {
  id: string;
  name: string;
  type?: string;
}

const emptySummary = (account: string): AccountSummary => ({
  account,
  scanned: 0,
  pages: 0,
  triagedIn: 0,
  extracted: 0,
  created: 0,
  folded: 0,
  duplicate: 0,
  matchedExisting: 0,
  droppedLow: 0,
  capped: 0,
  marked: 0,
  unmarked: 0,
  labeled: 0,
  archived: 0,
  kept: 0,
  warnings: [],
});

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

async function existingContext(gw: ToolCaller) {
  const list = (await gw.call("tasks.list", { status: "open" })) as {
    tasks?: Array<{ id: string; title: string }>;
  };
  const props = (await gw.call("tasks.proposals", { status: "pending" })) as {
    proposals?: Array<{ id: string; title: string; entity: string }>;
  };
  return {
    openTasks: (list.tasks ?? []).map((t) => ({ id: t.id, title: t.title })),
    pending: (props.proposals ?? []).map((p) => ({ id: p.id, title: p.title, entity: p.entity })),
  };
}

async function searchAll(
  gw: ToolCaller,
  account: string,
  query: string,
  summary: AccountSummary,
): Promise<Header[]> {
  const out: Header[] = [];
  let pageToken: string | undefined;
  do {
    const page = (await gw.call(`${account}.mail_search`, {
      query,
      max_results: PAGE_SIZE,
      ...(pageToken ? { page_token: pageToken } : {}),
    })) as { results?: Header[]; next_page_token?: string };
    summary.pages++;
    out.push(...asArray<Header>(page.results));
    pageToken = page.next_page_token;
    if (out.length >= MAX_MESSAGES_PER_ACCOUNT) {
      summary.warnings.push(`stopped at ${MAX_MESSAGES_PER_ACCOUNT} messages; the rest next tick`);
      break;
    }
  } while (pageToken);
  return out;
}

export async function runTick(opts: TickOptions): Promise<AccountSummary[]> {
  const { gateway: gw, log } = opts;
  const now = opts.now ?? Date.now;
  const servers = await gw.servers();
  const accounts = servers
    .filter((s) => s.name.startsWith("g-") && s.status === "up")
    .map((s) => s.name)
    .filter((n) => !opts.only || opts.only.includes(n));
  if (accounts.length === 0) log("no g-* upstream is up; nothing to do");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: opts.tz }).format(new Date(now()));
  const summaries: AccountSummary[] = [];

  for (const account of accounts) {
    const summary = emptySummary(account);
    summaries.push(summary);
    const cfg = opts.accounts?.[account] ?? {};
    try {
      // Per account, so account two's prompt knows what account one just proposed.
      const existing = await existingContext(gw);
      // The account's real label tree: lanes come from here, never from the model.
      const labelList = (await gw.call(`${account}.mail_list_labels`, {})) as { labels?: Label[] };
      const labels = asArray<Label>(labelList.labels);
      const byName = new Map(labels.map((l) => [l.name, l.id]));
      const userLanes = labels
        .filter((l) => l.type !== "system" && !l.name.startsWith("brain/"))
        .map((l) => l.name);
      const marker = byName.get(MARKER_LABEL) ?? null;
      const archived = byName.get(ARCHIVED_LABEL) ?? null;
      if (!marker)
        summary.warnings.push(
          `no "${MARKER_LABEL}" label: nothing will be marked, so every tick re-scans the window (create the label once)`,
        );

      const query = searchQuery({
        lanes: cfg.lanes ?? [],
        marker: marker ? MARKER_LABEL : null,
        window: opts.window,
      });
      const headers = await searchAll(gw, account, query, summary);
      summary.scanned = headers.length;
      if (headers.length === 0) {
        log(`${account}: nothing new`);
        continue;
      }

      // Stage 1 — triage, headers only.
      const ctx = { account, hint: cfg.hint, lanes: userLanes, today };
      const verdicts: TriageVerdict[] = [];
      for (let i = 0; i < headers.length; i += TRIAGE_BATCH) {
        const batch = headers.slice(i, i + TRIAGE_BATCH);
        const res = await opts.model.complete(triageRequest(opts.modelName, batch, ctx));
        const vs = parseTriage(res.parsed, batch, userLanes);
        for (const v of vs) verdicts.push({ ...v, i: v.i + i });
      }
      // A human must never be filed: the mechanical signal overrides the model.
      for (const v of verdicts) {
        const h = headers[v.i] as Header;
        if (v.sender === "automated" && !looksAutomated(h)) {
          v.sender = "unsure";
          v.disposition = "keep";
        }
      }

      // Stage 2 — extract from the survivors, propose, remember what each message needs.
      const changes: Array<{ id: string; add: string[]; remove: string[] }> = [];
      const markOnly = (id: string) =>
        changes.push({ id, add: marker ? [marker] : [], remove: [] });
      let createdHere = 0;
      for (const v of verdicts) {
        const h = headers[v.i] as Header;
        let disposition: Disposition = v.disposition;
        // A message whose item hit the cap (or an unexplained propose result)
        // stays unmarked so the next tick reads it again: the cap is "the rest
        // next tick", never a silent drop.
        let leaveUnmarked = false;
        if (v.kind !== "none" && v.actionable) {
          summary.triagedIn++;
          const msg = (await gw.call(`${account}.mail_get_message`, { id: h.id })) as {
            body?: { text?: string };
          };
          const body = msg.body?.text ?? "";
          const res = await opts.model.complete(
            extractRequest(opts.modelName, h, body, ctx, existing),
          );
          const items = parseExtract(res.parsed);
          summary.extracted += items.length;
          for (const item of items) {
            const outcome = await proposeOne(opts, gw, account, h, item, summary, createdHere);
            if (outcome === "created") createdHere++;
            if (outcome === "created" || outcome === "folded") disposition = "keep";
            if (outcome === "capped" || outcome === "unexplained") leaveUnmarked = true;
          }
          if (items.length === 0) summary.kept++;
        }
        if (leaveUnmarked) {
          summary.unmarked++;
          continue;
        }
        // Filing (PR D's organize, gated): only automated mail, only the allowed labels.
        const add: string[] = marker ? [marker] : [];
        const remove: string[] = [];
        if (opts.organize && v.sender === "automated") {
          const laneId = v.lane ? byName.get(v.lane) : undefined;
          if (laneId) add.push(laneId);
          const mayArchive = disposition === "archive" && !(h.label_ids ?? []).includes("STARRED");
          if (mayArchive && (h.label_ids ?? []).includes("INBOX")) {
            remove.push("INBOX");
            if (archived) add.push(archived);
          }
        }
        if (add.length || remove.length) changes.push({ id: h.id, add, remove });
        else markOnly(h.id);
      }

      // Stage 3 — labels, batched, hard-limited, last.
      const allowedAdd = new Set(labels.filter((l) => l.type !== "system").map((l) => l.id));
      const batches = labelBatches(changes);
      for (const b of batches) {
        assertLabelChange(b, allowedAdd);
        if (opts.dryRun) continue;
        await gw.call(`${account}.mail_modify_labels`, b);
        if (b.add_label_ids.includes(marker ?? "")) summary.marked += b.message_ids.length;
        if (b.remove_label_ids.includes("INBOX")) summary.archived += b.message_ids.length;
        if (b.add_label_ids.some((l) => l !== marker && l !== archived))
          summary.labeled += b.message_ids.length;
      }
      if (opts.dryRun)
        summary.warnings.push(
          `dry run: ${batches.reduce((n, b) => n + b.message_ids.length, 0)} label changes not applied`,
        );
    } catch (err) {
      summary.warnings.push(`stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(summaryLine(summary));
  }
  return summaries;
}

type ProposeOutcome =
  | "created"
  | "folded"
  | "duplicate"
  | "unexplained"
  | "matched"
  | "dropped"
  | "capped";

async function proposeOne(
  opts: TickOptions,
  gw: ToolCaller,
  account: string,
  h: Header,
  item: ExtractItem,
  summary: AccountSummary,
  createdSoFar: number,
): Promise<ProposeOutcome> {
  if (item.matches_existing) {
    summary.matchedExisting++;
    return "matched";
  }
  if (item.confidence < CONFIDENCE_FLOOR) {
    summary.droppedLow++;
    return "dropped";
  }
  if (createdSoFar >= opts.capPerAccount) {
    summary.capped++;
    return "capped";
  }
  const args = proposeArgs(account, h, item, opts.tz);
  if (opts.dryRun) {
    opts.log(`${account}: would propose "${item.title}" (${item.kind} · ${item.entity})`);
    summary.created++;
    return "created";
  }
  const res = (await gw.call("tasks.propose", args)) as {
    outcome?: string;
    reason?: string;
  };
  switch (res.outcome) {
    case "created":
      summary.created++;
      return "created";
    case "folded":
      summary.folded++;
      return "folded";
    case "duplicate":
      summary.duplicate++;
      return "duplicate";
    default:
      summary.warnings.push(`propose returned ${JSON.stringify(res).slice(0, 120)}`);
      return "unexplained";
  }
}

export function summaryLine(s: AccountSummary): string {
  const parts = [
    `scanned ${s.scanned}`,
    `pages ${s.pages}`,
    `triaged-in ${s.triagedIn}`,
    `extracted ${s.extracted}`,
    `created ${s.created}`,
    `folded ${s.folded}`,
    `duplicate ${s.duplicate}`,
    `matched-existing ${s.matchedExisting}`,
    `dropped-low ${s.droppedLow}`,
    `capped ${s.capped}`,
    `marked ${s.marked}`,
    `unmarked ${s.unmarked}`,
    `labeled ${s.labeled}`,
    `archived ${s.archived}`,
  ];
  const warn = s.warnings.length ? ` · ${s.warnings.join(" · ")}` : "";
  return `${s.account}: ${parts.join(" · ")}${warn}`;
}
