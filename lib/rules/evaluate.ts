import {
  normalizeDomain,
  splitKeywords,
  type RuleCondition,
  type RuleMatch,
} from "./types";

/**
 * Rule matching. Pure — no database, no I/O.
 *
 * The engine gathers facts and applies actions; this module decides only
 * whether a rule matches. Keeping the decision separable is what lets the
 * dry-run answer "which of the last 50 tickets would this have caught"
 * honestly: it runs the same function the live path runs, not a reimplementation
 * of it.
 */

export interface TicketFacts {
  channel: string;
  topic: string | null;
  /** Tag names as stored. Compared case-insensitively. */
  tags: string[];
  subject: string;
  /** The inbound message body the trigger is about. */
  body: string;
  customerEmail: string | null;
}

const lower = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/** The domain half of an email address, lowercased. */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? "").lastIndexOf("@");
  return at === -1 ? "" : normalizeDomain((email ?? "").slice(at + 1));
}

/**
 * Does one condition hold?
 *
 * An empty value is false for EVERY operator, including the negative ones.
 * Vacuous truth is the wrong default here: a blank "subject contains none of"
 * would otherwise match every ticket in the system, and it would do it while
 * looking like a half-finished edit rather than a live rule.
 */
export function conditionMatches(
  condition: RuleCondition,
  facts: TicketFacts
): boolean {
  const value = (condition.value ?? "").trim();
  if (!value) return false;

  switch (condition.field) {
    case "channel": {
      const hit = lower(facts.channel) === lower(value);
      return condition.operator === "is_not" ? !hit : hit;
    }
    case "topic": {
      const hit = lower(facts.topic) === lower(value);
      return condition.operator === "is_not" ? !hit : hit;
    }
    case "tag": {
      const wanted = lower(value);
      const hit = facts.tags.some((tag) => lower(tag) === wanted);
      return condition.operator === "is_not" ? !hit : hit;
    }
    case "subject":
      return keywordMatch(facts.subject, value, condition.operator);
    case "body":
      return keywordMatch(facts.body, value, condition.operator);
    case "email_domain": {
      const hit = emailDomain(facts.customerEmail) === normalizeDomain(value);
      return condition.operator === "is_not" ? !hit : hit;
    }
    default:
      return false;
  }
}

/**
 * Substring matching, not word matching: "cancel" has to catch "cancelled" and
 * "cancellation", which is how customers actually write. The cost is that a
 * short keyword can match inside an unrelated word, which is what the dry-run
 * is for.
 */
function keywordMatch(
  haystack: string,
  value: string,
  operator: RuleCondition["operator"]
): boolean {
  const terms = splitKeywords(value);
  if (!terms.length) return false;
  const text = lower(haystack);
  const hit = terms.some((term) => text.includes(term));
  return operator === "not_contains_any" ? !hit : hit;
}

/**
 * Does the rule match?
 *
 * Zero conditions never matches. A rule that fires on everything is almost
 * always an accident mid-edit, and the blast radius — auto-assigning the whole
 * inbox to one person — is large enough that "do nothing" is the right
 * reading of an empty rule.
 */
export function ruleMatches(
  rule: { match_type: RuleMatch; conditions: RuleCondition[] },
  facts: TicketFacts
): boolean {
  if (!rule.conditions.length) return false;
  return rule.match_type === "any"
    ? rule.conditions.some((c) => conditionMatches(c, facts))
    : rule.conditions.every((c) => conditionMatches(c, facts));
}
