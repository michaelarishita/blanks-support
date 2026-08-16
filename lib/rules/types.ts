import { CHANNEL_META, PRIORITY_META, TOPICS } from "@/lib/types";
import type { TicketPriority } from "@/lib/types";

/**
 * The shape of a routing rule, and everything that decides whether one is
 * well-formed.
 *
 * Pure and dependency-free on purpose: the editor, the server actions and the
 * engine all validate against THIS module, so a rule the UI would refuse to
 * build cannot be smuggled in through a server action, and a rule seeded by
 * SQL is held to the same standard before it is allowed to fire.
 */

export type RuleTrigger = "ticket_created" | "message_received";
export type RuleMatch = "all" | "any";

export const RULE_TRIGGERS: {
  value: RuleTrigger;
  label: string;
  hint: string;
}[] = [
  {
    value: "ticket_created",
    label: "A ticket is created",
    hint: "Runs once, on the first message. This is what routing rules normally want.",
  },
  {
    value: "message_received",
    label: "A customer replies",
    hint: "Runs on every inbound message after the first — use it to re-prioritise a thread that turns urgent.",
  },
];

export type ConditionField =
  | "channel"
  | "topic"
  | "tag"
  | "subject"
  | "body"
  | "email_domain";

export type ConditionOperator =
  | "is"
  | "is_not"
  | "contains_any"
  | "not_contains_any";

export interface RuleCondition {
  field: ConditionField;
  operator: ConditionOperator;
  /** For the contains_* operators this is a comma-separated keyword list. */
  value: string;
}

export type RuleActionType = "assign" | "tag" | "priority" | "reply";

export type RuleAction =
  | { type: "assign"; agent_id: string | null }
  | { type: "tag"; tag_id: string | null }
  | { type: "priority"; priority: TicketPriority }
  | { type: "reply"; body: string };

/** A rule as edited — everything except identity and ordering. */
export interface RuleDraft {
  name: string;
  trigger_on: RuleTrigger;
  match_type: RuleMatch;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface Rule extends RuleDraft {
  id: string;
  position: number;
  enabled: boolean;
}

/**
 * What each condition field can be compared with, and how its value is picked.
 *
 * `valueKind` drives the editor's third control and the validator's idea of a
 * legal value, so the two cannot drift apart.
 */
export const CONDITION_FIELDS: Record<
  ConditionField,
  {
    label: string;
    operators: ConditionOperator[];
    /** Operator wording, per field — "tag is" reads worse than "tag has". */
    operatorLabels: Partial<Record<ConditionOperator, string>>;
    valueKind: "channel" | "topic" | "tag" | "keywords" | "domain";
    placeholder?: string;
  }
> = {
  channel: {
    label: "Channel",
    operators: ["is", "is_not"],
    operatorLabels: { is: "is", is_not: "is not" },
    valueKind: "channel",
  },
  topic: {
    label: "Topic",
    operators: ["is", "is_not"],
    operatorLabels: { is: "is", is_not: "is not" },
    valueKind: "topic",
  },
  tag: {
    label: "Tag",
    operators: ["is", "is_not"],
    operatorLabels: { is: "has", is_not: "does not have" },
    valueKind: "tag",
  },
  subject: {
    label: "Subject",
    operators: ["contains_any", "not_contains_any"],
    operatorLabels: {
      contains_any: "contains any of",
      not_contains_any: "contains none of",
    },
    valueKind: "keywords",
    placeholder: "cancel, change address, wrong item",
  },
  body: {
    label: "Message body",
    operators: ["contains_any", "not_contains_any"],
    operatorLabels: {
      contains_any: "contains any of",
      not_contains_any: "contains none of",
    },
    valueKind: "keywords",
    placeholder: "refund, money back",
  },
  email_domain: {
    label: "Customer email domain",
    operators: ["is", "is_not"],
    operatorLabels: { is: "is", is_not: "is not" },
    valueKind: "domain",
    placeholder: "gmail.com",
  },
};

export const CONDITION_FIELD_KEYS = Object.keys(CONDITION_FIELDS) as ConditionField[];

export function operatorLabel(
  field: ConditionField,
  operator: ConditionOperator
): string {
  return CONDITION_FIELDS[field]?.operatorLabels[operator] ?? operator;
}

export const ACTION_LABELS: Record<RuleActionType, string> = {
  assign: "Assign to",
  tag: "Add tag",
  priority: "Set priority",
  reply: "Send auto-reply",
};

/**
 * The ONLY variable an auto-reply may use.
 *
 * `{{order.*}}` is deliberately excluded. Those variables expand to
 * "[NO ORDER — CHECK BEFORE SENDING]" when no order is loaded (see
 * lib/shopify/macros.ts), and that placeholder exists precisely because a
 * human is supposed to see it before the mail leaves. An automatic send has no
 * human in the loop, so an order variable in a rule reply would mail the
 * placeholder to the customer — the exact outcome the placeholder prevents.
 */
export const AUTO_REPLY_VARIABLES = ["customer.first_name"] as const;

/** Splits a comma-separated keyword list into trimmed, lowercased terms. */
export function splitKeywords(value: string): string[] {
  return value
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

/** Strips a leading @ and lowercases, so "@Gmail.com" and "gmail.com" agree. */
export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, "");
}

const TOPIC_SET = new Set<string>(TOPICS);
const CHANNEL_SET = new Set(Object.keys(CHANNEL_META));
const PRIORITY_SET = new Set(Object.keys(PRIORITY_META));

export interface ValidationContext {
  /** Names of tags that exist, for tag conditions. */
  tagNames: string[];
  /** Ids of tags that exist, for tag actions. */
  tagIds: string[];
  /** Ids of active agents, for assign actions. */
  agentIds: string[];
}

/** Longest an auto-reply body may be. Long enough for an acknowledgement. */
export const MAX_REPLY_BODY = 2000;
export const MAX_RULE_NAME = 80;
export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 6;

/**
 * Validates a draft, returning the first problem in plain language.
 *
 * Called on save AND on enable. The enable check is not redundant: the seed
 * rules are inserted by SQL and never pass through the save path, so without
 * it "Wholesale → tag and route" could be switched on with no assignee and
 * would fire an assign action to nobody, forever, silently.
 */
export function validateRule(
  draft: RuleDraft,
  ctx: ValidationContext
): string | null {
  const name = draft.name?.trim();
  if (!name) return "Give the rule a name.";
  if (name.length > MAX_RULE_NAME) {
    return `The name must be ${MAX_RULE_NAME} characters or fewer.`;
  }

  if (!RULE_TRIGGERS.some((t) => t.value === draft.trigger_on)) {
    return "Choose when the rule runs.";
  }
  if (draft.match_type !== "all" && draft.match_type !== "any") {
    return "Choose whether all or any of the conditions must match.";
  }

  // A rule with no conditions would match every ticket. The engine refuses to
  // fire one anyway; refusing to save it is where the person can still fix it.
  if (!draft.conditions?.length) return "Add at least one condition.";
  if (draft.conditions.length > MAX_CONDITIONS) {
    return `A rule can have at most ${MAX_CONDITIONS} conditions.`;
  }
  if (!draft.actions?.length) return "Add at least one action.";
  if (draft.actions.length > MAX_ACTIONS) {
    return `A rule can have at most ${MAX_ACTIONS} actions.`;
  }

  for (const condition of draft.conditions) {
    const meta = CONDITION_FIELDS[condition?.field];
    if (!meta) return `"${condition?.field}" isn't something a rule can check.`;
    if (!meta.operators.includes(condition.operator)) {
      return `${meta.label} can't use "${condition.operator}".`;
    }

    const value = (condition.value ?? "").trim();
    if (!value) return `Fill in a value for the ${meta.label.toLowerCase()} condition.`;

    switch (meta.valueKind) {
      case "channel":
        if (!CHANNEL_SET.has(value)) return `"${value}" isn't a channel.`;
        break;
      case "topic":
        if (!TOPIC_SET.has(value)) return `"${value}" isn't one of the topics.`;
        break;
      case "tag":
        if (!ctx.tagNames.includes(value)) return `There's no tag called "${value}".`;
        break;
      case "keywords":
        if (!splitKeywords(value).length) {
          return `Add at least one keyword to the ${meta.label.toLowerCase()} condition.`;
        }
        break;
      case "domain": {
        const domain = normalizeDomain(value);
        // Not a full RFC check — just enough that "gmail" or "a@b@c" is caught
        // at save time rather than by never matching anything.
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
          return `"${value}" doesn't look like a domain (try gmail.com).`;
        }
        break;
      }
    }
  }

  const seen = new Set<RuleActionType>();
  for (const action of draft.actions) {
    if (!action?.type || !(action.type in ACTION_LABELS)) {
      return `"${action?.type}" isn't something a rule can do.`;
    }
    // Two "set priority" actions on one rule is always a mistake — one of them
    // is dead, and which one is a matter of array order nobody can see.
    if (seen.has(action.type)) {
      return `The rule has two "${ACTION_LABELS[action.type]}" actions.`;
    }
    seen.add(action.type);

    switch (action.type) {
      case "assign":
        if (!action.agent_id) return "Choose who this rule assigns to.";
        if (!ctx.agentIds.includes(action.agent_id)) {
          return "That teammate is no longer active — pick someone else.";
        }
        break;
      case "tag":
        if (!action.tag_id) return "Choose which tag this rule adds.";
        if (!ctx.tagIds.includes(action.tag_id)) {
          return "That tag no longer exists — pick another.";
        }
        break;
      case "priority":
        if (!PRIORITY_SET.has(action.priority)) {
          return `"${action.priority}" isn't a priority.`;
        }
        break;
      case "reply": {
        const body = (action.body ?? "").trim();
        if (!body) return "Write the auto-reply, or remove that action.";
        if (body.length > MAX_REPLY_BODY) {
          return `The auto-reply must be ${MAX_REPLY_BODY} characters or fewer.`;
        }
        const bad = unsupportedReplyVariables(body);
        if (bad.length) {
          return `An auto-reply can only use {{customer.first_name}} — remove {{${bad[0]}}}. Nobody reviews an automatic send, so an order variable would mail the "check before sending" placeholder straight to the customer.`;
        }
        break;
      }
    }
  }

  return null;
}

/** Every `{{variable}}` in the body that an auto-reply can't safely expand. */
export function unsupportedReplyVariables(body: string): string[] {
  const allowed = new Set<string>(AUTO_REPLY_VARIABLES);
  const found: string[] = [];
  for (const match of body.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi)) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Coerces whatever came out of the jsonb columns into the typed shapes,
 * dropping anything unrecognisable.
 *
 * The columns are jsonb, so the database guarantees valid JSON and nothing
 * else. A hand-edited row must not be able to crash the engine on every
 * inbound email — an unreadable condition is dropped, and a rule left with no
 * conditions can no longer match anything.
 */
export function parseConditions(raw: unknown): RuleCondition[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleCondition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { field, operator, value } = entry as Record<string, unknown>;
    if (typeof field !== "string" || !(field in CONDITION_FIELDS)) continue;
    const meta = CONDITION_FIELDS[field as ConditionField];
    if (typeof operator !== "string" || !meta.operators.includes(operator as ConditionOperator)) {
      continue;
    }
    out.push({
      field: field as ConditionField,
      operator: operator as ConditionOperator,
      value: typeof value === "string" ? value : "",
    });
  }
  return out;
}

export function parseActions(raw: unknown): RuleAction[] {
  if (!Array.isArray(raw)) return [];
  const out: RuleAction[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    switch (record.type) {
      case "assign":
        out.push({
          type: "assign",
          agent_id: typeof record.agent_id === "string" ? record.agent_id : null,
        });
        break;
      case "tag":
        out.push({
          type: "tag",
          tag_id: typeof record.tag_id === "string" ? record.tag_id : null,
        });
        break;
      case "priority":
        if (typeof record.priority === "string" && PRIORITY_SET.has(record.priority)) {
          out.push({ type: "priority", priority: record.priority as TicketPriority });
        }
        break;
      case "reply":
        out.push({
          type: "reply",
          body: typeof record.body === "string" ? record.body : "",
        });
        break;
    }
  }
  return out;
}

/** A database row (jsonb columns still loose) turned into a typed Rule. */
export function parseRuleRow(row: Record<string, unknown>): Rule {
  return {
    id: String(row.id),
    name: typeof row.name === "string" ? row.name : "",
    trigger_on: (row.trigger_on === "message_received"
      ? "message_received"
      : "ticket_created") as RuleTrigger,
    match_type: (row.match_type === "any" ? "any" : "all") as RuleMatch,
    position: typeof row.position === "number" ? row.position : 0,
    enabled: row.enabled === true,
    conditions: parseConditions(row.conditions),
    actions: parseActions(row.actions),
  };
}
