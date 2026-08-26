/**
 * §8.4: every rule with matching and non-matching inputs, plus
 * default-fallthrough — over the §4.5 spec example — and the composition
 * law: policy can only narrow the trust matrix.
 */

import { describe, expect, test } from "bun:test";
import type { PolicyDocument, PolicyEffect, ToolKind, TrustTier } from "@brain/contracts";
import { validatePolicy } from "@brain/contracts";
import fc from "fast-check";
import {
  decide,
  evaluatePolicy,
  globToRegExp,
  stricterEffect,
  trustMatrixEffect,
} from "../src/policy.ts";

const SPEC_POLICY: PolicyDocument = [
  { match: { tool: "brain.*", kind: "read" }, effect: "allow" },
  {
    match: { surface: ["discord"], kind: "write" },
    effect: "confirm",
    reason: "medium-trust surface, write operation",
  },
  { match: { surface: ["discord"], tool: ["shell.*", "fs.write", "*.delete_*"] }, effect: "deny" },
  { match: { kind: "read" }, effect: "allow" },
  { default: "confirm" },
];

const req = (over: Partial<Parameters<typeof evaluatePolicy>[1]> = {}) => ({
  urn: "github.issues.create",
  kind: "write" as ToolKind,
  surface: "cli",
  principal: "owner",
  trust: "high" as TrustTier,
  ...over,
});

describe("glob matching", () => {
  test("URN globs behave like §4.4/§4.5 expect", () => {
    expect(globToRegExp("brain.*").test("brain.recall")).toBe(true);
    expect(globToRegExp("brain.*").test("brainstorm.x")).toBe(false);
    expect(globToRegExp("*.delete_*").test("github.repos.delete_repo")).toBe(true);
    expect(globToRegExp("*.delete_*").test("github.repos.create")).toBe(false);
    expect(globToRegExp("shell.*").test("shell.exec")).toBe(true);
    expect(globToRegExp("fs.write").test("fs.write")).toBe(true);
    expect(globToRegExp("fs.write").test("fs.write_file")).toBe(false);
  });
});

describe("evaluatePolicy over the spec example", () => {
  test("the policy file validates", () => {
    expect(validatePolicy(SPEC_POLICY).ok).toBe(true);
  });

  test.each([
    // [description, request, effect, ruleIndex]
    ["brain read → rule 0 allow", req({ urn: "brain.recall", kind: "read" }), "allow", 0],
    [
      "brain WRITE misses rule 0 → default",
      req({ urn: "brain.note", kind: "write" }),
      "confirm",
      4,
    ],
    ["discord write → rule 1 confirm", req({ surface: "discord", kind: "write" }), "confirm", 1],
    [
      "discord shell read → rule 2 deny (write rule skipped, tool rule hits)",
      req({ surface: "discord", urn: "shell.exec", kind: "read" }),
      "deny",
      2,
    ],
    [
      "discord delete_* deny beats later read-allow",
      req({ surface: "discord", urn: "github.repos.delete_repo", kind: "read" }),
      "deny",
      2,
    ],
    ["cli read → rule 3 allow", req({ urn: "github.issues.list", kind: "read" }), "allow", 3],
    ["cli write falls through → default confirm", req(), "confirm", 4],
  ] as Array<[string, ReturnType<typeof req>, PolicyEffect, number]>)(
    "%s",
    (_desc, r, effect, ruleIndex) => {
      const d = evaluatePolicy(SPEC_POLICY, r);
      expect(d.effect).toBe(effect);
      expect(d.ruleIndex).toBe(ruleIndex);
      expect(d.isDefault).toBe(ruleIndex === 4);
    },
  );

  test("first match wins — rule order is load-bearing", () => {
    const reordered = [
      SPEC_POLICY[3],
      ...SPEC_POLICY.slice(0, 3),
      SPEC_POLICY[4],
    ] as PolicyDocument;
    // With the generic read-allow first, discord shell reads now ALLOW.
    const d = evaluatePolicy(
      reordered,
      req({ surface: "discord", urn: "shell.exec", kind: "read" }),
    );
    expect(d.effect).toBe("allow");
  });
});

describe("trust matrix and composition (§6.5, §4.3)", () => {
  test("the matrix matches the §6.5 table", () => {
    const cases: Array<[TrustTier, ToolKind, PolicyEffect]> = [
      ["high", "read", "allow"],
      ["high", "write", "allow"],
      ["high", "admin", "allow"],
      ["medium", "read", "allow"],
      ["medium", "write", "confirm"],
      ["medium", "admin", "deny"],
      ["low", "write", "confirm"],
      ["low", "admin", "deny"],
      ["untrusted", "read", "deny"],
    ];
    for (const [trust, kind, effect] of cases) expect(trustMatrixEffect(trust, kind)).toBe(effect);
  });

  test("composed effect is never more permissive than either layer", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TrustTier>("high", "medium", "low", "untrusted"),
        fc.constantFrom<ToolKind>("read", "write", "admin"),
        fc.constantFrom("brain.recall", "shell.exec", "github.repos.delete_repo", "fs.write"),
        fc.constantFrom("cli", "discord"),
        (trust, kind, urn, surface) => {
          const d = decide(SPEC_POLICY, req({ trust, kind, urn, surface }));
          const rank = { allow: 0, confirm: 1, deny: 2 };
          expect(rank[d.effect]).toBeGreaterThanOrEqual(rank[d.matrixEffect]);
          expect(rank[d.effect]).toBeGreaterThanOrEqual(rank[d.policyEffect]);
          expect(d.effect).toBe(stricterEffect(d.matrixEffect, d.policyEffect));
        },
      ),
      { numRuns: 200 },
    );
  });

  test("a policy allow cannot override a matrix deny — narrowing is one-way", () => {
    const permissive: PolicyDocument = [{ default: "allow" }];
    expect(decide(permissive, req({ trust: "medium", kind: "admin" })).effect).toBe("deny");
    expect(decide(permissive, req({ trust: "untrusted", kind: "read" })).effect).toBe("deny");
    expect(decide(permissive, req({ trust: "medium", kind: "write" })).effect).toBe("confirm");
  });
});
