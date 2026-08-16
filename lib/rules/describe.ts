import { CHANNEL_META, PRIORITY_META } from "@/lib/types";
import {
  CONDITION_FIELDS,
  operatorLabel,
  type RuleAction,
  type RuleCondition,
  type RuleDraft,
} from "./types";

/**
 * One-line summaries of a rule, for the list view.
 *
 * Pure, and separate from the editor, so the sentence the list shows is
 * assertable in a test. A rule list whose summary quietly disagrees with what
 * the rule does would be worse than no summary at all — it is the thing
 * someone scans before deciding a rule is safe to enable.
 */

export interface NameLookup {
  agentName: (id: string | null) => string | null;
  tagName: (id: string | null) => string | null;
}

/** Placeholder for an action whose target was never chosen. */
export const UNSET_TARGET = "— not set —";

export function describeCondition(condition: RuleCondition): string {
  const meta = CONDITION_FIELDS[condition.field];
  if (!meta) return "an unknown condition";
  const value = (condition.value ?? "").trim();
  return `${meta.label.toLowerCase()} ${operatorLabel(condition.field, condition.operator)} ${
    value ? `“${value}”` : UNSET_TARGET
  }`;
}

export function describeAction(action: RuleAction, lookup: NameLookup): string {
  switch (action.type) {
    case "assign":
      return `assign to ${lookup.agentName(action.agent_id) ?? UNSET_TARGET}`;
    case "tag":
      return `add tag ${lookup.tagName(action.tag_id) ?? UNSET_TARGET}`;
    case "priority":
      return `set priority to ${PRIORITY_META[action.priority]?.label ?? action.priority}`;
    case "reply":
      return action.body.trim() ? "send an auto-reply" : `send an auto-reply ${UNSET_TARGET}`;
    default:
      return "do something unrecognised";
  }
}

/** "If topic is X or subject contains any of Y → assign to Harvey" */
export function summarizeRule(rule: RuleDraft, lookup: NameLookup): string {
  const joiner = rule.match_type === "any" ? " or " : " and ";
  const conditions = rule.conditions.length
    ? rule.conditions.map(describeCondition).join(joiner)
    : "nothing — this rule can never match";
  const actions = rule.actions.length
    ? rule.actions.map((action) => describeAction(action, lookup)).join(", ")
    : "do nothing";
  return `If ${conditions} → ${actions}`;
}

/** Human label for the channel value stored on a condition. */
export function channelLabel(value: string): string {
  return CHANNEL_META[value as keyof typeof CHANNEL_META]?.label ?? value;
}
