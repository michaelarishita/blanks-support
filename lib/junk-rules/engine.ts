import { createAdminClient } from "@/lib/supabase/admin";
import type { JunkReason } from "@/lib/types";
import {
  firstJunkRuleMatch,
  junkRuleMatches,
  parseJunkRuleRow,
  usablePatterns,
  type JunkRule,
  type JunkRuleScope,
} from "./match";

/**
 * The database side of subject-match junk rules. Server-only: every write goes
 * through the service-role client because the callers — the inbound mail sync,
 * the public intake endpoint, the Meta queue — have no signed-in agent to act
 * as. The admin UI's own edits go through the admin's RLS client (see the
 * settings actions), so the junk_rules_admin policy stays the real gate.
 */

type Admin = ReturnType<typeof createAdminClient>;

export { firstJunkRuleMatch } from "./match";
export type { JunkRule } from "./match";

/**
 * Enabled rules, in order. A failed read returns [] — INERT, never throwing.
 *
 * This is the fail-safe that lets 0031 ship before it is applied: no table →
 * read error → no rules → nothing is junked, which is exactly the behaviour
 * before the feature existed. The opposite failure (throwing) would abandon a
 * batch of real customer mail over a junk filter, which is never the right
 * trade.
 */
export async function loadEnabledJunkRules(admin: Admin): Promise<JunkRule[]> {
  const { data, error } = await admin
    .from("junk_rules")
    .select("*")
    .eq("enabled", true)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[junk-rules] could not load rules:", error.message);
    return [];
  }
  return (data ?? []).map((row) => parseJunkRuleRow(row as Record<string, unknown>));
}

/** The junk_reason a rule match writes, so the ticket screen can explain it. */
export function ruleJunkReason(rule: JunkRule, pattern: string): JunkReason {
  return {
    source: "rule",
    ruleId: rule.id,
    ruleName: rule.name,
    rulePattern: pattern,
    ruleReason: rule.reason,
  };
}

export interface JunkRuleApplication {
  junked: boolean;
  ruleName?: string;
  reason?: string;
}

/**
 * Apply enabled junk rules to a ticket that already exists, junking it if the
 * first matching rule fires. Used by the intake and Meta paths, which create
 * the ticket first and then decide. (The Gmail sync folds the same match into
 * decideDisposition instead, so it junks at insert rather than re-updating.)
 *
 * Reads the subject and the FIRST inbound message — the one that opened the
 * ticket — matching the dry-run and the "ticket_created" trigger semantics.
 */
export async function applyJunkRulesToTicket(
  admin: Admin,
  ticketId: string
): Promise<JunkRuleApplication> {
  const rules = await loadEnabledJunkRules(admin);
  if (!rules.length) return { junked: false };

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, status")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return { junked: false };
  // Never re-junk, and never junk something already moved on. Only a live
  // inbound ticket is a candidate.
  if (ticket.status !== "new" && ticket.status !== "open") return { junked: false };

  const { data: message } = await admin
    .from("messages")
    .select("body_text")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const hit = firstJunkRuleMatch(rules, {
    subject: (ticket.subject as string) ?? "",
    body: (message?.body_text as string | undefined) ?? "",
  });
  if (!hit) return { junked: false };

  const junkReason = ruleJunkReason(hit.rule, hit.pattern);
  const { error } = await admin
    .from("tickets")
    .update({
      status: "junk",
      junked_at: new Date().toISOString(),
      junk_reason: junkReason,
      // Junk is out of every queue; an assignee on it is meaningless.
      assignee_id: null,
    })
    .eq("id", ticketId);
  if (error) {
    console.error("[junk-rules] could not junk ticket:", error.message);
    return { junked: false };
  }

  // The audit row. "Why is this in Junk" is answerable from here AND from
  // junk_reason — the rule is named in both.
  await admin.from("ticket_events").insert({
    ticket_id: ticketId,
    event_type: "junked_by_rule",
    detail: {
      rule_id: hit.rule.id,
      rule_name: hit.rule.name,
      pattern: hit.pattern,
      reason: hit.rule.reason,
    },
  });

  return { junked: true, ruleName: hit.rule.name, reason: hit.rule.reason };
}

/**
 * Never-throwing wrapper for the ingest paths. A broken junk filter must not
 * turn a received customer message into a 500 or abandon a mail batch — the
 * same contract as runRulesSafely.
 */
export async function applyJunkRulesSafely(
  ticketId: string
): Promise<JunkRuleApplication> {
  try {
    return await applyJunkRulesToTicket(createAdminClient(), ticketId);
  } catch (e) {
    console.error(
      "[junk-rules] apply failed for ticket",
      ticketId,
      e instanceof Error ? e.message : String(e)
    );
    return { junked: false };
  }
}

// ------------------------------------------------------------
// Dry run
// ------------------------------------------------------------

export interface JunkDryRunMatch {
  id: string;
  number: number;
  subject: string;
  createdAt: string;
  status: string;
  customerEmail: string | null;
  /** Which pattern matched. */
  pattern: string;
  /**
   * This ticket carries a human "not spam" correction — enabling the rule would
   * re-junk a customer a person deliberately rescued. The loud failure.
   */
  correctedNotSpam: boolean;
}

export interface JunkFalsePositive {
  /** From the corrections corpus — a message a human labelled not_spam. */
  subject: string;
  fromEmail: string | null;
  pattern: string;
  correctedAt: string;
}

export interface JunkDryRunResult {
  checked: number;
  /** True when the 90-day window filled the scan cap — coverage is partial. */
  capped: boolean;
  windowDays: number;
  matches: JunkDryRunMatch[];
  /** not_spam corrections this pattern would contradict, corpus-wide. */
  falsePositives: JunkFalsePositive[];
  error?: string;
}

export const JUNK_DRY_RUN_DAYS = 90;
const JUNK_DRY_RUN_CAP = 1000;

interface JunkRuleDraft {
  patterns: string[];
  scope: JunkRuleScope;
}

/**
 * "Which tickets in the last 90 days would this pattern have junked, and does
 * it contradict anything a human marked 'not spam'?"
 *
 * Two independent questions, deliberately:
 *
 *  1. The 90-day TICKET scan — what the rule would catch going forward, shown so
 *     Michael can eyeball the live tickets it would newly junk.
 *  2. The CORRECTIONS-CORPUS scan — every message a human ever marked not_spam,
 *     age-independent, matched against the pattern. A hit here is a FALSE
 *     POSITIVE: the rule would re-junk someone a person rescued. This is the
 *     check that gates enabling (see setJunkRuleEnabled).
 *
 * The matcher is the same `junkRuleMatches` the live path uses, so a clean dry
 * run and a live firing cannot disagree about what matches.
 */
export async function dryRunJunkRule(
  admin: Admin,
  draft: JunkRuleDraft,
  days = JUNK_DRY_RUN_DAYS
): Promise<JunkDryRunResult> {
  const base: Omit<JunkDryRunResult, "error"> = {
    checked: 0,
    capped: false,
    windowDays: days,
    matches: [],
    falsePositives: [],
  };

  if (!usablePatterns(draft.patterns).length) {
    return {
      ...base,
      error: "Add a phrase first — a rule with none never matches anything.",
    };
  }

  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // --- 1. The 90-day ticket scan ---
  const { data: rows, error } = await admin
    .from("tickets")
    .select(
      "id, number, subject, status, created_at, customer:customers(email)"
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(JUNK_DRY_RUN_CAP);
  if (error) return { ...base, error: error.message };

  const tickets = (rows ?? []) as Record<string, unknown>[];
  const capped = tickets.length >= JUNK_DRY_RUN_CAP;

  // Bodies in one query (first inbound per ticket), only needed for subject_body.
  const bodies = new Map<string, string>();
  if (draft.scope === "subject_body" && tickets.length) {
    const ids = tickets.map((t) => String(t.id));
    const { data: messages } = await admin
      .from("messages")
      .select("ticket_id, body_text, created_at")
      .in("ticket_id", ids)
      .eq("direction", "inbound")
      .order("created_at", { ascending: true });
    for (const m of messages ?? []) {
      const key = String(m.ticket_id);
      if (!bodies.has(key)) bodies.set(key, (m.body_text as string) ?? "");
    }
  }

  // Which of these tickets a human rescued, so a match on one reads as the
  // mistake it is rather than a catch.
  const rescued = new Set<string>();
  if (tickets.length) {
    const ids = tickets.map((t) => String(t.id));
    const { data: corr } = await admin
      .from("spam_corrections")
      .select("ticket_id")
      .eq("label", "not_spam")
      .is("undone_at", null)
      .in("ticket_id", ids);
    for (const c of corr ?? []) rescued.add(String(c.ticket_id));
  }

  const matches: JunkDryRunMatch[] = [];
  for (const row of tickets) {
    const id = String(row.id);
    const subject = (row.subject as string) ?? "";
    const facts = { subject, body: bodies.get(id) ?? "" };
    const hit = junkRuleMatches(draft, facts);
    if (!hit.matched) continue;
    const customer = row.customer as { email: string | null } | { email: string | null }[] | null;
    const email = Array.isArray(customer) ? customer[0]?.email ?? null : customer?.email ?? null;
    matches.push({
      id,
      number: Number(row.number ?? 0),
      subject,
      createdAt: String(row.created_at ?? ""),
      status: String(row.status ?? ""),
      customerEmail: email,
      pattern: hit.pattern ?? "",
      correctedNotSpam: rescued.has(id),
    });
  }

  // --- 2. The corrections-corpus false-positive scan (age-independent) ---
  const falsePositives: JunkFalsePositive[] = [];
  const { data: notSpam } = await admin
    .from("spam_corrections")
    .select("subject, body_text, from_email, corrected_at")
    .eq("label", "not_spam")
    .is("undone_at", null)
    .order("corrected_at", { ascending: false })
    .limit(JUNK_DRY_RUN_CAP);
  for (const c of notSpam ?? []) {
    const facts = {
      subject: (c.subject as string) ?? "",
      body: (c.body_text as string) ?? "",
    };
    const hit = junkRuleMatches(draft, facts);
    if (!hit.matched) continue;
    falsePositives.push({
      subject: facts.subject,
      fromEmail: (c.from_email as string | null) ?? null,
      pattern: hit.pattern ?? "",
      correctedAt: String(c.corrected_at ?? ""),
    });
  }

  return { ...base, checked: tickets.length, capped, matches, falsePositives };
}
