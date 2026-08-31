/**
 * ModelClient (§3, §5.8) over the OpenAI Responses API. Plain fetch — the
 * MCP SDK argument doesn't apply here and an SDK would be the only reason
 * this adapter has a dependency tree.
 *
 * Structured outputs use strict json_schema, so a malformed extraction is
 * rejected at the API layer rather than hand-parsed and hoped about (§7).
 *
 * Batch (P5, §12 Q4): the same request shape rides /v1/batches — a JSONL
 * file of /v1/responses bodies, a poll, and a result file — for a flat
 * 50% discount on everything background. Upload and batch creation are
 * separate methods: OpenAI's batch backend lags file propagation and
 * fails whole batches whose input file the files API already serves as
 * "processed" (ongoing platform bug, hit 2026-08-28) — the §5.8 cadence
 * ages every upload one tick before creating its batch.
 */

import type {
  BatchItem,
  BatchItemResult,
  BatchModelClient,
  BatchStatus,
  CompletionRequest,
  CompletionResult,
  ModelClient,
} from "@brain/contracts";

interface ResponsesBody {
  output?: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function buildResponsesBody(req: CompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.messages.map((m) => ({
      role: m.role === "system" ? "developer" : m.role,
      content: m.content,
    })),
  };
  if (req.effort) body.reasoning = { effort: req.effort };
  if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
  if (req.responseSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "output",
        strict: true,
        schema: req.responseSchema,
      },
    };
  }
  return body;
}

function parseResponsesBody(data: ResponsesBody, expectJson: boolean): CompletionResult {
  const message = data.output?.find((o) => o.type === "message");
  const text =
    message?.content?.find((c) => c.type === "output_text")?.text ??
    message?.content?.[0]?.text ??
    "";

  let parsed: unknown;
  if (expectJson && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("model returned non-JSON despite strict json_schema format");
    }
  }
  return {
    content: text,
    ...(parsed !== undefined ? { parsed } : {}),
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    },
  };
}

export class OpenAiModelClient implements ModelClient, BatchModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(buildResponsesBody(req)),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`OpenAI responses API ${res.status}: ${detail}`);
    }
    return parseResponsesBody((await res.json()) as ResponsesBody, Boolean(req.responseSchema));
  }

  async uploadBatch(items: BatchItem[]): Promise<string> {
    const jsonl = items
      .map((i) =>
        JSON.stringify({
          custom_id: i.customId,
          method: "POST",
          url: "/v1/responses",
          body: buildResponsesBody(i.request),
        }),
      )
      .join("\n");

    const form = new FormData();
    form.set("purpose", "batch");
    form.set("file", new Blob([jsonl], { type: "application/jsonl" }), "batch.jsonl");
    const fileRes = await fetch(`${this.baseUrl}/files`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!fileRes.ok)
      throw new Error(
        `OpenAI file upload ${fileRes.status}: ${(await fileRes.text()).slice(0, 400)}`,
      );
    const file = (await fileRes.json()) as { id: string };
    return file.id;
  }

  async createBatch(uploadId: string): Promise<string> {
    const batchRes = await fetch(`${this.baseUrl}/batches`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        input_file_id: uploadId,
        endpoint: "/v1/responses",
        completion_window: "24h",
      }),
    });
    if (!batchRes.ok)
      throw new Error(
        `OpenAI batch create ${batchRes.status}: ${(await batchRes.text()).slice(0, 400)}`,
      );
    const batch = (await batchRes.json()) as { id: string };
    return batch.id;
  }

  async pollBatch(batchId: string): Promise<BatchStatus> {
    const res = await fetch(`${this.baseUrl}/batches/${batchId}`, { headers: this.headers() });
    if (!res.ok)
      throw new Error(`OpenAI batch poll ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const batch = (await res.json()) as {
      status: string;
      output_file_id?: string;
      error_file_id?: string;
      errors?: unknown;
    };

    if (["validating", "in_progress", "finalizing", "cancelling"].includes(batch.status))
      return { status: "running" };
    if (batch.status !== "completed")
      return {
        status: "failed",
        error: `batch ${batch.status}: ${JSON.stringify(batch.errors ?? {}).slice(0, 400)}`,
      };

    // Upload, create, and poll each run in a different cadence process, so
    // no per-item schema expectation survives to here. Extraction always
    // sets a schema, so every result is parsed as JSON; a non-JSON body
    // fails that item, same as the strict sync path would have.
    const items: BatchItemResult[] = [];
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) continue;
      const content = await fetch(`${this.baseUrl}/files/${fileId}/content`, {
        headers: this.headers(),
      });
      if (!content.ok)
        throw new Error(
          `OpenAI batch result fetch ${content.status}: ${(await content.text()).slice(0, 400)}`,
        );
      for (const line of (await content.text()).split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as {
          custom_id: string;
          response?: { status_code?: number; body?: ResponsesBody };
          error?: { message?: string } | null;
        };
        if (row.error || !row.response || (row.response.status_code ?? 500) >= 300) {
          items.push({
            customId: row.custom_id,
            ok: false,
            error:
              row.error?.message ??
              `item HTTP ${row.response?.status_code ?? "?"}: ${JSON.stringify(row.response?.body ?? {}).slice(0, 200)}`,
          });
          continue;
        }
        try {
          items.push({
            customId: row.custom_id,
            ok: true,
            result: parseResponsesBody(row.response.body ?? {}, true),
          });
        } catch (err) {
          items.push({
            customId: row.custom_id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return { status: "complete", items };
  }
}
