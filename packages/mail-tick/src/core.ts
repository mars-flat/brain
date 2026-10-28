/**
 * The mail tick's pure core (§16.8): the rubric, the two strict JSON
 * schemas, request builders, result parsers, the search query, and the
 * mapping from an extracted item to `tasks.propose` arguments. No I/O —
 * tick.ts does the calling, so everything here is table-testable.
 *
 * Mail is untrusted content (§4.6). The model's verdicts are bounded by
 * enums and parsed defensively: a malformed row degrades to "none / unsure",
 * never to an action. Nothing here follows a URL from a message.
 */

import type { CompletionRequest } from "@brain/contracts";

export const KINDS = ["university", "job", "subscription", "none"] as const;
export type Kind = (typeof KINDS)[number];

export const SENDERS = ["automated", "person", "unsure"] as const;
export type Sender = (typeof SENDERS)[number];

export const DISPOSITIONS = ["keep", "archive"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const REASONS = [
  "actionable",
  "marketing",
  "notification",
  "digest",
  "social",
  "fyi",
  "unsure",
] as const;
export type Reason = (typeof REASONS)[number];

/** A message as `mail_search` summarizes it (mcp-google), plus the internal date it now exposes. */
export interface Header {
  id: string;
  thread_id?: string;
  from?: string;
  subject?: string;
  snippet?: string;
  /** Gmail's internalDate, epoch ms — the only trustworthy "when". */
  internal_date?: number;
  label_ids?: string[];
}

export interface TriageVerdict {
  i: number;
  kind: Kind;
  actionable: boolean;
  sender: Sender;
  /** One of the account's own labels, or null. */
  lane: string | null;
  disposition: Disposition;
  reason: Reason;
}

export interface ExtractItem {
  title: string;
  kind: Exclude<Kind, "none">;
  entity: string;
  due_date: string | null;
  due_time: string | null;
  notes: string;
  keywords: string[];
  confidence: number;
  matches_existing: string | null;
}

export const TRIAGE_BATCH = 40;
export const BODY_CAP = 6000;
export const CONFIDENCE_FLOOR = 0.6;
export const PAGE_SIZE = 25;
export const MAX_MESSAGES_PER_ACCOUNT = 200;
export const MARKER_LABEL = "brain/triaged";
export const ARCHIVED_LABEL = "brain/archived";

// ── the rubric (owner, 2026-10-28) ──────────────────────────────────────────

export const RUBRIC = `You sort the owner's mail. Three kinds of mail matter; everything else is "none".

- university: course announcements, assignment/quiz/exam dates, registrar and co-op deadlines, anything from a university system or instructor that asks for an action by a date. Entity = course code without spaces + the assessment, e.g. "cs348 a3", "math239 midterm", "coop ranking".
- job: applications, interviews, offers, assessments, recruiter follow-ups with a concrete next step. Entity = company + stage, e.g. "shopify interview", "rbc offer", "amazon oa".
- subscription: receipts, renewal notices, trial-ending, price-change, "your plan renews on" mail. The owner may want to cancel, so these are tasks: "review/cancel <service>", due on the renewal date. Entity = the service name, e.g. "netflix", "github copilot".

"none" is everything else: newsletters, marketing, social notifications, shipping updates with nothing to do, FYI threads, mail already answered. When unsure, say none and not actionable — the queue is cheap to miss a task from and expensive to flood.

sender: "automated" for systems, platforms, no-reply and notification addresses, mailing lists and bots (LEARN, Piazza, Crowdmark, registrar systems, recruiting platforms, receipts, newsletters); "person" when a human wrote it by hand (an interviewer, a professor, a recruiter writing personally, a reply in a thread); "unsure" otherwise. Mail from a person is never filed away, so prefer "person" or "unsure" over a wrong "automated".

lane: one of the account's existing labels when the mail belongs there for reference (news, security, receipts/finance, recruiting, a uw/* lane…), else null. Never invent a label.

disposition: "archive" only for automated, non-actionable mail (marketing, notification, digest, social) or reference mail that has a lane; "keep" for anything actionable, anything from a person, and anything unsure.`;

const strictObject = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** OpenAI strict mode: every property required, optionals are nullable, no extras. */
export const TRIAGE_SCHEMA = strictObject({
  verdicts: {
    type: "array",
    items: strictObject({
      i: { type: "integer" },
      kind: { type: "string", enum: [...KINDS] },
      actionable: { type: "boolean" },
      sender: { type: "string", enum: [...SENDERS] },
      lane: { type: ["string", "null"] },
      disposition: { type: "string", enum: [...DISPOSITIONS] },
      reason: { type: "string", enum: [...REASONS] },
    }),
  },
});

export const EXTRACT_SCHEMA = strictObject({
  items: {
    type: "array",
    items: strictObject({
      title: { type: "string" },
      kind: { type: "string", enum: ["university", "job", "subscription"] },
      entity: { type: "string" },
      due_date: { type: ["string", "null"], description: "YYYY-MM-DD or null" },
      due_time: { type: ["string", "null"], description: "HH:MM (24h, local) or null" },
      notes: { type: "string" },
      keywords: { type: "array", items: { type: "string" } },
      confidence: { type: "number" },
      matches_existing: {
        type: ["string", "null"],
        description:
          "the id of an existing open task or pending proposal this is the same thing as, else null",
      },
    }),
  },
});

export interface AccountContext {
  account: string;
  /** Prompt text only: "this is the university account". */
  hint?: string;
  /** The account's own label names, for the lane field. */
  lanes: string[];
  today: string;
}

function accountPreamble(ctx: AccountContext): string {
  const hint = ctx.hint ? `\nAbout this account (${ctx.account}): ${ctx.hint}` : "";
  const lanes = ctx.lanes.length
    ? `\nThis account's labels (the only valid lane values): ${ctx.lanes.join(", ")}`
    : "\nThis account has no labels: lane is always null.";
  return `${RUBRIC}\n\nToday is ${ctx.today}.${hint}${lanes}`;
}

const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

/** One call per batch of headers: no bodies, ~150 tokens a message. */
export function triageRequest(
  model: string,
  headers: Header[],
  ctx: AccountContext,
): CompletionRequest {
  const rows = headers.map((h, i) => ({
    i,
    from: clip(h.from, 120),
    subject: clip(h.subject, 160),
    snippet: clip(h.snippet, 240),
  }));
  return {
    model,
    effort: "low",
    messages: [
      { role: "system", content: accountPreamble(ctx) },
      {
        role: "user",
        content: `Classify every message below. Return one verdict per index, in order.\n\n${JSON.stringify(rows)}`,
      },
    ],
    responseSchema: TRIAGE_SCHEMA,
  };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T =>
  isStr(v) && (list as readonly string[]).includes(v);

/**
 * Parse the triage answer defensively: one verdict per header, by index;
 * a missing or malformed row is "none / unsure / keep" — never an action.
 */
export function parseTriage(parsed: unknown, headers: Header[], lanes: string[]): TriageVerdict[] {
  const safe = (i: number): TriageVerdict => ({
    i,
    kind: "none",
    actionable: false,
    sender: "unsure",
    lane: null,
    disposition: "keep",
    reason: "unsure",
  });
  const out = headers.map((_, i) => safe(i));
  const rows = (parsed as { verdicts?: unknown[] } | null)?.verdicts;
  if (!Array.isArray(rows)) return out;
  const laneSet = new Set(lanes);
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    const i = row.i;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= headers.length) continue;
    const kind = oneOf(row.kind, KINDS) ? row.kind : "none";
    const sender = oneOf(row.sender, SENDERS) ? row.sender : "unsure";
    const reason = oneOf(row.reason, REASONS) ? row.reason : "unsure";
    const lane = isStr(row.lane) && laneSet.has(row.lane) ? row.lane : null;
    const actionable = row.actionable === true && kind !== "none";
    // The disposition table (§4.2) is mechanical; the model's word is one input.
    const disposition: Disposition =
      row.disposition === "archive" &&
      sender === "automated" &&
      !actionable &&
      reason !== "unsure" &&
      reason !== "fyi" &&
      reason !== "actionable" &&
      (lane !== null || ["marketing", "notification", "digest", "social"].includes(reason))
        ? "archive"
        : "keep";
    out[i] = { i, kind, actionable, sender, lane, disposition, reason };
  }
  return out;
}

const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|mailer(-daemon)?|newsletters?|digests?|alerts?|info|news|updates?|receipts?|billing|invoices?|support|hello|team|automated|bounces?|announce(ments)?|admin|system|calendar|jobs|careers|recruiting|talent)(-[a-z0-9-]+)?$|-list$|^list-|^bounce|noreply|no-reply|donotreply/;

/**
 * The mechanical sender signal: the ADDRESS, not the display name, and
 * anchored on the local part — "Announcements Committee <jane@…>" is a
 * person, "LEARN <noreply@learn.invalid>" is not. It overrides a model
 * "automated" towards "unsure", never the other way: a human must never be
 * filed, so this errs towards "person".
 */
export function looksAutomated(h: Header): boolean {
  const raw = (h.from ?? "").trim();
  if (!raw) return false;
  // String ops, not a regex: a `<…>` pattern over untrusted mail headers is
  // exactly the polynomial-backtracking shape CodeQL flags.
  const lt = raw.lastIndexOf("<");
  const gt = lt >= 0 ? raw.indexOf(">", lt) : -1;
  const addr = (lt >= 0 && gt > lt ? raw.slice(lt + 1, gt) : raw).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at <= 0) return false;
  const local = addr.slice(0, at);
  return AUTOMATED_LOCAL_PART.test(local);
}

export interface ExistingContext {
  openTasks: Array<{ id: string; title: string }>;
  pending: Array<{ id: string; title: string; entity: string }>;
}

/** One call per survivor, body capped: the extraction with the dedupe context in the prompt. */
export function extractRequest(
  model: string,
  h: Header,
  body: string,
  ctx: AccountContext,
  existing: ExistingContext,
): CompletionRequest {
  const open = existing.openTasks.map((t) => `- ${t.id}: ${clip(t.title, 120)}`).join("\n");
  const pending = existing.pending
    .map((p) => `- ${p.id}: ${clip(p.title, 120)} (entity: ${p.entity})`)
    .join("\n");
  const system = `${accountPreamble(ctx)}

Extract zero or more tasks from the message. Rules:
- Only what the owner must DO, with a title a human would write ("CS 348 A3 due", "review/cancel Netflix", "Shopify interview — confirm Thursday").
- entity: the canonical identifier per the rubric, short and stable across mails about the same thing.
- due_date / due_time: the deadline if the message states one (local date; time only if stated), else null.
- notes: one or two lines of the facts a human needs (where, what, who), not a summary of the mail.
- keywords: 3–6 words that would find this mail by search.
- confidence: how sure you are this is a real task for the owner (0–1).
- matches_existing: if this is the same thing as one of the open tasks or pending proposals below, give that id and nothing else needs to be new.

Open tasks:
${open || "(none)"}

Pending proposals:
${pending || "(none)"}`;
  const user = `From: ${clip(h.from, 200)}
Subject: ${clip(h.subject, 200)}
Date: ${h.internal_date ? new Date(h.internal_date).toISOString() : "unknown"}

${body.slice(0, BODY_CAP)}${body.length > BODY_CAP ? "\n[truncated]" : ""}`;
  return {
    model,
    effort: "low",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    responseSchema: EXTRACT_SCHEMA,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Parse the extraction defensively: drop anything malformed rather than propose it. */
export function parseExtract(parsed: unknown): ExtractItem[] {
  const rows = (parsed as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(rows)) return [];
  const out: ExtractItem[] = [];
  for (const r of rows) {
    const row = r as Record<string, unknown>;
    if (!isStr(row.title) || !row.title.trim()) continue;
    if (!oneOf(row.kind, ["university", "job", "subscription"] as const)) continue;
    if (!isStr(row.entity) || !row.entity.replace(/[^a-z0-9]/gi, "")) continue;
    const confidence =
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? Math.max(0, Math.min(1, row.confidence))
        : 0;
    out.push({
      title: row.title.trim().slice(0, 200),
      kind: row.kind,
      entity: row.entity.trim().slice(0, 120),
      due_date: isStr(row.due_date) && DATE_RE.test(row.due_date) ? row.due_date : null,
      due_time: isStr(row.due_time) && TIME_RE.test(row.due_time) ? row.due_time : null,
      notes: isStr(row.notes) ? row.notes.trim().slice(0, 1500) : "",
      keywords: Array.isArray(row.keywords)
        ? row.keywords
            .filter(isStr)
            .map((k) => k.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [],
      confidence,
      matches_existing:
        isStr(row.matches_existing) && row.matches_existing.trim()
          ? row.matches_existing.trim()
          : null,
    });
  }
  return out;
}

// ── the search ──────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** The account's lane labels to scan besides the inbox (owner, Q9). */
  lanes: string[];
  /** The seen-marker label, or null when the account lacks it (then the window alone bounds the scan). */
  marker: string | null;
  /** Gmail newer_than value: "2d" on a normal tick, "3d" on the first. */
  window: string;
}

/** Inbox and lanes, minus what the tick already marked and the categories the owner called slop. */
export function searchQuery(o: SearchOptions): string {
  const scope = o.lanes.length
    ? `(in:inbox OR ${o.lanes.map((l) => `label:${l.replace(/\s+/g, "-")}`).join(" OR ")})`
    : "in:inbox";
  const marker = o.marker ? ` -label:${o.marker}` : "";
  return `${scope}${marker} -category:promotions -category:social -category:forums newer_than:${o.window}`;
}

// ── propose ─────────────────────────────────────────────────────────────────

export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** The first notes line: enough to find the mail by search in the right account (owner, Q10 — no link). */
export function breadcrumb(account: string, h: Header, tz: string): string {
  const when = h.internal_date ? localDate(h.internal_date, tz) : "";
  return `from ${clip(h.from, 120) || "unknown sender"} on ${account} · "${clip(h.subject, 140)}"${when ? ` · ${when}` : ""}`;
}

export function dedupeKey(account: string, h: Header): string {
  return `gmail:${account}:${h.id}`;
}

export function threadKey(account: string, h: Header): string | null {
  return h.thread_id ? `gmail:${account}:${h.thread_id}` : null;
}

/** The `tasks.propose` arguments for one extracted item (dates as the tasks server reads them: bare local date or wall time). */
export function proposeArgs(
  account: string,
  h: Header,
  item: ExtractItem,
  tz: string,
): Record<string, unknown> {
  const notes = [
    breadcrumb(account, h, tz),
    item.notes,
    item.keywords.length ? `keywords: ${item.keywords.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
  const due_at =
    item.due_date == null
      ? undefined
      : item.due_time
        ? `${item.due_date}T${item.due_time}`
        : item.due_date;
  return {
    title: item.title,
    kind: item.kind,
    entity: item.entity,
    dedupe_key: dedupeKey(account, h),
    ...(threadKey(account, h) ? { thread_key: threadKey(account, h) } : {}),
    source: {
      kind: "gmail",
      account,
      from: clip(h.from, 200),
      subject: clip(h.subject, 200),
      ...(h.internal_date ? { received_at: h.internal_date } : {}),
    },
    notes,
    ...(due_at ? { due_at } : {}),
    confidence: item.confidence,
  };
}

/** Group message ids by the exact label change they need, ≤ 50 per call (mail_modify_labels' cap). */
export function labelBatches(
  changes: Array<{ id: string; add: string[]; remove: string[] }>,
  max = 50,
): Array<{ message_ids: string[]; add_label_ids: string[]; remove_label_ids: string[] }> {
  const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
  for (const c of changes) {
    const add = [...new Set(c.add)].sort();
    const remove = [...new Set(c.remove)].sort();
    if (add.length === 0 && remove.length === 0) continue;
    const key = `${add.join(",")}|${remove.join(",")}`;
    const g = groups.get(key) ?? { add, remove, ids: [] };
    g.ids.push(c.id);
    groups.set(key, g);
  }
  const out: Array<{ message_ids: string[]; add_label_ids: string[]; remove_label_ids: string[] }> =
    [];
  for (const g of groups.values())
    for (let i = 0; i < g.ids.length; i += max)
      out.push({
        message_ids: g.ids.slice(i, i + max),
        add_label_ids: g.add,
        remove_label_ids: g.remove,
      });
  return out;
}

/**
 * The hard limit on what a label change may contain (§4.2): remove only
 * INBOX, add only the account's own labels and the two markers. Asserted
 * before every call, so a bug upstream cannot reach SPAM, TRASH, UNREAD or
 * STARRED.
 */
/** Gmail's system labels: never added by the tick, whatever the allow-set says. */
const NEVER_ADD = new Set([
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "INBOX",
  "SENT",
  "DRAFT",
  "CHAT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

export function assertLabelChange(
  change: { add_label_ids: string[]; remove_label_ids: string[] },
  allowedAdd: Set<string>,
): void {
  for (const r of change.remove_label_ids)
    if (r !== "INBOX") throw new Error(`refusing to remove label ${r}: only INBOX may be removed`);
  for (const a of change.add_label_ids) {
    if (NEVER_ADD.has(a) || a.startsWith("CATEGORY_"))
      throw new Error(`refusing to add system label ${a}`);
    if (!allowedAdd.has(a)) throw new Error(`refusing to add label ${a}: not an allowed label id`);
  }
}
