/**
 * Gmail over REST (§W2): search, read, label control, and filter control
 * (2026-09-18). No send/draft function exists in this file — the no-send
 * guarantee is structural (absent tool surface) plus the gateway's
 * permanent policy deny. The same rule shapes filters: a filter's
 * `forward` action would mail every match to an outside address, so it is
 * refused here before the request is built, never merely undocumented.
 */

import type { GoogleClient } from "./google.ts";

/** Bodies are model context: cap and mark rather than overflow. */
const MAX_BODY_CHARS = 50_000;

interface WirePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: WirePart[];
  headers?: Array<{ name: string; value: string }>;
}

interface WireMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: WirePart;
}

export interface MessageSummary {
  id: string;
  thread_id?: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  label_ids?: string[];
}

export interface MessageFull extends MessageSummary {
  cc?: string;
  body: { mime_type: string; text: string; truncated?: boolean };
}

function header(payload: WirePart | undefined, name: string): string | undefined {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function decodeB64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Walk the MIME tree for the best text rendering: prefer text/plain,
 * fall back to text/html (returned as-is — thin server, no HTML strip).
 */
function extractBody(payload: WirePart | undefined): { mime_type: string; text: string } {
  const found: Record<string, string[]> = { "text/plain": [], "text/html": [] };
  const walk = (p: WirePart | undefined) => {
    if (!p) return;
    const mime = p.mimeType ?? "";
    if ((mime === "text/plain" || mime === "text/html") && p.body?.data)
      found[mime]?.push(decodeB64Url(p.body.data));
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  if (found["text/plain"]?.length)
    return { mime_type: "text/plain", text: found["text/plain"].join("\n") };
  if (found["text/html"]?.length)
    return { mime_type: "text/html", text: found["text/html"].join("\n") };
  return { mime_type: payload?.mimeType ?? "unknown", text: "" };
}

function summarize(m: WireMessage): MessageSummary {
  return {
    id: m.id,
    thread_id: m.threadId,
    from: header(m.payload, "From"),
    to: header(m.payload, "To"),
    subject: header(m.payload, "Subject"),
    date: header(m.payload, "Date"),
    snippet: m.snippet,
    label_ids: m.labelIds,
  };
}

function full(m: WireMessage): MessageFull {
  const body = extractBody(m.payload);
  const truncated = body.text.length > MAX_BODY_CHARS;
  return {
    ...summarize(m),
    cc: header(m.payload, "Cc"),
    body: {
      mime_type: body.mime_type,
      text: truncated ? `${body.text.slice(0, MAX_BODY_CHARS)}\n[truncated]` : body.text,
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

const METADATA_HEADERS =
  "&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";

export async function mailSearch(
  g: GoogleClient,
  args: { query: string; max_results?: number; label_ids?: string[]; page_token?: string },
): Promise<{ results: MessageSummary[]; next_page_token?: string }> {
  const url = new URL(`${g.gmailBase}/users/me/messages`);
  url.searchParams.set("q", args.query);
  url.searchParams.set("maxResults", String(Math.min(args.max_results ?? 10, 50)));
  if (args.page_token) url.searchParams.set("pageToken", args.page_token);
  for (const l of args.label_ids ?? []) url.searchParams.append("labelIds", l);
  const list = await g.json<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
    url.toString(),
  );
  const results = await Promise.all(
    (list.messages ?? []).map(async (m) =>
      summarize(
        await g.json<WireMessage>(
          `${g.gmailBase}/users/me/messages/${m.id}?format=metadata${METADATA_HEADERS}`,
        ),
      ),
    ),
  );
  return { results, ...(list.nextPageToken ? { next_page_token: list.nextPageToken } : {}) };
}

export async function mailGetMessage(g: GoogleClient, id: string): Promise<MessageFull> {
  return full(await g.json<WireMessage>(`${g.gmailBase}/users/me/messages/${id}?format=full`));
}

export async function mailGetThread(
  g: GoogleClient,
  id: string,
): Promise<{ id: string; messages: MessageFull[] }> {
  const thread = await g.json<{ id: string; messages?: WireMessage[] }>(
    `${g.gmailBase}/users/me/threads/${id}?format=full`,
  );
  return { id: thread.id, messages: (thread.messages ?? []).map(full) };
}

export interface Label {
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

export async function mailListLabels(g: GoogleClient): Promise<{ labels: Label[] }> {
  const res = await g.json<{ labels?: Label[] }>(`${g.gmailBase}/users/me/labels`);
  return {
    labels: (res.labels ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      ...(l.messagesTotal !== undefined ? { messagesTotal: l.messagesTotal } : {}),
      ...(l.messagesUnread !== undefined ? { messagesUnread: l.messagesUnread } : {}),
    })),
  };
}

export async function mailCreateLabel(
  g: GoogleClient,
  name: string,
): Promise<{ id: string; name: string }> {
  const l = await g.json<{ id: string; name: string }>(`${g.gmailBase}/users/me/labels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return { id: l.id, name: l.name };
}

export async function mailModifyLabels(
  g: GoogleClient,
  args: { message_ids: string[]; add_label_ids?: string[]; remove_label_ids?: string[] },
): Promise<{ results: Array<{ id: string; label_ids: string[] }> }> {
  if (!args.add_label_ids?.length && !args.remove_label_ids?.length)
    throw new Error("mail_modify_labels: add_label_ids or remove_label_ids required");
  if (args.message_ids.length > 50)
    throw new Error("mail_modify_labels: at most 50 message_ids per call");
  const results: Array<{ id: string; label_ids: string[] }> = [];
  for (const id of args.message_ids) {
    const m = await g.json<WireMessage>(`${g.gmailBase}/users/me/messages/${id}/modify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addLabelIds: args.add_label_ids ?? [],
        removeLabelIds: args.remove_label_ids ?? [],
      }),
    });
    results.push({ id: m.id, label_ids: m.labelIds ?? [] });
  }
  return { results };
}

// ── filters (users.settings.filters — needs the gmail.settings.basic scope) ──

/**
 * Gmail's own filter shape, minus `forward`. Criteria are the search
 * operators (`query` takes the full Gmail search syntax, so a filter can
 * key on text inside a forwarded message's quoted headers, which `from:`
 * cannot see); actions add and remove label ids — archive is
 * `remove_label_ids: ["INBOX"]`, mark-read is `["UNREAD"]`.
 */
export interface FilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negated_query?: string;
  has_attachment?: boolean;
  exclude_chats?: boolean;
}

export interface FilterAction {
  add_label_ids?: string[];
  remove_label_ids?: string[];
}

export interface MailFilter {
  id: string;
  criteria: FilterCriteria;
  action: FilterAction;
}

interface WireFilter {
  id: string;
  criteria?: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
  };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
}

function filterFromWire(f: WireFilter): MailFilter {
  const c = f.criteria ?? {};
  const a = f.action ?? {};
  return {
    id: f.id,
    criteria: {
      ...(c.from !== undefined ? { from: c.from } : {}),
      ...(c.to !== undefined ? { to: c.to } : {}),
      ...(c.subject !== undefined ? { subject: c.subject } : {}),
      ...(c.query !== undefined ? { query: c.query } : {}),
      ...(c.negatedQuery !== undefined ? { negated_query: c.negatedQuery } : {}),
      ...(c.hasAttachment !== undefined ? { has_attachment: c.hasAttachment } : {}),
      ...(c.excludeChats !== undefined ? { exclude_chats: c.excludeChats } : {}),
    },
    action: {
      ...(a.addLabelIds?.length ? { add_label_ids: a.addLabelIds } : {}),
      ...(a.removeLabelIds?.length ? { remove_label_ids: a.removeLabelIds } : {}),
    },
  };
}

export async function mailListFilters(g: GoogleClient): Promise<{ filters: MailFilter[] }> {
  const res = await g.json<{ filter?: WireFilter[] }>(`${g.gmailBase}/users/me/settings/filters`);
  return { filters: (res.filter ?? []).map(filterFromWire) };
}

export async function mailCreateFilter(
  g: GoogleClient,
  args: { criteria: FilterCriteria; action: FilterAction & { forward?: unknown } },
): Promise<MailFilter> {
  const c = args.criteria ?? {};
  const a = args.action ?? {};
  if ("forward" in a && a.forward !== undefined)
    throw new Error(
      "mail_create_filter: forwarding actions are not supported — a filter that forwards mail is a send path (§W2 no-send)",
    );
  const hasCriteria = [c.from, c.to, c.subject, c.query, c.negated_query].some((v) => v?.trim());
  if (!hasCriteria && c.has_attachment === undefined)
    throw new Error("mail_create_filter: at least one criterion is required");
  if (!a.add_label_ids?.length && !a.remove_label_ids?.length)
    throw new Error("mail_create_filter: add_label_ids or remove_label_ids required");
  const body = {
    criteria: {
      ...(c.from ? { from: c.from } : {}),
      ...(c.to ? { to: c.to } : {}),
      ...(c.subject ? { subject: c.subject } : {}),
      ...(c.query ? { query: c.query } : {}),
      ...(c.negated_query ? { negatedQuery: c.negated_query } : {}),
      ...(c.has_attachment !== undefined ? { hasAttachment: c.has_attachment } : {}),
      ...(c.exclude_chats !== undefined ? { excludeChats: c.exclude_chats } : {}),
    },
    action: {
      ...(a.add_label_ids?.length ? { addLabelIds: a.add_label_ids } : {}),
      ...(a.remove_label_ids?.length ? { removeLabelIds: a.remove_label_ids } : {}),
    },
  };
  const f = await g.json<WireFilter>(`${g.gmailBase}/users/me/settings/filters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return filterFromWire(f);
}

export async function mailDeleteFilter(g: GoogleClient, id: string): Promise<{ id: string }> {
  await g.json(`${g.gmailBase}/users/me/settings/filters/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return { id };
}

/**
 * Message ids only — the list endpoint alone, no per-message metadata
 * fan-out, so a caller that wants to relabel hundreds of matches (a filter
 * backfill) does not trip Gmail's per-user concurrency cap (§W2 note).
 */
export async function mailListIds(
  g: GoogleClient,
  args: { query: string; max_results?: number; page_token?: string },
): Promise<{ ids: string[]; next_page_token?: string }> {
  const url = new URL(`${g.gmailBase}/users/me/messages`);
  url.searchParams.set("q", args.query);
  url.searchParams.set("maxResults", String(Math.min(args.max_results ?? 100, 500)));
  if (args.page_token) url.searchParams.set("pageToken", args.page_token);
  const list = await g.json<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
    url.toString(),
  );
  return {
    ids: (list.messages ?? []).map((m) => m.id),
    ...(list.nextPageToken ? { next_page_token: list.nextPageToken } : {}),
  };
}

/**
 * One request relabels up to 1000 messages (users.messages.batchModify) —
 * the backfill path, where per-message modify calls would be a thousand
 * round trips for one rule. Returns nothing per message; Gmail either
 * applies the whole batch or rejects it.
 */
export async function mailBatchModify(
  g: GoogleClient,
  args: { message_ids: string[]; add_label_ids?: string[]; remove_label_ids?: string[] },
): Promise<{ modified: number }> {
  if (!args.add_label_ids?.length && !args.remove_label_ids?.length)
    throw new Error("mail_batch_modify: add_label_ids or remove_label_ids required");
  if (args.message_ids.length === 0) return { modified: 0 };
  if (args.message_ids.length > 1000)
    throw new Error("mail_batch_modify: at most 1000 message_ids per call");
  await g.json(`${g.gmailBase}/users/me/messages/batchModify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids: args.message_ids,
      addLabelIds: args.add_label_ids ?? [],
      removeLabelIds: args.remove_label_ids ?? [],
    }),
  });
  return { modified: args.message_ids.length };
}
