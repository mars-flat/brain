/**
 * The Batch API transport (§12 Q4): JSONL of /v1/responses bodies up,
 * per-line results down, same parsing as the sync path. Against a fake
 * OpenAI server — the real one is exercised by `brain consolidate --batch`
 * on the VM.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CompletionRequest } from "@brain/contracts";
import { OpenAiModelClient } from "../src/index.ts";

const PORT = 18851;

let server: ReturnType<typeof Bun.serve>;
let uploadedJsonl = "";
let batchStatus = "validating";

const RESPONSE_BODY = {
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: '{"candidates":[]}' }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
};

beforeAll(() => {
  server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/v1/files") {
        const form = await req.formData();
        uploadedJsonl = await (form.get("file") as File).text();
        expect(form.get("purpose")).toBe("batch");
        return Response.json({ id: "file_in" });
      }
      if (req.method === "POST" && path === "/v1/batches") {
        const body = (await req.json()) as Record<string, unknown>;
        expect(body.input_file_id).toBe("file_in");
        expect(body.endpoint).toBe("/v1/responses");
        return Response.json({ id: "batch_abc", status: "validating" });
      }
      if (path === "/v1/batches/batch_abc") {
        return Response.json({
          id: "batch_abc",
          status: batchStatus,
          ...(batchStatus === "completed"
            ? { output_file_id: "file_out", error_file_id: "file_err" }
            : {}),
        });
      }
      if (path === "/v1/files/file_out/content") {
        return new Response(
          `${JSON.stringify({
            custom_id: "ep_one",
            response: { status_code: 200, body: RESPONSE_BODY },
          })}\n`,
        );
      }
      if (path === "/v1/files/file_err/content") {
        return new Response(
          `${JSON.stringify({
            custom_id: "ep_two",
            error: { message: "server had a bad day" },
          })}\n`,
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

const REQ: CompletionRequest = {
  model: "gpt-5.6-luna",
  effort: "medium",
  messages: [
    { role: "system", content: "extract" },
    { role: "user", content: "episode text" },
  ],
  responseSchema: { type: "object" },
};

describe("OpenAI Batch API transport", () => {
  test("upload and create are separate calls (§5.8 staging); poll follows the lifecycle", async () => {
    const client = new OpenAiModelClient("key", `http://127.0.0.1:${PORT}/v1`);
    const uploadId = await client.uploadBatch([
      { customId: "ep_one", request: REQ },
      { customId: "ep_two", request: REQ },
    ]);
    expect(uploadId).toBe("file_in");
    const batchId = await client.createBatch(uploadId);
    expect(batchId).toBe("batch_abc");

    const lines = uploadedJsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].custom_id).toBe("ep_one");
    expect(lines[0].url).toBe("/v1/responses");
    expect(lines[0].body.model).toBe("gpt-5.6-luna");
    expect(lines[0].body.reasoning).toEqual({ effort: "medium" });
    expect(lines[0].body.text.format.type).toBe("json_schema");
    // system → developer, same as the sync path.
    expect(lines[0].body.input[0].role).toBe("developer");

    expect(await client.pollBatch("batch_abc")).toEqual({ status: "running" });
    batchStatus = "in_progress";
    expect(await client.pollBatch("batch_abc")).toEqual({ status: "running" });

    batchStatus = "completed";
    const done = await client.pollBatch("batch_abc");
    if (done.status !== "complete") throw new Error(`expected complete, got ${done.status}`);
    const byId = new Map(done.items.map((i) => [i.customId, i]));
    expect(byId.get("ep_one")?.ok).toBe(true);
    expect(byId.get("ep_one")?.result?.parsed).toEqual({ candidates: [] });
    expect(byId.get("ep_one")?.result?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(byId.get("ep_two")?.ok).toBe(false);
    expect(byId.get("ep_two")?.error).toContain("bad day");
  });

  test("a terminal non-completed batch reports failed", async () => {
    const client = new OpenAiModelClient("key", `http://127.0.0.1:${PORT}/v1`);
    await client.createBatch(await client.uploadBatch([{ customId: "ep_one", request: REQ }]));
    batchStatus = "expired";
    const s = await client.pollBatch("batch_abc");
    expect(s.status).toBe("failed");
    batchStatus = "completed"; // restore for any later test
  });
});
