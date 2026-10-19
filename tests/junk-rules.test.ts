import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  firstJunkRuleMatch,
  junkRuleMatches,
  usablePatterns,
  validateJunkRule,
  type JunkRule,
} from "@/lib/junk-rules/match";
import { decideDisposition, describeJunkReason } from "@/lib/inbound/junk";

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const rule = (over: Partial<JunkRule> = {}): JunkRule => ({
  id: "r1",
  name: "TRE",
  patterns: ["the running event", "tre 2026"],
  scope: "subject",
  reason: "trade-show spam",
  enabled: true,
  position: 0,
  ...over,
});

describe("the matcher is a case-insensitive substring over the scoped text", () => {
  it("matches a phrase in the subject, ignoring case", () => {
    const m = junkRuleMatches(rule(), { subject: "RE: The Running Event 2027", body: "" });
    expect(m.matched).toBe(true);
    expect(m.pattern).toBe("the running event");
  });

  it("subject scope does NOT look at the body", () => {
    const m = junkRuleMatches(rule({ scope: "subject" }), {
      subject: "Hello",
      body: "come to the running event",
    });
    expect(m.matched).toBe(false);
  });

  it("subject_body scope matches the body too", () => {
    const m = junkRuleMatches(rule({ scope: "subject_body" }), {
      subject: "Hello",
      body: "come to the running event",
    });
    expect(m.matched).toBe(true);
  });
});

describe("a rule with no usable patterns matches NOTHING", () => {
  // The single most dangerous bug this feature could ship: "" is a substring of
  // everything, so a blank pattern would junk the whole inbox on enable.
  it("empty list never matches", () => {
    expect(junkRuleMatches(rule({ patterns: [] }), { subject: "anything", body: "x" }).matched).toBe(false);
  });
  it("all-blank / whitespace patterns never match", () => {
    expect(junkRuleMatches(rule({ patterns: ["", "   ", "\t"] }), { subject: "anything", body: "x" }).matched).toBe(false);
    expect(usablePatterns(["", "  ", "the running event"])).toEqual(["the running event"]);
  });
});

describe("firstJunkRuleMatch respects order and enabled", () => {
  it("returns the first ENABLED rule that matches", () => {
    const rules = [
      rule({ id: "a", enabled: false, patterns: ["the running event"] }),
      rule({ id: "b", enabled: true, patterns: ["the running event"] }),
    ];
    const hit = firstJunkRuleMatch(rules, { subject: "the running event", body: "" });
    expect(hit?.rule.id).toBe("b");
  });
  it("returns null when nothing enabled matches", () => {
    const rules = [rule({ enabled: false })];
    expect(firstJunkRuleMatch(rules, { subject: "the running event", body: "" })).toBeNull();
  });
});

describe("validation refuses the unsafe drafts", () => {
  const base = { name: "n", patterns: ["the running event"], scope: "subject", reason: "r" };
  it("needs a name, a reason and at least one phrase", () => {
    expect(validateJunkRule({ ...base, name: "" })).toMatch(/name/i);
    expect(validateJunkRule({ ...base, reason: "" })).toMatch(/reason/i);
    expect(validateJunkRule({ ...base, patterns: ["", " "] })).toMatch(/at least one/i);
  });
  it("refuses a phrase too short to match on safely", () => {
    expect(validateJunkRule({ ...base, patterns: ["tr"] })).toMatch(/too short/i);
  });
  it("accepts a sound draft", () => {
    expect(validateJunkRule(base)).toBeNull();
  });
});

describe("decideDisposition places the junk rule correctly", () => {
  const junkRule = { id: "r1", name: "TRE", pattern: "the running event", reason: "spam" };

  it("a matched rule files to Junk with source 'rule'", () => {
    const d = decideDisposition({ drop: null, override: null, vendorScore: 0, vendorReasons: [], junkRule });
    expect(d.kind).toBe("junk");
    if (d.kind === "junk") {
      expect(d.junkReason.source).toBe("rule");
      expect(d.junkReason.ruleName).toBe("TRE");
      expect(d.junkReason.rulePattern).toBe("the running event");
    }
  });

  it("a human not_spam rescue beats the rule — a rescued customer is never re-junked", () => {
    const d = decideDisposition({
      drop: null,
      override: { label: "not_spam", scope: "address", value: "x@y.com" },
      vendorScore: 0,
      vendorReasons: [],
      junkRule,
    });
    expect(d.kind).toBe("inbox");
  });

  it("nothing is junked when no rule matched", () => {
    const d = decideDisposition({ drop: null, override: null, vendorScore: 0, vendorReasons: [], junkRule: null });
    expect(d.kind).toBe("inbox");
  });
});

describe("the junk reason is explained on the ticket", () => {
  it("names the rule and its reason", () => {
    const text = describeJunkReason({
      source: "rule",
      ruleName: "The Running Event (TRE)",
      rulePattern: "the running event",
      ruleReason: "trade-show spam",
    });
    expect(text).toContain("The Running Event (TRE)");
    expect(text).toContain("the running event");
    expect(text).toContain("trade-show spam");
  });
});

describe("structural: wiring is in place", () => {
  it("the Gmail sync feeds a junk-rule match into decideDisposition", () => {
    const inbound = read("../lib/google/inbound.ts");
    expect(inbound).toContain("loadEnabledJunkRules");
    expect(inbound).toContain("firstJunkRuleMatch");
    expect(inbound).toContain("junkRule: junkHit");
  });

  it("intake applies junk rules BEFORE routing and skips routing when junked", () => {
    const route = read("../app/api/tickets/intake/route.ts");
    expect(route).toContain("applyJunkRulesSafely");
    // The routing/notify/risk block is gated on not being junked.
    expect(route).toContain("if (!junked.junked)");
  });

  it("the Meta path junks a new DM before routing", () => {
    const meta = read("../lib/meta/inbound.ts");
    expect(meta).toContain("applyJunkRulesSafely");
    expect(meta).toContain("if (!junked.junked)");
  });

  it("enabling is gated on zero false positives (the corrections corpus)", () => {
    const actions = read("../app/(dashboard)/settings/junk-rules/actions.ts");
    expect(actions).toContain("dry.falsePositives.length");
    expect(actions).toContain("Can't enable");
  });

  it("the apply path writes a ticket_events row naming the rule", () => {
    const engine = read("../lib/junk-rules/engine.ts");
    expect(engine).toContain('event_type: "junked_by_rule"');
    expect(engine).toContain("rule_name");
  });

  it("loadEnabledJunkRules fails INERT (returns [] on error), never throwing", () => {
    const engine = read("../lib/junk-rules/engine.ts");
    expect(engine).toContain("return [];");
  });

  it("0031 is registered in the schema checker", () => {
    const schema = read("../lib/schema-check.ts");
    expect(schema).toContain("0031_junk_rules.sql");
    expect(schema).toContain('tables: ["junk_rules"]');
  });

  it("the migration seeds the TRE rule DISABLED", () => {
    const sql = read("../supabase/migrations/0031_junk_rules.sql");
    expect(sql).toContain("The Running Event (TRE)");
    // enabled flag in the seed insert is false.
    expect(sql).toMatch(/'The Running Event \(TRE\)'[\s\S]*false/);
  });
});
