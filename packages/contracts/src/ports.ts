/**
 * Ports (§3): interfaces declared by core, implemented by adapters. Core
 * never names a vendor — a dependency-cruiser rule fails CI if core or
 * contracts imports an adapter or cloud SDK. For a single box you need only
 * the local column: secrets-file, queue-sqlite, object-fs, embedder-null.
 */

import type { EpisodeEnvelope, TrustTier } from "./episode.ts";
import type { ToolKind } from "./policy.ts";

/**
 * Core has no clock (§8.2) — time is injected so traversal, packing, and
 * recency scoring are deterministic and unit-testable.
 */
export interface Clock {
  now(): Date;
}

/** Envelope-encrypted at rest in every real adapter (§4.3). Keys are opaque names. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

/**
 * Lease-based single-consumer queue — what makes the single-writer
 * consolidator hold under crashes (§5.7). A leased item invisible to other
 * consumers until acked, nacked, or lease expiry; `attempt` drives the
 * max-3-backoff rule.
 */
export interface Queue<T> {
  enqueue(item: T): Promise<string>;
  lease(count: number, leaseMs: number): Promise<Array<LeasedItem<T>>>;
  ack(leaseId: string): Promise<void>;
  /** Return to the queue for retry after delayMs. */
  nack(leaseId: string, delayMs?: number): Promise<void>;
}

export interface LeasedItem<T> {
  leaseId: string;
  item: T;
  /** 1 on first delivery. */
  attempt: number;
}

export interface ObjectStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/**
 * §1: no embedding model — BM25 + graph traversal, no vectors, no network
 * call in the retrieval path. This port exists so `brain eval` can settle
 * the question empirically; the default wiring is null (embedder absent),
 * and consumers must handle that as the normal case.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Reasoning effort is the cost lever, not the model (§5.8): consolidation
 * runs the same model at medium effort via batch, chat runs high.
 */
export type ReasoningEffort = "low" | "medium" | "high";

export interface CompletionRequest {
  /** Logical model name; the adapter maps it to a vendor id. */
  model: string;
  effort?: ReasoningEffort;
  messages: ChatMessage[];
  /** JSON Schema for structured output; when set, adapters must return `parsed`. */
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface CompletionResult {
  content: string;
  /** Present iff responseSchema was set and the model complied. */
  parsed?: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/** The one seam between this system and any model vendor (§6.0). */
export interface ModelClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

// ── Batch transport (§5.8: everything background is batched — flat 50% off) ──

export interface BatchItem {
  /** Caller-chosen id, unique within the batch; results key off it. */
  customId: string;
  request: CompletionRequest;
}

export interface BatchItemResult {
  customId: string;
  ok: boolean;
  /** Present iff ok. Same shape a sync complete() would have returned. */
  result?: CompletionResult;
  error?: string;
}

export type BatchStatus =
  | { status: "running" }
  | { status: "complete"; items: BatchItemResult[] }
  /** The whole batch failed or expired — items were never attempted. */
  | { status: "failed"; error: string };

/**
 * Async batch transport (P5, §12 Q4). submit returns a provider batch id;
 * poll is cheap and non-blocking — the consolidation cadence calls it each
 * cycle until the batch lands (most within an hour, 24h ceiling).
 */
export interface BatchModelClient extends ModelClient {
  submitBatch(items: BatchItem[]): Promise<string>;
  pollBatch(batchId: string): Promise<BatchStatus>;
}

// ── Surfaces (§6.1) ────────────────────────────────────────────────────────

export interface InboundMessage {
  surfaceId: string;
  conversationId: string;
  /** Surface-native user id, checked against the allowlist by the router. */
  userId: string;
  text: string;
  ts: string;
  /** Surface-native payload, for adapters that need more than text. */
  raw?: unknown;
}

export interface OutboundMessage {
  text: string;
}

export interface ConfirmPreview {
  title: string;
  /** Human-readable preview of what will happen (§4.4). */
  body: string;
  risk: ToolKind;
}

export interface SurfaceContext {
  onInbound(h: (m: InboundMessage) => Promise<void>): void;
  send(conversationId: string, m: OutboundMessage): Promise<void>;
  /** Surface-native confirmation UX — Discord buttons, CLI prompt, WhatsApp reply-keyword. */
  requestConfirmation(conversationId: string, p: ConfirmPreview): Promise<boolean>;
  /** Surface-native way to hand the user an OAuth link. */
  presentAuthLink(conversationId: string, url: string, label: string): Promise<void>;
}

export interface SurfaceAdapter {
  readonly id: string;
  readonly defaultTrust: TrustTier;
  start(ctx: SurfaceContext): Promise<void>;
  stop(): Promise<void>;
}

// ── Harnesses (§6.4) ───────────────────────────────────────────────────────

export interface InstallConfig {
  gatewayUrl: string;
  /** Where to write harness-native config (e.g. the Claude Code project dir). */
  targetDir: string;
}

export interface InstallResult {
  filesWritten: string[];
  notes: string[];
}

/**
 * A harness is anything that runs an agent loop. It needs exactly two
 * things: an MCP endpoint, and a way to emit episodes.
 */
export interface HarnessAdapter {
  readonly id: string;
  /** Write whatever config/hooks this harness needs to talk to the gateway. */
  install(cfg: InstallConfig): Promise<InstallResult>;
  /** Convert this harness's native transcript into the canonical envelope. */
  normalizeEpisode(raw: unknown): EpisodeEnvelope;
}
