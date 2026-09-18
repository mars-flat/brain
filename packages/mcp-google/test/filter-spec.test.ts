/**
 * The filter spec is pure (§8.2): parse rejects every malformed shape with a
 * named reason, the plan is idempotent against an account that already has
 * the filters, and label placeholders resolve once labels exist.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backfillQuery,
  parseFilterSpec,
  planFilters,
  resolveLabelIds,
  SpecError,
  specLabels,
} from "../src/filter-spec.ts";
import type { MailFilter } from "../src/gmail.ts";

const example = () =>
  parseFilterSpec(
    Bun.YAML.parse(
      readFileSync(
        join(
          import.meta.dir,
          "../../../examples/vault-example/config/gmail-filters/g-example.yaml",
        ),
        "utf8",
      ),
    ),
  );

describe("parseFilterSpec", () => {
  test("the example vault spec parses with its labels in first-use order", () => {
    const spec = example();
    expect(spec.account).toBe("g-example");
    expect(spec.rules).toHaveLength(5);
    expect(specLabels(spec)).toEqual(["school", "school/forum", "school/lms", "news"]);
  });

  test.each([
    [{}, /account/],
    [{ account: "x", rules: [] }, /non-empty/],
    [{ account: "x", rules: [{ query: "a" }] }, /name is required/],
    [{ account: "x", rules: [{ name: "r", label: "l" }] }, /query is required/],
    [{ account: "x", rules: [{ name: "r", query: "a" }] }, /needs a label/],
    [{ account: "x", rules: [{ name: "r", query: "a", label: "INBOX" }] }, /system label/],
    [{ account: "x", rules: [{ name: "r", query: "a", label: "l", forward: "x" }] }, /unknown key/],
    [
      {
        account: "x",
        rules: [
          { name: "r", query: "a", label: "l" },
          { name: "r", query: "b", label: "l" },
        ],
      },
      /duplicate/,
    ],
  ])("rejects %j", (doc, re) => {
    expect(() => parseFilterSpec(doc)).toThrow(SpecError);
    expect(() => parseFilterSpec(doc)).toThrow(re);
  });
});

describe("planFilters", () => {
  const labels = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "school", type: "user" },
    { id: "Label_2", name: "news", type: "user" },
  ];

  test("missing labels become placeholders; nothing exists yet → every rule is a create", () => {
    const plan = planFilters(example(), labels, []);
    expect(plan.createLabels).toEqual(["school/forum", "school/lms"]);
    expect(plan.filters.every((f) => !f.existing)).toBe(true);
    const digest = plan.filters.find((f) => f.rule.name === "school/forum digests");
    expect(digest?.action).toEqual({
      add_label_ids: ["name:school/forum"],
      remove_label_ids: ["INBOX"],
    });
    const promo = plan.filters.find((f) => f.rule.name === "promotions");
    expect(promo?.action).toEqual({ remove_label_ids: ["INBOX"] });
    expect(plan.unmanaged).toEqual([]);
  });

  test("an identical existing filter is recognised once, extras are reported not deleted", () => {
    const spec = example();
    const existing: MailFilter[] = [
      {
        id: "f1",
        criteria: { query: "from:(newsletter.invalid OR digest.invalid)" },
        action: { add_label_ids: ["Label_2"], remove_label_ids: ["INBOX"] },
      },
      {
        id: "f2",
        criteria: { query: "from:(newsletter.invalid OR digest.invalid)" },
        action: { add_label_ids: ["Label_2"], remove_label_ids: ["INBOX"] },
      },
      {
        id: "f3",
        criteria: { from: "boss@example.invalid" },
        action: { add_label_ids: ["Label_1"] },
      },
    ];
    const plan = planFilters(spec, labels, existing);
    const news = plan.filters.find((f) => f.rule.name === "newsletters");
    expect(news?.existing).toBe("f1");
    expect(plan.unmanaged.map((f) => f.id)).toEqual(["f2", "f3"]);
  });

  test("resolveLabelIds swaps placeholders and refuses a label that never appeared", () => {
    const plan = planFilters(example(), labels, []);
    const after = resolveLabelIds(plan, [
      ...labels,
      { id: "Label_3", name: "school/forum", type: "user" },
      { id: "Label_4", name: "school/lms", type: "user" },
    ]);
    expect(after.filters.find((f) => f.rule.name === "school/lms announcements")?.action).toEqual({
      add_label_ids: ["Label_4"],
    });
    expect(() => resolveLabelIds(plan, labels)).toThrow(/still missing/);
  });

  test("backfill windows the rule's own query", () => {
    expect(backfillQuery({ name: "r", query: "from:x.invalid", label: "l" }, "30d")).toBe(
      "from:x.invalid newer_than:30d",
    );
  });
});
