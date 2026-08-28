/**
 * Drive over REST (§W2): full CRUD, trash-first deletes. Google-native
 * files export to text formats; everything else reads via alt=media.
 * Permanent deletion lives in its own function so the tool surface can
 * gate it as admin (§4.4).
 */

import type { GoogleClient } from "./google.ts";

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,parents,trashed,webViewLink";
/** Text content is model context: cap and mark rather than overflow. */
const MAX_TEXT_CHARS = 100_000;
/** Binary reads return base64 — truncation would corrupt, so refuse large. */
const MAX_BINARY_BYTES = 512 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  webViewLink?: string;
}

const GOOGLE_NATIVE = "application/vnd.google-apps.";

/** Default export target per Google-native type (override via export_mime_type). */
const EXPORT_DEFAULT: Record<string, string> = {
  [`${GOOGLE_NATIVE}document`]: "text/markdown",
  [`${GOOGLE_NATIVE}spreadsheet`]: "text/csv",
  [`${GOOGLE_NATIVE}presentation`]: "text/plain",
  [`${GOOGLE_NATIVE}drawing`]: "image/svg+xml",
};

function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

export async function driveSearch(
  g: GoogleClient,
  args: {
    query?: string;
    max_results?: number;
    page_token?: string;
    order_by?: string;
    include_trashed?: boolean;
  },
): Promise<{ files: DriveFile[]; next_page_token?: string }> {
  const url = new URL(`${g.driveBase}/files`);
  const clauses: string[] = [];
  if (args.query) clauses.push(`(${args.query})`);
  if (!args.include_trashed) clauses.push("trashed = false");
  if (clauses.length) url.searchParams.set("q", clauses.join(" and "));
  url.searchParams.set("pageSize", String(Math.min(args.max_results ?? 20, 100)));
  url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
  if (args.order_by) url.searchParams.set("orderBy", args.order_by);
  if (args.page_token) url.searchParams.set("pageToken", args.page_token);
  const res = await g.json<{ files?: DriveFile[]; nextPageToken?: string }>(url.toString());
  return {
    files: res.files ?? [],
    ...(res.nextPageToken ? { next_page_token: res.nextPageToken } : {}),
  };
}

export async function driveListRecent(
  g: GoogleClient,
  maxResults?: number,
): Promise<{ files: DriveFile[] }> {
  const out = await driveSearch(g, {
    max_results: maxResults,
    order_by: "modifiedTime desc",
  });
  return { files: out.files };
}

export async function driveGetMetadata(g: GoogleClient, id: string): Promise<DriveFile> {
  return g.json<DriveFile>(
    `${g.driveBase}/files/${id}?fields=${FILE_FIELDS},createdTime,description,shortcutDetails`,
  );
}

export async function driveRead(
  g: GoogleClient,
  args: { id: string; export_mime_type?: string },
): Promise<{
  id: string;
  name: string;
  mime_type: string;
  content: string;
  encoding?: "base64";
  truncated?: boolean;
}> {
  const meta = await g.json<DriveFile>(
    `${g.driveBase}/files/${args.id}?fields=id,name,mimeType,size`,
  );
  const mime = meta.mimeType ?? "application/octet-stream";
  if (mime.startsWith(GOOGLE_NATIVE)) {
    const target = args.export_mime_type ?? EXPORT_DEFAULT[mime] ?? "text/plain";
    const res = await g.request(
      `${g.driveBase}/files/${args.id}/export?mimeType=${encodeURIComponent(target)}`,
    );
    const text = await res.text();
    const truncated = text.length > MAX_TEXT_CHARS;
    return {
      id: meta.id,
      name: meta.name,
      mime_type: target,
      content: truncated ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated]` : text,
      ...(truncated ? { truncated: true } : {}),
    };
  }
  const res = await g.request(`${g.driveBase}/files/${args.id}?alt=media`);
  if (isTextual(mime)) {
    const text = await res.text();
    const truncated = text.length > MAX_TEXT_CHARS;
    return {
      id: meta.id,
      name: meta.name,
      mime_type: mime,
      content: truncated ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated]` : text,
      ...(truncated ? { truncated: true } : {}),
    };
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_BINARY_BYTES)
    throw new Error(
      `drive_read: ${meta.name} is binary and ${bytes.byteLength} bytes (cap ${MAX_BINARY_BYTES}) — too large to inline`,
    );
  return {
    id: meta.id,
    name: meta.name,
    mime_type: mime,
    content: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
  };
}

/** RFC 2387 multipart/related by hand — two parts, no library needed. */
function multipartBody(
  metadata: Record<string, unknown>,
  content: string,
  contentMime: string,
): { body: string; contentType: string } {
  const boundary = "brain-mcp-google-b";
  const body = [
    `--${boundary}`,
    "content-type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    `content-type: ${contentMime}`,
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

export async function driveCreate(
  g: GoogleClient,
  args: { name: string; mime_type?: string; content?: string; parent_id?: string },
): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {
    name: args.name,
    ...(args.mime_type ? { mimeType: args.mime_type } : {}),
    ...(args.parent_id ? { parents: [args.parent_id] } : {}),
  };
  if (args.content === undefined) {
    return g.json<DriveFile>(`${g.driveBase}/files?fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(metadata),
    });
  }
  const { body, contentType } = multipartBody(
    metadata,
    args.content,
    args.mime_type ?? "text/plain",
  );
  return g.json<DriveFile>(`${g.uploadBase}/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

export async function driveUpdate(
  g: GoogleClient,
  args: {
    id: string;
    content?: string;
    name?: string;
    add_parent_id?: string;
    remove_parent_id?: string;
  },
): Promise<DriveFile> {
  let latest: DriveFile | null = null;
  if (args.content !== undefined) {
    latest = await g.json<DriveFile>(
      `${g.uploadBase}/files/${args.id}?uploadType=media&fields=${FILE_FIELDS}`,
      { method: "PATCH", body: args.content },
    );
  }
  if (args.name !== undefined || args.add_parent_id || args.remove_parent_id) {
    const url = new URL(`${g.driveBase}/files/${args.id}`);
    url.searchParams.set("fields", FILE_FIELDS);
    if (args.add_parent_id) url.searchParams.set("addParents", args.add_parent_id);
    if (args.remove_parent_id) url.searchParams.set("removeParents", args.remove_parent_id);
    latest = await g.json<DriveFile>(url.toString(), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args.name !== undefined ? { name: args.name } : {}),
    });
  }
  if (!latest) throw new Error("drive_update: nothing to change (content, name, or a parent)");
  return latest;
}

export async function driveCopy(
  g: GoogleClient,
  args: { id: string; name?: string; parent_id?: string },
): Promise<DriveFile> {
  return g.json<DriveFile>(`${g.driveBase}/files/${args.id}/copy?fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(args.name ? { name: args.name } : {}),
      ...(args.parent_id ? { parents: [args.parent_id] } : {}),
    }),
  });
}

export async function driveSetTrashed(
  g: GoogleClient,
  id: string,
  trashed: boolean,
): Promise<DriveFile> {
  return g.json<DriveFile>(`${g.driveBase}/files/${id}?fields=${FILE_FIELDS}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashed }),
  });
}

export async function driveDeleteForever(
  g: GoogleClient,
  id: string,
): Promise<{ id: string; deleted: true }> {
  await g.json(`${g.driveBase}/files/${id}`, { method: "DELETE" });
  return { id, deleted: true };
}
