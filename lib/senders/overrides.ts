import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Per-sender spam overrides — how a correction takes effect IMMEDIATELY.
 *
 * When an agent clicks "Not spam" or "Mark as spam", the classifier is NOT
 * retrained and no threshold is moved. Instead an explicit override is written
 * for that sender (and, where safe, their domain), and the very next message
 * from them is filed accordingly. Fast, obvious, explainable — and reversible,
 * which a retrained model is not.
 *
 * The override BEATS both the guards and the classifier, in both directions:
 *   not_spam → inbox, even if a guard would have junked it
 *   spam     → Junk, even if nothing else would have
 */

export type OverrideLabel = "spam" | "not_spam";

export interface OverrideList {
  /** Full address (lowercased) → label. */
  addresses: Map<string, OverrideLabel>;
  /** Domain WITHOUT the leading @ (lowercased) → label. */
  domains: Map<string, OverrideLabel>;
}

export interface OverrideMatch {
  label: OverrideLabel;
  scope: "address" | "domain";
  value: string;
}

export const emptyOverrideList = (): OverrideList => ({
  addresses: new Map(),
  domains: new Map(),
});

/**
 * Freemail / consumer providers, where a DOMAIN-scope override is never safe.
 *
 * Marking gmail.com as spam would junk every Gmail customer; marking it
 * not_spam would make Gmail spam unjunkable forever. So a correction on a
 * freemail sender only ever writes an ADDRESS-scope override — the same
 * asymmetry the seed list in 0016 already respects, where freemail spammers are
 * listed by address and vendor platforms by domain.
 */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
]);

export function domainOf(email: string | null | undefined): string | null {
  const address = (email ?? "").trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const domain = address.slice(at + 1);
  return domain.includes(".") ? domain : null;
}

export function isFreemail(domain: string | null): boolean {
  return domain !== null && FREEMAIL_DOMAINS.has(domain);
}

/**
 * Which override rows a correction on this address should write.
 *
 * Always the address. The domain too — but only when it is not a freemail
 * provider, for the reason above.
 */
export function overrideTargetsFor(
  email: string | null | undefined
): { address: string | null; domain: string | null } {
  const address = (email ?? "").trim().toLowerCase() || null;
  const domain = domainOf(email);
  return {
    address,
    domain: domain && !isFreemail(domain) ? domain : null,
  };
}

/** The override for a sender, address taking precedence over domain. */
export function matchOverride(
  email: string | null | undefined,
  list: OverrideList
): OverrideMatch | null {
  const address = (email ?? "").trim().toLowerCase();
  if (!address) return null;

  const byAddress = list.addresses.get(address);
  if (byAddress) return { label: byAddress, scope: "address", value: address };

  const domain = domainOf(address);
  if (domain) {
    // Subdomains of an overridden domain count, matching the ignore list.
    for (const [listed, label] of list.domains) {
      if (domain === listed || domain.endsWith(`.${listed}`)) {
        return { label, scope: "domain", value: listed };
      }
    }
  }
  return null;
}

/**
 * The whole override table, as a lookup.
 *
 * A failed read returns an EMPTY list and reports the error rather than
 * throwing — the same discipline as the ignore list. The consequence of an
 * empty list is that a previously-rescued customer might be re-junked (still
 * recoverable, still in the folder) and a marked spammer might reach the inbox
 * (five seconds of an agent's time). Neither is worth holding the mail cursor
 * for, which failing loud here would do.
 */
export async function loadSenderOverrides(): Promise<{
  list: OverrideList;
  error: string | null;
}> {
  const list = emptyOverrideList();
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("sender_spam_overrides")
    .select("scope, value, label");
  if (error) return { list, error: error.message };

  for (const row of data ?? []) {
    const value = String(row.value).toLowerCase();
    const label = row.label as OverrideLabel;
    if (row.scope === "domain") list.domains.set(value.replace(/^@/, ""), label);
    else list.addresses.set(value, label);
  }
  return { list, error: null };
}

/**
 * Records the override(s) for a correction. Upserts, so an opposite correction
 * FLIPS the label in place rather than leaving two contradictory rows.
 *
 * Uses the admin client because it is called from the same server path as the
 * correction, which has already authorised the agent.
 */
export async function applyCorrectionOverride(
  admin: ReturnType<typeof createAdminClient>,
  args: {
    email: string | null | undefined;
    label: OverrideLabel;
    ticketId: string;
    agentId: string;
  }
): Promise<void> {
  const { address, domain } = overrideTargetsFor(args.email);
  const now = new Date().toISOString();
  const rows: {
    scope: "address" | "domain";
    value: string;
    label: OverrideLabel;
    source_ticket_id: string;
    created_by: string;
    updated_at: string;
  }[] = [];
  if (address)
    rows.push({
      scope: "address",
      value: address,
      label: args.label,
      source_ticket_id: args.ticketId,
      created_by: args.agentId,
      updated_at: now,
    });
  if (domain)
    rows.push({
      scope: "domain",
      value: domain,
      label: args.label,
      source_ticket_id: args.ticketId,
      created_by: args.agentId,
      updated_at: now,
    });
  if (!rows.length) return;

  const { error } = await admin
    .from("sender_spam_overrides")
    .upsert(rows, { onConflict: "scope,value" });
  if (error) {
    console.error("[overrides] could not record correction override:", error.message);
  }
}
