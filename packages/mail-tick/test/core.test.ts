/**
 * The pure core: the search query, the strict schemas, defensive parsing
 * of both model stages, the disposition table as parseTriage applies it,
 * the propose arguments, label batching, and the label hard limit.
 */

import { describe, expect, test } from "bun:test";
import {
  assertLabelChange,
  breadcrumb,
  EXTRACT_SCHEMA,
  extractRequest,
  type Header,
  labelBatches,
  looksAutomated,
  parseExtract,
  parseTriage,
  proposeArgs,
  searchQuery,
  TRIAGE_SCHEMA,
  triageRequest,
} from "../src/core.ts";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const h = (over: Partial<Header> = {}): Header => ({
  id: "m1",
  thread_id: "t1",
  from: "LEARN <noreply@learn.invalid>",
  subject: "A3 posted",
  snippet: "Assignment 3 is due Friday",
  internal_date: T0,
  label_ids: ["INBOX", "UNREAD"],
  ...over,
});
const ctx = { account: "g-test", lanes: ["uw", "uw/learn", "news"], today: "2026-10-28" };

describe("search", () => {
  test("inbox plus lanes, minus the marker and the slop categories, bounded by the window", () => {
    expect(searchQuery({ lanes: [], marker: null, window: "3d" })).toBe(
      "in:inbox -category:promotions -category:social -category:forums newer_than:3d",
    );
    expect(searchQuery({ lanes: ["uw", "job apps"], marker: "brain/triaged", window: "2d" })).toBe(
      "(in:inbox OR label:uw OR label:job-apps) -label:brain/triaged -category:promotions -category:social -category:forums newer_than:2d",
    );
  });
});

describe("strict schemas", () => {
  const strict = (schema: unknown) => {
    const s = schema as {
      required: string[];
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
  };
  test("every property is required and optionals are nullable (OpenAI strict mode)", () => {
    strict(TRIAGE_SCHEMA);
    strict(
      (TRIAGE_SCHEMA as unknown as { properties: { verdicts: { items: unknown } } }).properties
        .verdicts.items,
    );
    strict(EXTRACT_SCHEMA);
    const item = (
      EXTRACT_SCHEMA as unknown as {
        properties: { items: { items: { properties: Record<string, { type: unknown }> } } };
      }
    ).properties.items.items;
    strict(item);
    expect(item.properties.due_date?.type).toEqual(["string", "null"]);
    expect(item.properties.matches_existing?.type).toEqual(["string", "null"]);
  });
});

describe("triage", () => {
  test("the request carries the rubric, the lanes, the date, and header rows without bodies", () => {
    const req = triageRequest("m", [h()], { ...ctx, hint: "the university account" });
    expect(req.effort).toBe("low");
    expect(req.responseSchema).toBe(TRIAGE_SCHEMA);
    const sys = req.messages[0]?.content ?? "";
    expect(sys).toContain("subscription");
    expect(sys).toContain("uw/learn");
    expect(sys).toContain("the university account");
    expect(sys).toContain("2026-10-28");
    expect(req.messages[1]?.content).toContain('"subject":"A3 posted"');
  });

  test("parses by index; malformed rows and unknown lanes degrade to none / unsure / keep", () => {
    const hs = [h(), h({ id: "m2" }), h({ id: "m3" })];
    const vs = parseTriage(
      {
        verdicts: [
          {
            i: 0,
            kind: "university",
            actionable: true,
            sender: "automated",
            lane: "uw/learn",
            disposition: "keep",
            reason: "actionable",
          },
          {
            i: 1,
            kind: "chore",
            actionable: "yes",
            sender: "robot",
            lane: "made-up",
            disposition: "archive",
            reason: "marketing",
          },
          {
            i: 7,
            kind: "job",
            actionable: true,
            sender: "automated",
            lane: null,
            disposition: "keep",
            reason: "actionable",
          },
        ],
      },
      hs,
      ctx.lanes,
    );
    expect(vs).toHaveLength(3);
    expect(vs[0]).toMatchObject({
      kind: "university",
      actionable: true,
      lane: "uw/learn",
      disposition: "keep",
    });
    expect(vs[1]).toMatchObject({
      kind: "none",
      actionable: false,
      sender: "unsure",
      lane: null,
      disposition: "keep",
    });
    expect(vs[2]).toMatchObject({ i: 2, kind: "none", disposition: "keep", reason: "unsure" });
    expect(parseTriage(null, hs, ctx.lanes).every((v) => v.disposition === "keep")).toBe(true);
  });

  test("the disposition table: archive only for automated, non-actionable, with a lane or a slop reason; never for people or unsure", () => {
    const row = (over: Record<string, unknown>) =>
      parseTriage(
        {
          verdicts: [
            {
              i: 0,
              kind: "none",
              actionable: false,
              sender: "automated",
              lane: null,
              disposition: "archive",
              reason: "marketing",
              ...over,
            },
          ],
        },
        [h()],
        ctx.lanes,
      )[0]?.disposition;
    expect(row({})).toBe("archive");
    expect(row({ lane: "news", reason: "fyi" })).toBe("keep"); // fyi never archives
    expect(row({ lane: "news", reason: "digest" })).toBe("archive");
    expect(row({ reason: "unsure" })).toBe("keep");
    expect(row({ sender: "person" })).toBe("keep");
    expect(row({ sender: "unsure" })).toBe("keep");
    expect(row({ kind: "job", actionable: true, reason: "actionable" })).toBe("keep");
    expect(row({ lane: null, reason: "fyi" })).toBe("keep");
  });

  test("looksAutomated: the mechanical sender signal", () => {
    expect(looksAutomated(h())).toBe(true);
    expect(looksAutomated(h({ from: "Shopify Recruiting <no-reply@shopify.invalid>" }))).toBe(true);
    expect(looksAutomated(h({ from: "Ada Lovelace <ada@example.invalid>" }))).toBe(false);
    // The address decides, anchored on the local part — not the display name, not a substring.
    expect(looksAutomated(h({ from: "Announcements Committee <jane@example.invalid>" }))).toBe(
      false,
    );
    expect(looksAutomated(h({ from: "Pat Digest <pat@example.invalid>" }))).toBe(false);
    expect(looksAutomated(h({ from: "agnews@example.invalid" }))).toBe(false);
    expect(looksAutomated(h({ from: "news@example.invalid" }))).toBe(true);
    expect(looksAutomated(h({ from: "Piazza <no-reply@piazza.invalid>" }))).toBe(true);
    expect(looksAutomated(h({ from: "cs348-list@uw.invalid" }))).toBe(true);
    expect(looksAutomated(h({ from: "Careers <careers-noreply@shopify.invalid>" }))).toBe(true);
    expect(looksAutomated(h({ from: undefined }))).toBe(false);
  });
});

describe("extract", () => {
  test("the request carries the capped body, the existing titles and pending entities", () => {
    const req = extractRequest("m", h(), "x".repeat(7000), ctx, {
      openTasks: [{ id: "t1", title: "Pay tuition" }],
      pending: [{ id: "p1", title: "CS 348 A3 due", entity: "cs348 a3" }],
    });
    expect(req.messages[0]?.content).toContain("t1: Pay tuition");
    expect(req.messages[0]?.content).toContain("(entity: cs348 a3)");
    const user = req.messages[1]?.content ?? "";
    expect(user).toContain("[truncated]");
    expect(user.length).toBeLessThan(6400);
    expect(req.responseSchema).toBe(EXTRACT_SCHEMA);
  });

  test("parses defensively: bad kinds, empty entities, bad dates drop or null out", () => {
    const items = parseExtract({
      items: [
        {
          title: "CS 348 A3 due",
          kind: "university",
          entity: "cs348 a3",
          due_date: "2026-11-06",
          due_time: "23:59",
          notes: "Crowdmark",
          keywords: ["cs348", "a3"],
          confidence: 0.9,
          matches_existing: null,
        },
        {
          title: "",
          kind: "job",
          entity: "x",
          due_date: null,
          due_time: null,
          notes: "",
          keywords: [],
          confidence: 1,
          matches_existing: null,
        },
        {
          title: "bad kind",
          kind: "chore",
          entity: "x",
          due_date: null,
          due_time: null,
          notes: "",
          keywords: [],
          confidence: 1,
          matches_existing: null,
        },
        {
          title: "no entity",
          kind: "job",
          entity: "!!",
          due_date: null,
          due_time: null,
          notes: "",
          keywords: [],
          confidence: 1,
          matches_existing: null,
        },
        {
          title: "bad date",
          kind: "subscription",
          entity: "netflix",
          due_date: "next friday",
          due_time: "25:00",
          notes: 5,
          keywords: "x",
          confidence: 7,
          matches_existing: "  ",
        },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ due_date: "2026-11-06", due_time: "23:59", confidence: 0.9 });
    expect(items[1]).toMatchObject({
      title: "bad date",
      due_date: null,
      due_time: null,
      notes: "",
      keywords: [],
      confidence: 1,
      matches_existing: null,
    });
    expect(parseExtract(undefined)).toEqual([]);
  });
});

describe("propose arguments", () => {
  test("keys, source without a link, the breadcrumb first in the notes, dates the tasks server reads", () => {
    const args = proposeArgs(
      "g-test",
      h(),
      {
        title: "CS 348 A3 due",
        kind: "university",
        entity: "cs348 a3",
        due_date: "2026-11-06",
        due_time: null,
        notes: "Crowdmark upload",
        keywords: ["cs348", "a3"],
        confidence: 0.8,
        matches_existing: null,
      },
      "America/Toronto",
    );
    expect(args).toMatchObject({
      dedupe_key: "gmail:g-test:m1",
      thread_key: "gmail:g-test:t1",
      due_at: "2026-11-06",
      confidence: 0.8,
      source: { kind: "gmail", account: "g-test", subject: "A3 posted", received_at: T0 },
    });
    expect(JSON.stringify(args)).not.toContain("http");
    expect(args.notes).toBe(
      'from LEARN <noreply@learn.invalid> on g-test · "A3 posted" · 2026-10-28\nCrowdmark upload\nkeywords: cs348, a3',
    );
    const timed = proposeArgs(
      "g-test",
      h({ thread_id: undefined }),
      {
        title: "x",
        kind: "job",
        entity: "e",
        due_date: "2026-11-06",
        due_time: "09:30",
        notes: "",
        keywords: [],
        confidence: 1,
        matches_existing: null,
      },
      "UTC",
    );
    expect(timed.due_at).toBe("2026-11-06T09:30");
    expect(timed.thread_key).toBeUndefined();
    expect(breadcrumb("g-test", h({ internal_date: undefined, from: undefined }), "UTC")).toBe(
      'from unknown sender on g-test · "A3 posted"',
    );
  });
});

describe("labels", () => {
  test("batches group identical changes, cap at 50, and skip no-ops", () => {
    const changes = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, add: ["L1"], remove: [] })),
      { id: "b", add: ["L1", "L2"], remove: ["INBOX"] },
      { id: "c", add: ["L2", "L1"], remove: ["INBOX"] },
      { id: "d", add: [], remove: [] },
    ];
    const b = labelBatches(changes);
    expect(b).toHaveLength(3);
    expect(b[0]?.message_ids).toHaveLength(50);
    expect(b[1]?.message_ids).toHaveLength(10);
    expect(b[2]).toEqual({
      message_ids: ["b", "c"],
      add_label_ids: ["L1", "L2"],
      remove_label_ids: ["INBOX"],
    });
  });

  test("the hard limit: remove only INBOX, add only allowed ids", () => {
    const allowed = new Set(["L1", "Label_9"]);
    expect(() =>
      assertLabelChange({ add_label_ids: ["L1"], remove_label_ids: ["INBOX"] }, allowed),
    ).not.toThrow();
    expect(() =>
      assertLabelChange({ add_label_ids: [], remove_label_ids: ["UNREAD"] }, allowed),
    ).toThrow(/only INBOX/);
    expect(() =>
      assertLabelChange({ add_label_ids: ["SPAM"], remove_label_ids: [] }, allowed),
    ).toThrow(/system label/);
    expect(() =>
      assertLabelChange({ add_label_ids: ["TRASH"], remove_label_ids: [] }, allowed),
    ).toThrow();
  });
});
