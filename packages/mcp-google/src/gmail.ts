/**
 * Gmail over REST (§W2): search, read, label control. No send/draft
 * function exists in this file — the no-send guarantee is structural
 * (absent tool surface) plus the gateway's permanent policy deny.
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
export function extractBody(payload: WirePart | undefined): { mime_type: string; text: string } {
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
