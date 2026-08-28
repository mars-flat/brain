/**
 * mcp-google over a real MCP client connection, against the fake Google
 * endpoints. The structural no-send guarantee, token-mint economy, MIME
 * decoding, label control, and the Drive lifecycle are all asserted here —
 * never against real APIs or identity (§8.2).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildGoogleServer } from "../src/server.ts";
import { FAKE_REFRESH_TOKEN, type FakeGoogle, startFakeGoogle } from "./fake-google.ts";

const PORT = 18871;

let fake: FakeGoogle;
let client: Client;

beforeAll(async () => {
  fake = startFakeGoogle(PORT);
  const server = buildGoogleServer({
    clientId: "test-client",
    clientSecret: "test-secret",
    refreshToken: FAKE_REFRESH_TOKEN,
    accountLabel: "g-test",
    tokenUrl: `${fake.url}/token`,
    gmailBase: `${fake.url}/gmail/v1`,
    driveBase: `${fake.url}/drive/v3`,
    uploadBase: `${fake.url}/upload/drive/v3`,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
});

afterAll(() => {
  fake.stop();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  return {
    isError: res.isError === true,
    text: (res.content as Array<{ text?: string }>)?.[0]?.text ?? "",
    out: res.structuredContent as Record<string, unknown> | undefined,
  };
}

describe("tool surface (§W2)", () => {
  test("advertises the sixteen tools; nothing send- or draft-shaped exists", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    for (const t of tools) {
      expect(t.name).not.toMatch(/send|draft|compose|reply/i);
      expect(t.description).toContain("g-test");
    }
  });

  test("reads carry readOnlyHint, permanent delete carries destructiveHint, writes carry neither", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));
    const reads = [
      "mail_search",
      "mail_get_message",
      "mail_get_thread",
      "mail_list_labels",
      "drive_search",
      "drive_get_metadata",
      "drive_read",
      "drive_list_recent",
    ];
    for (const name of reads) expect(byName.get(name)).toHaveProperty("readOnlyHint", true);
    expect(byName.get("drive_delete_forever")).toHaveProperty("destructiveHint", true);
    for (const name of [
      "mail_create_label",
      "mail_modify_labels",
      "drive_create",
      "drive_update",
      "drive_copy",
      "drive_trash",
      "drive_untrash",
    ]) {
      expect(byName.get(name)).not.toHaveProperty("readOnlyHint");
      expect(byName.get(name)).not.toHaveProperty("destructiveHint");
    }
  });
});

describe("token economy", () => {
  test("one mint serves many calls; a revoked token forces exactly one re-mint", async () => {
    await call("mail_list_labels");
    await call("drive_list_recent");
    expect(fake.state.minted).toBe(1);
    fake.state.revokeActive();
    const res = await call("mail_list_labels");
    expect(res.isError).toBe(false);
    expect(fake.state.minted).toBe(2);
  });
});

describe("mail", () => {
  test("mail_search joins list ids with per-message metadata", async () => {
    const { out } = await call("mail_search", { query: "engine" });
    const results = out?.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.id).sort()).toEqual(["m1", "m2"]);
    const m1 = results.find((r) => r.id === "m1");
    expect(m1?.subject).toBe("Analytical engine notes");
    expect(m1?.from).toContain("ada@example.invalid");
    expect(m1?.snippet).toContain("weaves");
  });

  test("mail_search honors from: operator", async () => {
    const { out } = await call("mail_search", { query: "from:newsletter" });
    expect(((out?.results ?? []) as Array<{ id: string }>).map((r) => r.id)).toEqual(["m3"]);
  });

  test("mail_get_message decodes the multipart body, preferring text/plain", async () => {
    const { out } = await call("mail_get_message", { id: "m1" });
    const body = out?.body as { mime_type: string; text: string };
    expect(body.mime_type).toBe("text/plain");
    expect(body.text).toContain("Jacquard loom");
    expect(out?.subject).toBe("Analytical engine notes");
  });

  test("mail_get_thread returns every message in the thread, decoded", async () => {
    const { out } = await call("mail_get_thread", { id: "t1" });
    const msgs = out?.messages as Array<{ id: string; body: { text: string } }>;
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(msgs[1]?.body.text).toContain("mill and the store");
  });

  test("labels: list, create, then archive+spam via modify", async () => {
    const labels = (await call("mail_list_labels")).out?.labels as Array<{ id: string }>;
    expect(labels.map((l) => l.id)).toContain("INBOX");

    const created = (await call("mail_create_label", { name: "brain/test" })).out as {
      id: string;
      name: string;
    };
    expect(created.name).toBe("brain/test");

    const modified = (
      await call("mail_modify_labels", {
        message_ids: ["m3"],
        add_label_ids: ["SPAM", created.id],
        remove_label_ids: ["INBOX"],
      })
    ).out?.results as Array<{ id: string; label_ids: string[] }>;
    expect(modified[0]?.label_ids).toContain("SPAM");
    expect(modified[0]?.label_ids).toContain(created.id);
    expect(modified[0]?.label_ids).not.toContain("INBOX");
  });

  test("modify with neither add nor remove is a tool error, not a crash", async () => {
    const res = await call("mail_modify_labels", { message_ids: ["m1"] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("required");
  });
});

describe("drive", () => {
  test("drive_search matches names and excludes trashed by default", async () => {
    const { out } = await call("drive_search", { query: "name contains 'notes'" });
    expect(((out?.files ?? []) as Array<{ id: string }>).map((f) => f.id)).toEqual(["f-txt"]);
  });

  test("drive_read serves plain files verbatim and exports Google-native ones", async () => {
    const txt = (await call("drive_read", { id: "f-txt" })).out as { content: string };
    expect(txt.content).toBe("plain text notes");

    const doc = (await call("drive_read", { id: "f-doc" })).out as {
      mime_type: string;
      content: string;
    };
    expect(doc.mime_type).toBe("text/markdown");
    expect(doc.content).toContain("punched cards");
  });

  test("create → read → rename+rewrite → copy → trash → untrash → delete_forever", async () => {
    const created = (
      await call("drive_create", { name: "w2.txt", mime_type: "text/plain", content: "v1" })
    ).out as { id: string; name: string };
    expect(created.name).toBe("w2.txt");

    expect(
      ((await call("drive_read", { id: created.id })).out as { content: string }).content,
    ).toBe("v1");

    const updated = (
      await call("drive_update", { id: created.id, name: "w2-final.txt", content: "v2" })
    ).out as { name: string };
    expect(updated.name).toBe("w2-final.txt");
    expect(
      ((await call("drive_read", { id: created.id })).out as { content: string }).content,
    ).toBe("v2");

    const copy = (await call("drive_copy", { id: created.id, name: "w2-copy.txt" })).out as {
      id: string;
      name: string;
    };
    expect(copy.name).toBe("w2-copy.txt");

    const trashed = (await call("drive_trash", { id: created.id })).out as { trashed: boolean };
    expect(trashed.trashed).toBe(true);
    let found = (await call("drive_search", { query: "name contains 'w2-final'" })).out
      ?.files as unknown[];
    expect(found).toHaveLength(0);
    found = (
      await call("drive_search", { query: "name contains 'w2-final'", include_trashed: true })
    ).out?.files as unknown[];
    expect(found).toHaveLength(1);

    const untrashed = (await call("drive_untrash", { id: created.id })).out as { trashed: boolean };
    expect(untrashed.trashed).toBe(false);

    const gone = (await call("drive_delete_forever", { id: copy.id })).out as { deleted: boolean };
    expect(gone.deleted).toBe(true);
    const after = await call("drive_get_metadata", { id: copy.id });
    expect(after.isError).toBe(true);
    expect(after.text).toContain("404");
  });

  test("drive_update moves files between folders", async () => {
    const folder = (
      await call("drive_create", {
        name: "archive",
        mime_type: "application/vnd.google-apps.folder",
      })
    ).out as { id: string };
    const moved = (
      await call("drive_update", {
        id: "f-txt",
        add_parent_id: folder.id,
        remove_parent_id: "root",
      })
    ).out as { parents: string[] };
    expect(moved.parents).toEqual([folder.id]);
    const inFolder = (await call("drive_search", { query: `'${folder.id}' in parents` })).out
      ?.files as Array<{ id: string }>;
    expect(inFolder.map((f) => f.id)).toEqual(["f-txt"]);
  });

  test("unknown file is a tool error carrying Google's message", async () => {
    const res = await call("drive_read", { id: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("404");
  });
});
