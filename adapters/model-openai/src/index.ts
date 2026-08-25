/**
 * ModelClient (§3, §5.8) over the OpenAI Responses API. Plain fetch — the
 * MCP SDK argument doesn't apply here and an SDK would be the only reason
 * this adapter has a dependency tree. Synchronous requests for now; the
 * Batch API is a deploy-phase cost optimization (§5.8 — flat 50% off,
 * 24h ceiling), pointless for an interactive dev loop.
 *
 * Structured outputs use strict json_schema, so a malformed extraction is
 * rejected at the API layer rather than hand-parsed and hoped about (§7).
 */

import type { CompletionRequest, CompletionResult, ModelClient } from "@brain/contracts";

export class OpenAiModelClient implements ModelClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
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

    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      throw new Error(`OpenAI responses API ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      output?: Array<{
        type: string;
        content?: Array<{ type: string; text?: string }>;
      }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const message = data.output?.find((o) => o.type === "message");
    const text =
      message?.content?.find((c) => c.type === "output_text")?.text ??
      message?.content?.[0]?.text ??
      "";

    let parsed: unknown;
    if (req.responseSchema && text) {
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
}
