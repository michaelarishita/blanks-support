/**
 * Subject-match junk rules — the pure core.
 *
 * Kept free of any I/O so the decision can be argued about and tested without a
 * database, exactly like lib/inbound/junk.ts and lib/rules/evaluate.ts. The DB
 * side (load, apply, dry-run) lives in ./engine.
 *
 * The match is a deliberately boring case-insensitive SUBSTRING test, not a
 * regex: an admin types a phrase, not a pattern language, and a regex here would
 * be a ReDoS and a foot-gun with no upside the dry-run can't already give. The
 * safety against over-matching is the dry-run's corrections-corpus check, not
 * cleverness in the matcher.
 */

export type JunkRuleScope = "subject" | "subject_body";

export interface JunkRule {
  id: string;
  name: string;
  patterns: string[];
  scope: JunkRuleScope;
  reason: string;
  enabled: boolean;
  position: number;
}

export interface JunkRuleFacts {
  subject: string;
  body: string;
}

export interface JunkRuleMatch {
  matched: boolean;
  /** The specific pattern that fired, for the audit trail. */
  pattern?: string;
}

/** The text a rule's scope looks at. */
function scopedText(scope: JunkRuleScope, facts: JunkRuleFacts): string {
  const subject = facts.subject ?? "";
  if (scope === "subject") return subject;
  return `${subject}\n${facts.body ?? ""}`;
}

/** Non-empty, trimmed, lowercased patterns — the ones that can actually match. */
export function usablePatterns(patterns: string[] | null | undefined): string[] {
  return (patterns ?? [])
    .map((p) => (p ?? "").trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/**
 * Does this rule match? True if ANY usable pattern is a case-insensitive
 * substring of the scoped text.
 *
 * A rule with no usable patterns matches NOTHING — the same guard the routing
 * engine applies to a zero-condition rule. Without it, a blank pattern (`""` is
 * a substring of everything) would junk the entire inbox the moment the rule was
 * enabled, which is the single most dangerous bug this feature could ship.
 */
export function junkRuleMatches(
  rule: Pick<JunkRule, "patterns" | "scope">,
  facts: JunkRuleFacts
): JunkRuleMatch {
  const patterns = usablePatterns(rule.patterns);
  if (!patterns.length) return { matched: false };

  const haystack = scopedText(rule.scope, facts).toLowerCase();
  for (const pattern of patterns) {
    if (haystack.includes(pattern)) return { matched: true, pattern };
  }
  return { matched: false };
}

/** The first enabled rule (in order) that matches — the one that files it. */
export function firstJunkRuleMatch(
  rules: JunkRule[],
  facts: JunkRuleFacts
): { rule: JunkRule; pattern: string } | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const match = junkRuleMatches(rule, facts);
    if (match.matched) return { rule, pattern: match.pattern ?? "" };
  }
  return null;
}

export const MAX_JUNK_RULE_NAME = 80;
export const MAX_JUNK_RULE_REASON = 300;
export const MAX_JUNK_RULE_PATTERN = 120;
export const MAX_JUNK_RULE_PATTERNS = 25;

/** Parse a DB row into a JunkRule, tolerant of the loose jsonb/array shapes. */
export function parseJunkRuleRow(row: Record<string, unknown>): JunkRule {
  const rawPatterns = row.patterns;
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns.map((p) => String(p))
    : [];
  const scope = row.scope === "subject_body" ? "subject_body" : "subject";
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    patterns,
    scope,
    reason: String(row.reason ?? ""),
    enabled: Boolean(row.enabled),
    position: Number(row.position ?? 0),
  };
}

/**
 * Validate a draft before it is saved or enabled. Returns a human-readable
 * problem, or null when the draft is sound.
 */
export function validateJunkRule(draft: {
  name: string;
  patterns: string[];
  scope: string;
  reason: string;
}): string | null {
  if (!draft.name.trim()) return "Give the rule a name.";
  if (draft.name.length > MAX_JUNK_RULE_NAME) {
    return `The name is too long (max ${MAX_JUNK_RULE_NAME}).`;
  }
  if (!draft.reason.trim()) {
    return "Add a reason — it is shown on every ticket this rule junks.";
  }
  if (draft.reason.length > MAX_JUNK_RULE_REASON) {
    return `The reason is too long (max ${MAX_JUNK_RULE_REASON}).`;
  }
  if (draft.scope !== "subject" && draft.scope !== "subject_body") {
    return "Scope must be subject or subject + body.";
  }
  const patterns = usablePatterns(draft.patterns);
  if (!patterns.length) {
    return "Add at least one phrase to match — a rule with none never matches anything.";
  }
  if (patterns.length > MAX_JUNK_RULE_PATTERNS) {
    return `Too many phrases (max ${MAX_JUNK_RULE_PATTERNS}).`;
  }
  const tooLong = patterns.find((p) => p.length > MAX_JUNK_RULE_PATTERN);
  if (tooLong) return `A phrase is too long (max ${MAX_JUNK_RULE_PATTERN} characters).`;
  // A one- or two-character phrase matches almost anything and is the classic
  // way a well-meant rule junks the inbox. The dry-run would catch it, but
  // refusing up front is cheaper than a scary dry-run.
  const tooShort = patterns.find((p) => p.length < 3);
  if (tooShort) {
    return `"${tooShort}" is too short to match on safely — use a phrase of at least 3 characters.`;
  }
  return null;
}
