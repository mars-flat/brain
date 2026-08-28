/**
 * The Google MCP server (§W2): one instance per account, mail = read +
 * label control (structurally no send/draft tools), Drive = full CRUD
 * with trash-first deletes. Uses the SDK's low-level Server API with
 * plain JSON Schemas so the advertised surface stays byte-controlled.
 *
 * Kind classification (§4.4) rides annotations: reads carry readOnlyHint,
 * drive_delete_forever carries destructiveHint (→ admin: step-up +
 * confirm); everything else falls to write → default-confirm.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  driveCopy,
  driveCreate,
  driveDeleteForever,
  driveGetMetadata,
  driveListRecent,
  driveRead,
  driveSearch,
  driveSetTrashed,
  driveUpdate,
} from "./drive.ts";
import {
  mailCreateLabel,
  mailGetMessage,
  mailGetThread,
  mailListLabels,
  mailModifyLabels,
  mailSearch,
} from "./gmail.ts";
import { GoogleApiError, GoogleClient, type GoogleClientOptions } from "./google.ts";

const VERSION = "0.1.0";

export interface GoogleServerOptions extends GoogleClientOptions {
  /** Owner short-name for the account (g-2k05 …) — lands in tool descriptions. */
  accountLabel: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const readOnly = { readOnlyHint: true };

function tools(label: string): ToolDef[] {
  const acct = `Google account ${label}`;
  return [
    {
      name: "mail_search",
      description: `Search Gmail (${acct}) with a standard Gmail query (from:, subject:, is:unread, newer_than:7d, …). Returns message summaries with headers and snippets.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search syntax" },
          max_results: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          label_ids: { type: "array", items: { type: "string" } },
          page_token: { type: "string" },
        },
        required: ["query"],
      },
      annotations: readOnly,
    },
    {
      name: "mail_get_message",
      description: `Read one Gmail message (${acct}) in full: headers plus the decoded text body.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      annotations: readOnly,
    },
    {
      name: "mail_get_thread",
      description: `Read a whole Gmail thread (${acct}): every message with its decoded body.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      annotations: readOnly,
    },
    {
      name: "mail_list_labels",
      description: `List Gmail labels (${acct}), system and user, with ids for mail_modify_labels.`,
      inputSchema: { type: "object", properties: {} },
      annotations: readOnly,
    },
    {
      name: "mail_create_label",
      description: `Create a Gmail label (${acct}) — a custom category to file mail under.`,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "mail_modify_labels",
      description: `Add/remove Gmail label ids on messages (${acct}). Archive = remove INBOX; spam = add SPAM; mark read = remove UNREAD; plus custom labels.`,
      inputSchema: {
        type: "object",
        properties: {
          message_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
          add_label_ids: { type: "array", items: { type: "string" } },
          remove_label_ids: { type: "array", items: { type: "string" } },
        },
        required: ["message_ids"],
      },
    },
    {
      name: "drive_search",
      description: `Search Drive (${acct}) with a files.list query (name contains '…', fullText contains '…', '<id>' in parents). Trashed files are excluded unless include_trashed.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Drive files.list q syntax" },
          max_results: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          order_by: { type: "string", description: "e.g. modifiedTime desc" },
          page_token: { type: "string" },
          include_trashed: { type: "boolean", default: false },
        },
      },
      annotations: readOnly,
    },
    {
      name: "drive_get_metadata",
      description: `Read one Drive file's metadata (${acct}): name, type, size, parents, trashed, link.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      annotations: readOnly,
    },
    {
      name: "drive_read",
      description: `Read a Drive file's content (${acct}). Google-native files export to text (Docs→markdown, Sheets→CSV); small binaries return base64.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          export_mime_type: { type: "string", description: "override the export format" },
        },
        required: ["id"],
      },
      annotations: readOnly,
    },
    {
      name: "drive_list_recent",
      description: `List recently modified Drive files (${acct}), newest first.`,
      inputSchema: {
        type: "object",
        properties: { max_results: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      },
      annotations: readOnly,
    },
    {
      name: "drive_create",
      description: `Create a Drive file or folder (${acct}). Text content inline; folders via mime_type application/vnd.google-apps.folder.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          mime_type: { type: "string" },
          content: { type: "string", description: "utf-8 text content" },
          parent_id: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "drive_update",
      description: `Update a Drive file (${acct}): replace content, rename, and/or move between folders.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string", description: "replacement utf-8 text content" },
          name: { type: "string", description: "new name" },
          add_parent_id: { type: "string" },
          remove_parent_id: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "drive_copy",
      description: `Copy a Drive file (${acct}), optionally renaming or into another folder.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          parent_id: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "drive_trash",
      description: `Move a Drive file to the trash (${acct}) — the default, reversible delete.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "drive_untrash",
      description: `Restore a Drive file from the trash (${acct}).`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "drive_delete_forever",
      description: `PERMANENTLY delete a Drive file (${acct}), bypassing the trash. Irreversible — prefer drive_trash.`,
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      annotations: { destructiveHint: true },
    },
  ];
}

export function buildGoogleServer(opts: GoogleServerOptions): Server {
  const g = new GoogleClient(opts);
  const TOOLS = tools(opts.accountLabel);

  const server = new Server(
    { name: `mcp-google-${opts.accountLabel}`, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const text = (payload: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload as Record<string, unknown>,
    });
    const str = (k: string) => String(args[k] ?? "");

    try {
      switch (req.params.name) {
        case "mail_search":
          return text(
            await mailSearch(g, {
              query: str("query"),
              max_results: args.max_results as number | undefined,
              label_ids: args.label_ids as string[] | undefined,
              page_token: args.page_token as string | undefined,
            }),
          );
        case "mail_get_message":
          return text(await mailGetMessage(g, str("id")));
        case "mail_get_thread":
          return text(await mailGetThread(g, str("id")));
        case "mail_list_labels":
          return text(await mailListLabels(g));
        case "mail_create_label":
          return text(await mailCreateLabel(g, str("name")));
        case "mail_modify_labels":
          return text(
            await mailModifyLabels(g, {
              message_ids: (args.message_ids as string[]) ?? [],
              add_label_ids: args.add_label_ids as string[] | undefined,
              remove_label_ids: args.remove_label_ids as string[] | undefined,
            }),
          );
        case "drive_search":
          return text(
            await driveSearch(g, {
              query: args.query as string | undefined,
              max_results: args.max_results as number | undefined,
              order_by: args.order_by as string | undefined,
              page_token: args.page_token as string | undefined,
              include_trashed: args.include_trashed === true,
            }),
          );
        case "drive_get_metadata":
          return text(await driveGetMetadata(g, str("id")));
        case "drive_read":
          return text(
            await driveRead(g, {
              id: str("id"),
              export_mime_type: args.export_mime_type as string | undefined,
            }),
          );
        case "drive_list_recent":
          return text(await driveListRecent(g, args.max_results as number | undefined));
        case "drive_create":
          return text(
            await driveCreate(g, {
              name: str("name"),
              mime_type: args.mime_type as string | undefined,
              content: args.content as string | undefined,
              parent_id: args.parent_id as string | undefined,
            }),
          );
        case "drive_update":
          return text(
            await driveUpdate(g, {
              id: str("id"),
              content: args.content as string | undefined,
              name: args.name as string | undefined,
              add_parent_id: args.add_parent_id as string | undefined,
              remove_parent_id: args.remove_parent_id as string | undefined,
            }),
          );
        case "drive_copy":
          return text(
            await driveCopy(g, {
              id: str("id"),
              name: args.name as string | undefined,
              parent_id: args.parent_id as string | undefined,
            }),
          );
        case "drive_trash":
          return text(await driveSetTrashed(g, str("id"), true));
        case "drive_untrash":
          return text(await driveSetTrashed(g, str("id"), false));
        case "drive_delete_forever":
          return text(await driveDeleteForever(g, str("id")));
        default:
          throw new Error(`unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      // API-shaped failures (quota, 404, revoked grant, size caps) are tool
      // results, not protocol crashes — the gateway relays them as-is.
      if (err instanceof GoogleApiError || (err instanceof Error && !(err instanceof TypeError)))
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          isError: true,
        };
      throw err;
    }
  });

  return server;
}
