/**
 * One tick against a scripted gateway and a scripted model: three mails
 * (a university announcement, a receipt, a newsletter) plus one from a
 * person → two proposals, the marker on every message, the newsletter
 * archived when organize is on and never when it is off, the person's mail
 * never filed, a second tick scanning nothing, the cap, dry-run writing
 * nothing, and a failure before the marker leaving mail unmarked.
 */

import { describe, expect, test } from "bun:test";
import type { CompletionRequest, CompletionResult, ModelClient } from "@brain/contracts";
import type { Header } from "../src/core.ts";
import type { ServerInfo, ToolCaller } from "../src/gateway.ts";
import { type AccountSummary, runTick } from "../src/tick.ts";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);

interface FakeMail extends Header {
  body: string;
}

/** A tiny in-memory Gmail + tasks behind a ToolCaller, recording every write. */
class FakeGateway implements ToolCaller {
  calls: Array<{ urn: string; args: Record<string, unknown> }> = [];
  proposals: Array<Record<string, unknown>> = [];
  labels = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "STARRED", name: "STARRED", type: "system" },
    { id: "L_uw", name: "uw", type: "user" },
    { id: "L_news", name: "news", type: "user" },
    { id: "L_mark", name: "brain/triaged", type: "user" },
    { id: "L_arch", name: "brain/archived", type: "user" },
  ];
  failPropose = false;
  constructor(
    public mail: Map<string, FakeMail>,
    public up: ServerInfo[] = [
      { name: "g-test", status: "up" },
      { name: "brain", status: "up" },
    ],
  ) {}
  async servers() {
    return this.up;
  }
  async call(urn: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ urn, args });
    switch (urn) {
      case "tasks.list":
        return { tasks: [{ id: "t1", title: "Pay tuition" }] };
      case "tasks.proposals":
        return { proposals: [] };
      case "tasks.propose": {
        if (this.failPropose) throw new Error("gateway down");
        const key = args.dedupe_key as string;
        const dup = this.proposals.find((p) => p.dedupe_key === key);
        if (dup) return { outcome: "duplicate", reason: "key" };
        this.proposals.push(args);
        return { outcome: "created", proposal: { id: `p${this.proposals.length}` } };
      }
      case "g-test.mail_list_labels":
        return { labels: this.labels };
      case "g-test.mail_search": {
        const q = args.query as string;
        const hits = [...this.mail.values()].filter(
          (m) => !(q.includes("-label:brain/triaged") && m.label_ids?.includes("L_mark")),
        );
        const page = Number(args.page_token ?? 0);
        const size = args.max_results as number;
        const slice = hits.slice(page * size, (page + 1) * size);
        return {
          results: slice.map(({ body: _b, ...h }) => h),
          ...(hits.length > (page + 1) * size ? { next_page_token: String(page + 1) } : {}),
        };
      }
      case "g-test.mail_get_message":
        return { body: { text: this.mail.get(args.id as string)?.body ?? "" } };
      case "g-test.mail_modify_labels": {
        for (const id of args.message_ids as string[]) {
          const m = this.mail.get(id) as FakeMail;
          const remove = (args.remove_label_ids as string[]) ?? [];
          m.label_ids = [
            ...new Set([
              ...(m.label_ids ?? []).filter((l) => !remove.includes(l)),
              ...((args.add_label_ids as string[]) ?? []),
            ]),
          ];
        }
        return {};
      }
      default:
        throw new Error(`unexpected urn ${urn}`);
    }
  }
}

/** A model that answers triage from the subject and extraction from the body. */
const fakeModel: ModelClient = {
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const user = req.messages[1]?.content ?? "";
    if (user.includes("Classify every message")) {
      const rows = JSON.parse(user.slice(user.indexOf("["))) as Array<{
        i: number;
        subject: string;
        from: string;
      }>;
      const verdicts = rows.map((r) => {
        if (/A3/.test(r.subject))
          return {
            i: r.i,
            kind: "university",
            actionable: true,
            sender: "automated",
            lane: "uw",
            disposition: "keep",
            reason: "actionable",
          };
        if (/receipt/i.test(r.subject))
          return {
            i: r.i,
            kind: "subscription",
            actionable: true,
            sender: "automated",
            lane: null,
            disposition: "keep",
            reason: "actionable",
          };
        if (/newsletter/i.test(r.subject))
          return {
            i: r.i,
            kind: "none",
            actionable: false,
            sender: "automated",
            lane: "news",
            disposition: "archive",
            reason: "digest",
          };
        if (/fees|maybe/i.test(r.subject))
          return {
            i: r.i,
            kind: "university",
            actionable: true,
            sender: "automated",
            lane: null,
            disposition: "keep",
            reason: "actionable",
          };
        if (/thursday/i.test(r.subject))
          return {
            i: r.i,
            kind: "job",
            actionable: true,
            sender: "person",
            lane: null,
            disposition: "keep",
            reason: "actionable",
          };
        return {
          i: r.i,
          kind: "none",
          actionable: false,
          sender: "unsure",
          lane: null,
          disposition: "keep",
          reason: "unsure",
        };
      });
      return { content: "", parsed: { verdicts }, usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const items = [];
    if (/A3/.test(user))
      items.push({
        title: "CS 348 A3 due",
        kind: "university",
        entity: "cs348 a3",
        due_date: "2026-11-06",
        due_time: null,
        notes: "Crowdmark",
        keywords: ["cs348"],
        confidence: 0.9,
        matches_existing: null,
      });
    if (/Netflix/.test(user))
      items.push({
        title: "review/cancel Netflix",
        kind: "subscription",
        entity: "netflix",
        due_date: "2026-11-15",
        due_time: null,
        notes: "",
        keywords: ["netflix"],
        confidence: 0.7,
        matches_existing: null,
      });
    if (/Thursday/.test(user))
      items.push({
        title: "Shopify interview — confirm Thursday",
        kind: "job",
        entity: "shopify interview",
        due_date: null,
        due_time: null,
        notes: "",
        keywords: [],
        confidence: 0.95,
        matches_existing: null,
      });
    if (/tuition/i.test(user))
      items.push({
        title: "Pay tuition",
        kind: "university",
        entity: "tuition",
        due_date: null,
        due_time: null,
        notes: "",
        keywords: [],
        confidence: 0.9,
        matches_existing: "t1",
      });
    if (/maybe/i.test(user))
      items.push({
        title: "low confidence thing",
        kind: "job",
        entity: "x",
        due_date: null,
        due_time: null,
        notes: "",
        keywords: [],
        confidence: 0.3,
        matches_existing: null,
      });
    return { content: "", parsed: { items }, usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

function inbox(): Map<string, FakeMail> {
  const m = (
    id: string,
    from: string,
    subject: string,
    body: string,
    extra: Partial<FakeMail> = {},
  ): [string, FakeMail] => [
    id,
    {
      id,
      thread_id: `t-${id}`,
      from,
      subject,
      snippet: body.slice(0, 40),
      internal_date: T0,
      label_ids: ["INBOX", "UNREAD"],
      body,
      ...extra,
    },
  ];
  return new Map([
    m(
      "m1",
      "LEARN <noreply@learn.invalid>",
      "A3 posted",
      "Assignment A3 is due Nov 6 on Crowdmark",
    ),
    m("m2", "Netflix <info@netflix.invalid>", "Your receipt", "Netflix renews Nov 15"),
    m("m3", "Weekly <newsletter@digest.invalid>", "The newsletter", "news news news"),
    m(
      "m4",
      "Ada Lovelace <ada@example.invalid>",
      "Thursday?",
      "Can you do the Shopify interview Thursday?",
    ),
  ]);
}

const base = (gw: FakeGateway, over: Partial<Parameters<typeof runTick>[0]> = {}) => ({
  gateway: gw,
  model: fakeModel,
  modelName: "fake",
  tz: "America/Toronto",
  window: "2d",
  dryRun: false,
  organize: true,
  capPerAccount: 20,
  log: () => {},
  now: () => T0,
  ...over,
});

const one = (s: AccountSummary[]) => s[0] as AccountSummary;

describe("one tick", () => {
  test("proposes from automated actionable mail and from a person's mail, archives the newsletter, marks everything, never files the person", async () => {
    const gw = new FakeGateway(inbox());
    const s = one(await runTick(base(gw)));
    expect(s).toMatchObject({
      scanned: 4,
      triagedIn: 3,
      extracted: 3,
      created: 3,
      marked: 4,
      archived: 1,
      labeled: 2,
    });
    expect(gw.proposals.map((p) => p.title)).toEqual([
      "CS 348 A3 due",
      "review/cancel Netflix",
      "Shopify interview — confirm Thursday",
    ]);
    expect(gw.proposals[0]).toMatchObject({
      dedupe_key: "gmail:g-test:m1",
      thread_key: "gmail:g-test:t-m1",
      due_at: "2026-11-06",
    });
    const labels = (id: string) => gw.mail.get(id)?.label_ids ?? [];
    expect(labels("m1")).toEqual(expect.arrayContaining(["INBOX", "L_mark", "L_uw"])); // actionable stays, laned
    expect(labels("m3")).toEqual(expect.arrayContaining(["L_mark", "L_news", "L_arch"]));
    expect(labels("m3")).not.toContain("INBOX");
    expect(labels("m3")).toContain("UNREAD"); // read-state untouched (Q21)
    expect(labels("m4")).toEqual(["INBOX", "UNREAD", "L_mark"]); // a person: marked, never laned or archived
    // The marker was applied after every propose, in batched calls, and every write was one of the two allowed tools.
    const writes = gw.calls.filter(
      (c) => c.urn === "tasks.propose" || c.urn === "g-test.mail_modify_labels",
    );
    const lastPropose = gw.calls.map((c) => c.urn).lastIndexOf("tasks.propose");
    const firstModify = gw.calls.map((c) => c.urn).indexOf("g-test.mail_modify_labels");
    expect(firstModify).toBeGreaterThan(lastPropose);
    expect(writes.length).toBe(
      gw.calls.filter(
        (c) =>
          !c.urn.endsWith("mail_search") &&
          !c.urn.endsWith("mail_get_message") &&
          !c.urn.endsWith("mail_list_labels") &&
          !c.urn.startsWith("tasks.list") &&
          !c.urn.startsWith("tasks.proposals"),
      ).length,
    );
    for (const c of gw.calls.filter((c) => c.urn === "g-test.mail_modify_labels")) {
      expect((c.args.remove_label_ids as string[]).every((l) => l === "INBOX")).toBe(true);
      expect((c.args.message_ids as string[]).length).toBeLessThanOrEqual(50);
    }
    // A second tick sees nothing: the marker excludes it all.
    const s2 = one(await runTick(base(gw)));
    expect(s2.scanned).toBe(0);
    expect(gw.proposals).toHaveLength(3);
  });

  test("organize off: proposals and the marker only, nothing laned or archived", async () => {
    const gw = new FakeGateway(inbox());
    const s = one(await runTick(base(gw, { organize: false })));
    expect(s).toMatchObject({ created: 3, marked: 4, archived: 0, labeled: 0 });
    expect(gw.mail.get("m3")?.label_ids).toEqual(["INBOX", "UNREAD", "L_mark"]);
  });

  test("a starred newsletter is laned but never archived; a model 'automated' on a human address is overridden", async () => {
    const mail = inbox();
    (mail.get("m3") as FakeMail).label_ids = ["INBOX", "STARRED"];
    (mail.get("m4") as FakeMail).subject = "The newsletter"; // the model will say automated/digest, the address says person
    const gw = new FakeGateway(mail);
    await runTick(base(gw));
    expect(gw.mail.get("m3")?.label_ids).toEqual(
      expect.arrayContaining(["INBOX", "STARRED", "L_news", "L_mark"]),
    );
    expect(gw.mail.get("m3")?.label_ids).not.toContain("L_arch");
    expect(gw.mail.get("m4")?.label_ids).toEqual(["INBOX", "UNREAD", "L_mark"]);
  });

  test("matches_existing is not proposed; low confidence is dropped; the cap holds; pages are walked", async () => {
    const mail = inbox();
    mail.set("m5", {
      id: "m5",
      thread_id: "t5",
      from: "Registrar <noreply@uw.invalid>",
      subject: "Fees due",
      body: "Pay tuition by Friday",
      internal_date: T0,
      label_ids: ["INBOX"],
    });
    mail.set("m6", {
      id: "m6",
      thread_id: "t6",
      from: "Jobs <noreply@jobs.invalid>",
      subject: "Maybe a thing",
      body: "maybe a thing",
      internal_date: T0,
      label_ids: ["INBOX"],
    });
    for (let i = 0; i < 30; i++)
      mail.set(`x${i}`, {
        id: `x${i}`,
        from: "noreply@x.invalid",
        subject: "nothing",
        body: "",
        internal_date: T0,
        label_ids: ["INBOX"],
      });
    const gw = new FakeGateway(mail);
    const s = one(await runTick(base(gw, { capPerAccount: 2 })));
    expect(s.pages).toBe(2); // 36 messages at 25 a page
    expect(s.matchedExisting).toBe(1);
    expect(s.droppedLow).toBe(1);
    expect(s.created).toBe(2);
    expect(s.capped).toBe(1);
    expect(gw.proposals).toHaveLength(2);
    // The capped message stays unmarked and comes back next tick; the matched one is marked and stays in the inbox.
    expect(s.unmarked).toBe(1);
    const capped = [...gw.mail.values()].find(
      (m) => !(m.label_ids ?? []).includes("L_mark") && m.label_ids?.includes("INBOX"),
    );
    expect(capped).toBeDefined();
    expect(gw.mail.get("m5")?.label_ids).toEqual(expect.arrayContaining(["INBOX", "L_mark"]));
    expect(gw.mail.get("m5")?.label_ids).not.toContain("L_arch");
    const again = one(await runTick(base(gw, { capPerAccount: 20 })));
    expect(again.scanned).toBe(1);
    expect(gw.proposals).toHaveLength(3);
  });

  test("a system label in the account's list never becomes addable; a display name cannot make a person automated", async () => {
    const mail = inbox();
    (mail.get("m3") as FakeMail).from = "Announcements Committee <jane@example.invalid>"; // model says digest/automated
    const gw = new FakeGateway(mail);
    gw.labels.push(
      { id: "SPAM", name: "SPAM", type: "system" },
      { id: "UNREAD", name: "UNREAD", type: "system" },
    );
    await runTick(base(gw));
    for (const c of gw.calls.filter((c) => c.urn === "g-test.mail_modify_labels"))
      expect((c.args.add_label_ids as string[]).some((l) => l === "SPAM" || l === "UNREAD")).toBe(
        false,
      );
    expect(gw.mail.get("m3")?.label_ids).toEqual(["INBOX", "UNREAD", "L_mark"]); // marked only
  });

  test("dry run writes nothing at all", async () => {
    const gw = new FakeGateway(inbox());
    const lines: string[] = [];
    const s = one(await runTick(base(gw, { dryRun: true, log: (l) => lines.push(l) })));
    expect(gw.proposals).toHaveLength(0);
    expect(gw.calls.some((c) => c.urn === "g-test.mail_modify_labels")).toBe(false);
    expect(s.created).toBe(3);
    expect(lines.some((l) => l.includes("would propose"))).toBe(true);
    expect(s.warnings.join()).toContain("dry run");
  });

  test("a failure before the marker leaves the mail unmarked for the next tick; the tick reports and goes on", async () => {
    const gw = new FakeGateway(inbox());
    gw.failPropose = true;
    const s = one(await runTick(base(gw)));
    expect(s.warnings.join()).toContain("stopped: gateway down");
    expect(gw.calls.some((c) => c.urn === "g-test.mail_modify_labels")).toBe(false);
    expect(gw.mail.get("m1")?.label_ids).not.toContain("L_mark");
  });

  test("no marker label: the tick warns and applies nothing, but still proposes", async () => {
    const gw = new FakeGateway(inbox());
    gw.labels = gw.labels.filter((l) => l.name !== "brain/triaged");
    const s = one(await runTick(base(gw, { organize: false })));
    expect(s.warnings.join()).toContain("brain/triaged");
    expect(s.created).toBe(3);
    expect(s.marked).toBe(0);
  });

  test("only g-* upstreams that are up are scanned; --account narrows", async () => {
    const gw = new FakeGateway(inbox(), [
      { name: "g-test", status: "up" },
      { name: "g-down", status: "down" },
      { name: "tasks", status: "up" },
    ]);
    expect((await runTick(base(gw))).map((s) => s.account)).toEqual(["g-test"]);
    expect(await runTick(base(new FakeGateway(inbox()), { only: ["g-other"] }))).toEqual([]);
  });
});
