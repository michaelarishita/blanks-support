/**
 * Display-name fallbacks, in one place.
 *
 * These were duplicated as bare literals across components, which is how they
 * drifted: the thread rendered a null-agent reply as "Agent" while outbound
 * email signed it "Blanks Support", and a nameless customer showed as
 * "Customer" in the thread but "Unknown customer" in the list. A fallback
 * string that appears twice will eventually disagree with itself, and when the
 * two copies sit on either side of a server/client boundary it disagrees as a
 * hydration error.
 *
 * Pure and dependency-free, so the same function runs on the server render and
 * the client render — which is what makes divergence impossible rather than
 * merely unlikely.
 */

/**
 * Shown for an outbound message whose agent no longer exists. agents.id is
 * ON DELETE SET NULL, so removing a teammate orphans their replies. This is
 * the same name the customer saw in the From line, which is the honest thing
 * to show.
 */
export const AUTHOR_FALLBACK = "Blanks Support";

/** Shown for a customer with neither a name nor an email on record. */
export const CUSTOMER_FALLBACK = "Unknown customer";

/** Placeholder while an agent record is still loading. */
export const AGENT_PLACEHOLDER = "…";

/** Treats "" and whitespace as absent, which a bare ?? would not. */
function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface CustomerLike {
  name?: string | null;
  email?: string | null;
}

/** Name → email → fallback. */
export function customerDisplayName(customer: CustomerLike | null | undefined): string {
  return present(customer?.name) ?? present(customer?.email) ?? CUSTOMER_FALLBACK;
}

/** First name for macro expansion; empty when unknown, so callers can default. */
export function customerFirstName(customer: CustomerLike | null | undefined): string {
  const name = present(customer?.name);
  return name ? name.split(/\s+/)[0] : "";
}

export interface AgentLike {
  /** Customer-facing signature name. */
  name?: string | null;
  /** Internal label, when one has been set. */
  display_name?: string | null;
}

/**
 * The name to show INSIDE the dashboard.
 *
 * Deliberately separate from the signature name: the team calls Michael
 * "Mike", and customers must never see that on outbound email. Anything
 * customer-facing reads `agent.name` directly and must not call this.
 */
export function agentDisplayName(agent: AgentLike | null | undefined): string {
  return present(agent?.display_name) ?? present(agent?.name) ?? AUTHOR_FALLBACK;
}

export interface MessageAuthorInput {
  /** True for a reply or internal note written by the team. */
  isOutbound: boolean;
  /** Joined agent name, absent when the account was deleted. */
  agentName?: string | null;
  /** Already-resolved customer display name for the ticket. */
  customerName?: string | null;
}

/**
 * The single source of truth for a message's displayed author. Used by the
 * thread; AUTHOR_FALLBACK is used by the outbound From line so the two can't
 * disagree about what an orphaned reply is called.
 */
export function messageAuthorName({
  isOutbound,
  agentName,
  customerName,
}: MessageAuthorInput): string {
  if (isOutbound) return present(agentName) ?? AUTHOR_FALLBACK;
  return present(customerName) ?? CUSTOMER_FALLBACK;
}
