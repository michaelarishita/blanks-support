import { createAdminClient } from "@/lib/supabase/admin";
import { canEmail, deliverMessage } from "@/lib/google/outbound";
import { sendAssignmentNotification } from "@/lib/notifications/send";
import { customerFirstName } from "@/lib/display";
import { expandMacro } from "@/lib/shopify/macros";
import { ruleMatches, type TicketFacts } from "./evaluate";
import { parseRuleRow, type Rule, type RuleDraft, type RuleTrigger } from "./types";

// Runs the routing rules against a ticket. Server-only: everything here goes
// through the service-role client, because the two callers — the public intake
// endpoint and the inbound mail sync — have no signed-in agent to act as.

/** What one rule did, for the audit trail and the "check mail" summary. */
export interface FiredRule {
  ruleId: string;
  name: string;
  /** Human-readable, one per action attempted — including the skips. */
  outcomes: string[];
}

export interface RuleRunResult {
  evaluated: number;
  fired: FiredRule[];
  error?: string;
}

const emptyRun = (): RuleRunResult => ({ evaluated: 0, fired: [] });

type TicketRow = {
  id: string;
  channel: string;
  topic: string | null;
  subject: string;
  assignee_id: string | null;
  customer: { email: string | null; name: string | null } | null;
  tags: string[];
};

/** Supabase types embedded to-one relations as arrays; unwrap them. */
function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => one((entry as { tag?: unknown }).tag) as { name?: string } | null)
    .map((tag) => tag?.name)
    .filter((name): name is string => Boolean(name));
}

const TICKET_SELECT =
  "id, channel, topic, subject, assignee_id, customer:customers(email, name), ticket_tags(tag:tags(name))";

function toTicketRow(row: Record<string, unknown>): TicketRow {
  return {
    id: String(row.id),
    channel: String(row.channel ?? ""),
    topic: (row.topic as string | null) ?? null,
    subject: String(row.subject ?? ""),
    assignee_id: (row.assignee_id as string | null) ?? null,
    customer: one(row.customer as { email: string | null; name: string | null } | null),
    tags: tagNames(row.ticket_tags),
  };
}

/**
 * The message body a rule sees.
 *
 * `ticket_created` looks at the FIRST inbound message — the one that opened
 * the ticket. `message_received` looks at the LATEST, because the whole point
 * of that trigger is the reply that just arrived.
 */
function bodyOrder(trigger: RuleTrigger): boolean {
  return trigger === "ticket_created";
}

export async function loadEnabledRules(trigger: RuleTrigger): Promise<Rule[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("rules")
    .select("*")
    .eq("enabled", true)
    .eq("trigger_on", trigger)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => parseRuleRow(row as Record<string, unknown>));
}

async function gatherFacts(
  ticketId: string,
  trigger: RuleTrigger
): Promise<{ ticket: TicketRow; facts: TicketFacts } | null> {
  const admin = createAdminClient();

  const { data: row, error } = await admin
    .from("tickets")
    .select(TICKET_SELECT)
    .eq("id", ticketId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;

  const ticket = toTicketRow(row as Record<string, unknown>);

  const { data: message } = await admin
    .from("messages")
    .select("body_text")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: bodyOrder(trigger) })
    .limit(1)
    .maybeSingle();

  return {
    ticket,
    facts: {
      channel: ticket.channel,
      topic: ticket.topic,
      tags: ticket.tags,
      subject: ticket.subject,
      body: (message?.body_text as string | undefined) ?? "",
      customerEmail: ticket.customer?.email ?? null,
    },
  };
}

/**
 * Evaluates every enabled rule for this trigger, top-down, and applies the
 * actions of those that match.
 *
 * Semantics, all of them deliberate:
 *
 *  - FACTS ARE SNAPSHOTTED before the run. A tag added by rule 1 is not
 *    visible to rule 3. Cascading would make the outcome depend on order in a
 *    way that is invisible in the list and impossible for the dry-run to
 *    model, and "why did this get assigned to Harvey" has to stay answerable.
 *  - FIRST ASSIGNMENT WINS, and a ticket that already has an owner is never
 *    reassigned. Everything else stacks.
 *  - THE NOTIFICATION IS SENT LAST, once, after every rule has run — so the
 *    priority prefix in Harvey's subject line reflects a priority that a later
 *    rule raised, rather than the one the ticket happened to have when the
 *    assign action fired.
 */
export async function runRules(
  ticketId: string,
  trigger: RuleTrigger
): Promise<RuleRunResult> {
  const admin = createAdminClient();

  const rules = await loadEnabledRules(trigger);
  if (!rules.length) return emptyRun();

  const gathered = await gatherFacts(ticketId, trigger);
  if (!gathered) return { ...emptyRun(), error: "Ticket not found" };
  const { ticket, facts } = gathered;

  const result: RuleRunResult = { evaluated: rules.length, fired: [] };

  // Set the moment a rule takes the ticket, or already true if a human owns
  // it. Assignment is the one action that must not stack.
  let assignmentLocked = Boolean(ticket.assignee_id);
  let assignedTo: string | null = null;

  for (const rule of rules) {
    if (!ruleMatches(rule, facts)) continue;

    const outcomes: string[] = [];

    for (const action of rule.actions) {
      switch (action.type) {
        case "assign": {
          if (!action.agent_id) {
            outcomes.push("assign skipped — the rule has no assignee");
            break;
          }
          if (assignmentLocked) {
            outcomes.push(
              assignedTo
                ? "assign skipped — an earlier rule already assigned it"
                : "assign skipped — the ticket already has an owner"
            );
            break;
          }
          // Conditional on assignee_id still being null, so a human claiming
          // the ticket in the same second wins over the rule rather than being
          // silently overwritten.
          const { data: claimed, error: assignError } = await admin
            .from("tickets")
            .update({ assignee_id: action.agent_id })
            .eq("id", ticketId)
            .is("assignee_id", null)
            .select("id");
          if (assignError) {
            outcomes.push(`assign failed — ${assignError.message}`);
            break;
          }
          if (!claimed?.length) {
            assignmentLocked = true;
            outcomes.push("assign skipped — the ticket was claimed first");
            break;
          }
          assignmentLocked = true;
          assignedTo = action.agent_id;
          outcomes.push("assigned");
          break;
        }

        case "tag": {
          if (!action.tag_id) {
            outcomes.push("tag skipped — the rule has no tag");
            break;
          }
          const { error: tagError } = await admin
            .from("ticket_tags")
            .insert({ ticket_id: ticketId, tag_id: action.tag_id });
          // 23505 means the tag was already on the ticket, which is a success.
          if (tagError && tagError.code !== "23505") {
            outcomes.push(`tag failed — ${tagError.message}`);
            break;
          }
          outcomes.push("tagged");
          break;
        }

        case "priority": {
          const { error: priorityError } = await admin
            .from("tickets")
            .update({ priority: action.priority })
            .eq("id", ticketId);
          outcomes.push(
            priorityError
              ? `priority failed — ${priorityError.message}`
              : `priority set to ${action.priority}`
          );
          break;
        }

        case "reply":
          outcomes.push(await applyAutoReply(ticket, action.body));
          break;
      }
    }

    // One row per firing, naming the rule. This is the answer to "why did this
    // get assigned to Harvey", and it records the skips too — a rule that
    // matched and then did nothing is exactly the case that otherwise looks
    // like the rule never ran.
    await admin.from("ticket_events").insert({
      ticket_id: ticketId,
      event_type: "rule_applied",
      detail: {
        rule_id: rule.id,
        rule_name: rule.name,
        trigger: trigger,
        outcomes,
      },
    });

    result.fired.push({ ruleId: rule.id, name: rule.name, outcomes });
  }

  if (assignedTo) {
    // Harvey gets the same email he would get from a manual assignment.
    const notification = await sendAssignmentNotification(ticketId, assignedTo);
    if (notification.error) {
      console.error(
        `[rules] assignment notification failed for ticket ${ticketId}:`,
        notification.error
      );
      await admin.from("ticket_events").insert({
        ticket_id: ticketId,
        event_type: "rule_notification_failed",
        detail: { assignee_id: assignedTo, error: notification.error },
      });
    }
  }

  return result;
}

/**
 * Sends the auto-reply, if it is safe to.
 *
 * Two guards, both about not talking over a person:
 *  - never if the ticket already has an outbound public message, which covers
 *    both a second auto-reply and an agent who got there first;
 *  - never on a channel we can't email.
 *
 * The message is stored with is_automated, so it doesn't stamp
 * first_response_at and the thread can label it as machine-sent.
 */
async function applyAutoReply(ticket: TicketRow, body: string): Promise<string> {
  const admin = createAdminClient();

  const trimmed = body.trim();
  if (!trimmed) return "auto-reply skipped — empty body";

  if (!canEmail(ticket.channel, ticket.customer?.email)) {
    return "auto-reply skipped — no email address for this ticket";
  }

  const { data: existing, error: existingError } = await admin
    .from("messages")
    .select("id")
    .eq("ticket_id", ticket.id)
    .eq("direction", "outbound")
    .eq("type", "public")
    .limit(1);
  if (existingError) return `auto-reply failed — ${existingError.message}`;
  if (existing?.length) return "auto-reply skipped — the ticket already has a reply";

  const text = expandMacro(trimmed, {
    // "there" rather than an empty string: "Hi ," is worse than slightly
    // impersonal, and this send has nobody proof-reading it.
    "customer.first_name": customerFirstName(ticket.customer) || "there",
  });

  const { data: inserted, error: insertError } = await admin
    .from("messages")
    .insert({
      ticket_id: ticket.id,
      direction: "outbound",
      type: "public",
      // No agent: this is from the company, not from a person. Delivery falls
      // back to the shared mailbox and the signature block stays company-only.
      agent_id: null,
      body_text: text,
      delivery_status: "queued",
      is_automated: true,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    return `auto-reply failed — ${insertError?.message ?? "could not store it"}`;
  }

  const delivery = await deliverMessage(inserted.id);
  if (!delivery.ok) return `auto-reply failed to send — ${delivery.error}`;
  return delivery.skipped ? `auto-reply ${delivery.skipped}` : "auto-reply sent";
}

/**
 * Runs the rules and swallows anything that goes wrong.
 *
 * Both callers are on a path where failing loudly would be worse than not
 * routing: the intake endpoint would tell a customer their message wasn't
 * received, and the mail sync would abandon a batch of real email. A rule
 * engine is an optimisation on top of a ticket that already exists.
 */
export async function runRulesSafely(
  ticketId: string,
  trigger: RuleTrigger
): Promise<RuleRunResult> {
  try {
    return await runRules(ticketId, trigger);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[rules] run failed for ticket ${ticketId} (${trigger}):`, error);
    return { ...emptyRun(), error };
  }
}

// ------------------------------------------------------------
// Dry run
// ------------------------------------------------------------

export interface DryRunMatch {
  id: string;
  number: number;
  subject: string;
  createdAt: string;
  customerEmail: string | null;
  assigneeId: string | null;
}

export interface DryRunResult {
  checked: number;
  matches: DryRunMatch[];
  error?: string;
}

export const DRY_RUN_TICKETS = 50;

/**
 * "Which of the last N tickets would this rule have matched?"
 *
 * Runs the same `ruleMatches` the live path runs, over facts assembled the
 * same way — so a green dry-run and a live firing can't disagree about the
 * conditions. What it deliberately does NOT model is the actions: whether an
 * assign would actually have landed depends on who owned the ticket at the
 * time, which is not recoverable. The UI says which of the matches already had
 * an owner so that gap is visible rather than assumed away.
 */
export async function dryRunRule(
  draft: Pick<RuleDraft, "match_type" | "conditions" | "trigger_on">,
  limit = DRY_RUN_TICKETS
): Promise<DryRunResult> {
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("tickets")
    .select(`${TICKET_SELECT}, number, created_at`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { checked: 0, matches: [], error: error.message };

  const tickets = (rows ?? []) as Record<string, unknown>[];
  if (!tickets.length) return { checked: 0, matches: [] };

  const ids = tickets.map((row) => String(row.id));

  // One query for every body rather than one per ticket. Ordered so the first
  // row seen for a ticket is the one the trigger would have looked at.
  const { data: messages } = await admin
    .from("messages")
    .select("ticket_id, body_text, created_at")
    .in("ticket_id", ids)
    .eq("direction", "inbound")
    .order("created_at", { ascending: bodyOrder(draft.trigger_on) });

  const bodies = new Map<string, string>();
  for (const message of messages ?? []) {
    const key = String(message.ticket_id);
    if (!bodies.has(key)) bodies.set(key, (message.body_text as string) ?? "");
  }

  const matches: DryRunMatch[] = [];
  for (const row of tickets) {
    const ticket = toTicketRow(row);
    const facts: TicketFacts = {
      channel: ticket.channel,
      topic: ticket.topic,
      tags: ticket.tags,
      subject: ticket.subject,
      body: bodies.get(ticket.id) ?? "",
      customerEmail: ticket.customer?.email ?? null,
    };
    if (!ruleMatches({ match_type: draft.match_type, conditions: draft.conditions }, facts)) {
      continue;
    }
    matches.push({
      id: ticket.id,
      number: Number(row.number ?? 0),
      subject: ticket.subject,
      createdAt: String(row.created_at ?? ""),
      customerEmail: ticket.customer?.email ?? null,
      assigneeId: ticket.assignee_id,
    });
  }

  return { checked: tickets.length, matches };
}
