import { describe, expect, it } from "vitest";
import {
  parseActions,
  parseConditions,
  parseRuleRow,
  unsupportedReplyVariables,
  validateRule,
  type RuleDraft,
  type ValidationContext,
} from "@/lib/rules/types";
import { summarizeRule, UNSET_TARGET } from "@/lib/rules/describe";
import { MISSING_ORDER_PLACEHOLDER } from "@/lib/shopify/macros";

const CTX: ValidationContext = {
  tagNames: ["Order questions", "Wholesale / retailer"],
  tagIds: ["tag-1", "tag-2"],
  agentIds: ["agent-1"],
};

const draft = (patch: Partial<RuleDraft> = {}): RuleDraft => ({
  name: "Order changes → Harvey",
  trigger_on: "ticket_created",
  match_type: "any",
  conditions: [{ field: "topic", operator: "is", value: "Order questions" }],
  actions: [{ type: "assign", agent_id: "agent-1" }],
  ...patch,
});

describe("validateRule", () => {
  it("accepts a well-formed rule", () => {
    expect(validateRule(draft(), CTX)).toBeNull();
  });

  it("requires a name", () => {
    expect(validateRule(draft({ name: "  " }), CTX)).toMatch(/name/i);
  });

  it("requires at least one condition", () => {
    expect(validateRule(draft({ conditions: [] }), CTX)).toMatch(/condition/i);
  });

  it("requires at least one action", () => {
    expect(validateRule(draft({ actions: [] }), CTX)).toMatch(/action/i);
  });

  it("rejects an operator the field doesn't support", () => {
    const rule = draft({
      conditions: [{ field: "channel", operator: "contains_any", value: "web_form" }],
    });
    expect(validateRule(rule, CTX)).toMatch(/can't use/i);
  });

  it("rejects a topic that isn't in the list", () => {
    const rule = draft({
      conditions: [{ field: "topic", operator: "is", value: "Made up" }],
    });
    expect(validateRule(rule, CTX)).toMatch(/topics/i);
  });

  it("rejects a tag that doesn't exist", () => {
    const rule = draft({
      conditions: [{ field: "tag", operator: "is", value: "Nope" }],
    });
    expect(validateRule(rule, CTX)).toMatch(/no tag/i);
  });

  it("rejects a domain that isn't one", () => {
    const rule = draft({
      conditions: [{ field: "email_domain", operator: "is", value: "gmail" }],
    });
    expect(validateRule(rule, CTX)).toMatch(/domain/i);
  });

  it("accepts a domain written with a leading @", () => {
    const rule = draft({
      conditions: [{ field: "email_domain", operator: "is", value: "@gmail.com" }],
    });
    expect(validateRule(rule, CTX)).toBeNull();
  });

  it("rejects a blank condition value", () => {
    const rule = draft({
      conditions: [{ field: "subject", operator: "contains_any", value: "  " }],
    });
    expect(validateRule(rule, CTX)).toMatch(/value/i);
  });

  /**
   * The seed-rule case. "Wholesale → tag and route" ships with a null
   * assignee, and enabling it calls this same validator on the STORED rule —
   * so this refusal is the only thing between that rule and firing an assign
   * action at nobody on every wholesale enquiry.
   */
  it("rejects an assign action with no assignee", () => {
    const rule = draft({ actions: [{ type: "assign", agent_id: null }] });
    expect(validateRule(rule, CTX)).toMatch(/who this rule assigns to/i);
  });

  it("rejects an assignee who is no longer active", () => {
    const rule = draft({ actions: [{ type: "assign", agent_id: "gone" }] });
    expect(validateRule(rule, CTX)).toMatch(/no longer active/i);
  });

  it("rejects a tag action with no tag", () => {
    const rule = draft({ actions: [{ type: "tag", tag_id: null }] });
    expect(validateRule(rule, CTX)).toMatch(/which tag/i);
  });

  it("rejects two actions of the same type", () => {
    const rule = draft({
      actions: [
        { type: "priority", priority: "high" },
        { type: "priority", priority: "low" },
      ],
    });
    expect(validateRule(rule, CTX)).toMatch(/two "Set priority"/);
  });

  it("rejects an empty auto-reply", () => {
    const rule = draft({ actions: [{ type: "reply", body: "   " }] });
    expect(validateRule(rule, CTX)).toMatch(/write the auto-reply/i);
  });

  it("accepts an auto-reply using the customer's first name", () => {
    const rule = draft({
      actions: [{ type: "reply", body: "Hi {{customer.first_name}}, we've got this." }],
    });
    expect(validateRule(rule, CTX)).toBeNull();
  });

  /**
   * An order variable in an automatic send would mail
   * MISSING_ORDER_PLACEHOLDER straight to the customer — nobody proof-reads a
   * rule reply, which is the whole reason that placeholder exists.
   */
  it("rejects an auto-reply using an order variable", () => {
    const rule = draft({
      actions: [{ type: "reply", body: "Tracking: {{order.tracking_url}}" }],
    });
    const error = validateRule(rule, CTX);
    expect(error).toMatch(/order\.tracking_url/);
    expect(MISSING_ORDER_PLACEHOLDER).toContain("CHECK BEFORE SENDING");
  });
});

describe("unsupportedReplyVariables", () => {
  it("finds order variables", () => {
    expect(unsupportedReplyVariables("{{order.number}} and {{order.total}}")).toEqual([
      "order.number",
      "order.total",
    ]);
  });

  it("allows the customer first name", () => {
    expect(unsupportedReplyVariables("Hi {{ customer.first_name }}")).toEqual([]);
  });

  it("reports each unknown variable once", () => {
    expect(unsupportedReplyVariables("{{a.b}} {{a.b}}")).toEqual(["a.b"]);
  });
});

describe("parsing jsonb columns", () => {
  it("drops a condition with an unknown field", () => {
    expect(parseConditions([{ field: "moon_phase", operator: "is", value: "full" }])).toEqual(
      []
    );
  });

  it("drops a condition whose operator the field doesn't support", () => {
    expect(
      parseConditions([{ field: "channel", operator: "contains_any", value: "email" }])
    ).toEqual([]);
  });

  it("keeps a valid condition", () => {
    expect(
      parseConditions([{ field: "topic", operator: "is", value: "Feedback" }])
    ).toEqual([{ field: "topic", operator: "is", value: "Feedback" }]);
  });

  it("survives a column that isn't an array", () => {
    expect(parseConditions("nonsense")).toEqual([]);
    expect(parseActions(null)).toEqual([]);
  });

  it("keeps a null assign target rather than dropping the action", () => {
    // Dropping it would turn "the seed rule has no assignee" into "the seed
    // rule has no actions", and the error message would stop being true.
    expect(parseActions([{ type: "assign", agent_id: null }])).toEqual([
      { type: "assign", agent_id: null },
    ]);
  });

  it("drops a priority action with a bogus priority", () => {
    expect(parseActions([{ type: "priority", priority: "catastrophic" }])).toEqual([]);
  });

  it("defaults a row's trigger and match to the safe values", () => {
    const rule = parseRuleRow({ id: "r1", name: "x", conditions: [], actions: [] });
    expect(rule.trigger_on).toBe("ticket_created");
    expect(rule.match_type).toBe("all");
    expect(rule.enabled).toBe(false);
  });
});

describe("summarizeRule", () => {
  const lookup = {
    agentName: (id: string | null) => (id === "agent-1" ? "Harvey" : null),
    tagName: (id: string | null) => (id === "tag-2" ? "Wholesale / retailer" : null),
  };

  it("joins any-conditions with 'or'", () => {
    const text = summarizeRule(
      draft({
        conditions: [
          { field: "topic", operator: "is", value: "Order questions" },
          { field: "subject", operator: "contains_any", value: "cancel" },
        ],
      }),
      lookup
    );
    expect(text).toContain(" or ");
    expect(text).toContain("assign to Harvey");
  });

  it("joins all-conditions with 'and'", () => {
    const text = summarizeRule(
      draft({
        match_type: "all",
        conditions: [
          { field: "channel", operator: "is", value: "email" },
          { field: "tag", operator: "is_not", value: "VIP" },
        ],
      }),
      lookup
    );
    expect(text).toContain(" and ");
    expect(text).toContain("does not have");
  });

  it("says so when an action has no target", () => {
    const text = summarizeRule(draft({ actions: [{ type: "assign", agent_id: null }] }), lookup);
    expect(text).toContain(UNSET_TARGET);
  });

  it("says so when a rule can never match", () => {
    expect(summarizeRule(draft({ conditions: [] }), lookup)).toContain("never match");
  });
});
