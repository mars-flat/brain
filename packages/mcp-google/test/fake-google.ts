/**
 * Fake Google endpoints via Bun.serve (§8.2 — no real APIs or identity in
 * CI/fixtures): the OAuth token endpoint plus the Gmail and Drive REST
 * slices mcp-google touches, over an in-memory store. Also imported by the
 * compose e2e smoke, so keep it dependency-free and deterministic.
 */

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  bodyText: string;
  bodyHtml?: string;
}

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents: string[];
  trashed: boolean;
  content: string;
}

export interface FakeGoogle {
  url: string;
  state: {
    minted: number;
    /** Force the active access token invalid — next API call 401s once. */
    revokeActive(): void;
    messages: Map<string, FakeMessage>;
    labels: Map<string, { id: string; name: string; type: string }>;
    files: Map<string, FakeFile>;
  };
  stop(): void;
}

const REFRESH_TOKEN = "fake-refresh-token";
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function seedMessages(): Map<string, FakeMessage> {
  const m = new Map<string, FakeMessage>();
  m.set("m1", {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    from: "Ada Lovelace <ada@example.invalid>",
    to: "you@example.invalid",
    subject: "Analytical engine notes",
    date: "Fri, 28 Aug 2026 09:00:00 +0000",
    snippet: "the engine weaves algebraic patterns",
    bodyText:
      "The Analytical Engine weaves algebraic patterns just as the Jacquard loom weaves flowers and leaves.",
    bodyHtml: "<p>The Analytical Engine weaves <b>algebraic patterns</b>.</p>",
  });
  m.set("m2", {
    id: "m2",
    threadId: "t1",
    labelIds: ["INBOX"],
    from: "Charles Babbage <cb@example.invalid>",
    to: "you@example.invalid",
    subject: "Re: Analytical engine notes",
    date: "Fri, 28 Aug 2026 10:00:00 +0000",
    snippet: "quite so",
    bodyText: "Quite so. Shall we discuss the mill and the store?",
  });
  m.set("m3", {
    id: "m3",
    threadId: "t2",
    labelIds: ["INBOX", "UNREAD"],
    from: "newsletter@example.invalid",
    to: "you@example.invalid",
    subject: "Weekly digest",
    date: "Thu, 27 Aug 2026 08:00:00 +0000",
    snippet: "this week in gears",
    bodyText: "This week in gears: differential progress.",
  });
  return m;
}

function seedLabels(): Map<string, { id: string; name: string; type: string }> {
  const l = new Map<string, { id: string; name: string; type: string }>();
  for (const id of ["INBOX", "UNREAD", "SPAM", "TRASH"])
    l.set(id, { id, name: id, type: "system" });
  return l;
}

function seedFiles(): Map<string, FakeFile> {
  const f = new Map<string, FakeFile>();
  f.set("root", {
    id: "root",
    name: "My Drive",
    mimeType: "application/vnd.google-apps.folder",
    modifiedTime: "2026-08-01T00:00:00Z",
    parents: [],
    trashed: false,
    content: "",
  });
  f.set("f-doc", {
    id: "f-doc",
    name: "Engine design",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2026-08-27T12:00:00Z",
    parents: ["root"],
    trashed: false,
    content: "Design: a mill, a store, and punched cards.",
  });
  f.set("f-txt", {
    id: "f-txt",
    name: "notes.txt",
    mimeType: "text/plain",
    modifiedTime: "2026-08-28T12:00:00Z",
    parents: ["root"],
    trashed: false,
    content: "plain text notes",
  });
  return f;
}

/** Gmail wire shape for one message at the requested format. */
function wireMessage(msg: FakeMessage, format: string) {
  const headers = [
    { name: "From", value: msg.from },
    { name: "To", value: msg.to },
    { name: "Subject", value: msg.subject },
    { name: "Date", value: msg.date },
  ];
  if (format === "metadata")
    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: msg.labelIds,
      snippet: msg.snippet,
      payload: { headers },
    };
  // full: multipart/alternative with text/plain (+ html when present) —
  // exercises the MIME-tree walk.
  const parts: Array<Record<string, unknown>> = [
    { mimeType: "text/plain", body: { data: b64url(msg.bodyText) } },
  ];
  if (msg.bodyHtml) parts.push({ mimeType: "text/html", body: { data: b64url(msg.bodyHtml) } });
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    snippet: msg.snippet,
    payload: { mimeType: "multipart/alternative", headers, parts },
  };
}

/** files.list q subset: `name contains 'x'`, `fullText contains 'x'`, `trashed = b`, `'p' in parents`. */
function matchDriveQuery(f: FakeFile, q: string | null): boolean {
  if (!q) return true;
  for (let clause of q.split(" and ")) {
    clause = clause.trim().replace(/^\(/, "").replace(/\)$/, "");
    const name = clause.match(/^name contains '(.+)'$/);
    const fullText = clause.match(/^fullText contains '(.+)'$/);
    const trashed = clause.match(/^trashed = (true|false)$/);
    const parents = clause.match(/^'(.+)' in parents$/);
    if (name) {
      if (!f.name.toLowerCase().includes((name[1] as string).toLowerCase())) return false;
    } else if (fullText) {
      if (!(f.content + f.name).toLowerCase().includes((fullText[1] as string).toLowerCase()))
        return false;
    } else if (trashed) {
      if (f.trashed !== (trashed[1] === "true")) return false;
    } else if (parents) {
      if (!f.parents.includes(parents[1] as string)) return false;
    } else return false; // unsupported clause — match nothing, loudly wrong
  }
  return true;
}

const fileJson = (f: FakeFile) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  modifiedTime: f.modifiedTime,
  parents: f.parents,
  trashed: f.trashed,
});

export function startFakeGoogle(port: number): FakeGoogle {
  let minted = 0;
  let active = "";
  const messages = seedMessages();
  const labels = seedLabels();
  const files = seedFiles();
  let nextId = 1;

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "POST" && path === "/token") {
        const body = new URLSearchParams(await req.text());
        if (
          body.get("grant_type") !== "refresh_token" ||
          body.get("refresh_token") !== REFRESH_TOKEN
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        minted += 1;
        active = `at-${minted}`;
        return Response.json({ access_token: active, expires_in: 3600, token_type: "Bearer" });
      }

      if (req.headers.get("authorization") !== `Bearer ${active}`)
        return Response.json(
          { error: { code: 401, message: "invalid access token" } },
          { status: 401 },
        );

      // ── Gmail ──
      if (path === "/gmail/v1/users/me/messages" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const wantLabels = url.searchParams.getAll("labelIds");
        const max = Number(url.searchParams.get("maxResults") ?? 100);
        const from = q.match(/from:(\S+)/)?.[1];
        const text = q.replace(/from:\S+/g, "").trim();
        const hits = [...messages.values()].filter((m) => {
          if (from && !m.from.toLowerCase().includes(from)) return false;
          if (text && !`${m.subject} ${m.bodyText} ${m.from}`.toLowerCase().includes(text))
            return false;
          return wantLabels.every((l) => m.labelIds.includes(l));
        });
        return Response.json({
          messages: hits.slice(0, max).map((m) => ({ id: m.id, threadId: m.threadId })),
          resultSizeEstimate: hits.length,
        });
      }
      const msgGet = path.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
      if (msgGet && req.method === "GET") {
        const msg = messages.get(msgGet[1] as string);
        if (!msg)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        return Response.json(wireMessage(msg, url.searchParams.get("format") ?? "full"));
      }
      const msgModify = path.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/);
      if (msgModify && req.method === "POST") {
        const msg = messages.get(msgModify[1] as string);
        if (!msg)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        const body = (await req.json()) as { addLabelIds?: string[]; removeLabelIds?: string[] };
        for (const l of body.addLabelIds ?? [])
          if (!labels.has(l))
            return Response.json(
              { error: { code: 400, message: `unknown label ${l}` } },
              { status: 400 },
            );
        msg.labelIds = [
          ...new Set([
            ...msg.labelIds.filter((l) => !(body.removeLabelIds ?? []).includes(l)),
            ...(body.addLabelIds ?? []),
          ]),
        ];
        return Response.json({ id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
      }
      const threadGet = path.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
      if (threadGet && req.method === "GET") {
        const inThread = [...messages.values()].filter((x) => x.threadId === threadGet[1]);
        if (!inThread.length)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        return Response.json({
          id: threadGet[1],
          messages: inThread.map((x) => wireMessage(x, "full")),
        });
      }
      if (path === "/gmail/v1/users/me/labels" && req.method === "GET")
        return Response.json({ labels: [...labels.values()] });
      if (path === "/gmail/v1/users/me/labels" && req.method === "POST") {
        const body = (await req.json()) as { name: string };
        const id = `Label_${nextId++}`;
        labels.set(id, { id, name: body.name, type: "user" });
        return Response.json({ id, name: body.name, type: "user" });
      }

      // ── Drive (metadata + content) ──
      if (path === "/drive/v3/files" && req.method === "GET") {
        let hits = [...files.values()].filter((f) => matchDriveQuery(f, url.searchParams.get("q")));
        if (url.searchParams.get("orderBy")?.startsWith("modifiedTime desc"))
          hits = hits.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
        const max = Number(url.searchParams.get("pageSize") ?? 100);
        return Response.json({ files: hits.slice(0, max).map(fileJson) });
      }
      if (path === "/drive/v3/files" && req.method === "POST") {
        const meta = (await req.json()) as { name: string; mimeType?: string; parents?: string[] };
        const f: FakeFile = {
          id: `f-${nextId++}`,
          name: meta.name,
          mimeType: meta.mimeType ?? "application/octet-stream",
          modifiedTime: "2026-08-28T13:00:00Z",
          parents: meta.parents ?? ["root"],
          trashed: false,
          content: "",
        };
        files.set(f.id, f);
        return Response.json(fileJson(f));
      }
      if (path === "/upload/drive/v3/files" && req.method === "POST") {
        const raw = await req.text();
        const boundary = req.headers.get("content-type")?.match(/boundary=(\S+)/)?.[1] ?? "";
        const parts = raw.split(`--${boundary}`).filter((p) => p.includes("\r\n\r\n"));
        const meta = JSON.parse((parts[0] as string).split("\r\n\r\n")[1] ?? "{}") as {
          name: string;
          mimeType?: string;
          parents?: string[];
        };
        const content = ((parts[1] as string).split("\r\n\r\n")[1] ?? "").replace(/\r\n$/, "");
        const f: FakeFile = {
          id: `f-${nextId++}`,
          name: meta.name,
          mimeType: meta.mimeType ?? "text/plain",
          modifiedTime: "2026-08-28T13:00:00Z",
          parents: meta.parents ?? ["root"],
          trashed: false,
          content,
        };
        files.set(f.id, f);
        return Response.json(fileJson(f));
      }
      const uploadPatch = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (uploadPatch && req.method === "PATCH") {
        const f = files.get(uploadPatch[1] as string);
        if (!f)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        f.content = await req.text();
        f.modifiedTime = "2026-08-28T14:00:00Z";
        return Response.json(fileJson(f));
      }
      const exportGet = path.match(/^\/drive\/v3\/files\/([^/]+)\/export$/);
      if (exportGet && req.method === "GET") {
        const f = files.get(exportGet[1] as string);
        if (!f)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        const mime = url.searchParams.get("mimeType") ?? "text/plain";
        return new Response(`[export ${mime}] ${f.content}`, {
          headers: { "content-type": mime },
        });
      }
      const copyPost = path.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/);
      if (copyPost && req.method === "POST") {
        const f = files.get(copyPost[1] as string);
        if (!f)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        const body = (await req.json()) as { name?: string; parents?: string[] };
        const copy: FakeFile = {
          ...f,
          id: `f-${nextId++}`,
          name: body.name ?? `Copy of ${f.name}`,
          parents: body.parents ?? f.parents,
        };
        files.set(copy.id, copy);
        return Response.json(fileJson(copy));
      }
      const fileRoute = path.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (fileRoute) {
        const f = files.get(fileRoute[1] as string);
        if (!f)
          return Response.json({ error: { code: 404, message: "not found" } }, { status: 404 });
        if (req.method === "GET") {
          if (url.searchParams.get("alt") === "media")
            return new Response(f.content, { headers: { "content-type": f.mimeType } });
          return Response.json(fileJson(f));
        }
        if (req.method === "PATCH") {
          const body = (await req.json()) as { name?: string; trashed?: boolean };
          if (body.name !== undefined) f.name = body.name;
          if (body.trashed !== undefined) f.trashed = body.trashed;
          const add = url.searchParams.get("addParents");
          const remove = url.searchParams.get("removeParents");
          if (remove) f.parents = f.parents.filter((p) => p !== remove);
          if (add) f.parents = [...new Set([...f.parents, add])];
          return Response.json(fileJson(f));
        }
        if (req.method === "DELETE") {
          files.delete(f.id);
          return new Response(null, { status: 204 });
        }
      }

      return Response.json(
        { error: { code: 404, message: `no route ${req.method} ${path}` } },
        { status: 404 },
      );
    },
  });

  return {
    url: `http://127.0.0.1:${port}`,
    state: {
      get minted() {
        return minted;
      },
      revokeActive: () => {
        active = "";
      },
      messages,
      labels,
      files,
    },
    stop: () => server.stop(true),
  };
}

/** The refresh token the fake accepts — servers under test must be configured with it. */
export const FAKE_REFRESH_TOKEN = REFRESH_TOKEN;
