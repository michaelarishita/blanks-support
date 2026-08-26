import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Who we never open a ticket for.
 *
 * IGNORED_SENDER_EMAILS is an env var, which means adding a sender is a
 * deploy — and the person who can identify vendor cold outreach is the agent
 * reading it, not whoever has access to Vercel's settings. Roughly a third of
 * recent tickets were cold outreach, so that gap was the whole problem.
 *
 * The env var still works and is still authoritative for the addresses it
 * names; this unions a database table on top of it.
 */

export type IgnoreKind = "address" | "domain";

export interface IgnoredSenderEntry {
  id: string;
  value: string;
  kind: IgnoreKind;
  reason: string | null;
  created_at: string;
}

export interface IgnoreList {
  /** Full addresses, lowercased. */
  addresses: Set<string>;
  /** Domains WITHOUT the leading @, lowercased. */
  domains: Set<string>;
}

export const emptyIgnoreList = (): IgnoreList => ({
  addresses: new Set(),
  domains: new Set(),
});

/**
 * Normalises one entry as typed by a human.
 *
 * Accepts "bob@vendor.com", "@vendor.com" and "vendor.com". The middle form
 * is what the UI writes; the last is what people type, and silently treating
 * it as an address would produce an entry that matches nothing while looking
 * like it worked.
 */
export function normalizeIgnoreValue(
  raw: string
): { value: string; kind: IgnoreKind } | null {
  const trimmed = raw.trim().toLowerCase().replace(/^mailto:/, "");
  if (!trimmed) return null;

  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    const domain = trimmed.slice(at + 1);
    if (!domain.includes(".")) return null;
    return { value: trimmed, kind: "address" };
  }
  // Leading @ or no @ at all: a domain either way.
  const domain = trimmed.replace(/^@/, "");
  if (!domain.includes(".") || /\s/.test(domain)) return null;
  return { value: `@${domain}`, kind: "domain" };
}

/** Does this sender match the list? Subdomains of a listed domain count. */
export function isIgnoredSender(
  email: string | null | undefined,
  list: IgnoreList
): boolean {
  const address = (email ?? "").trim().toLowerCase();
  if (!address) return false;
  if (list.addresses.has(address)) return true;

  const at = address.lastIndexOf("@");
  if (at === -1) return false;
  const domain = address.slice(at + 1);

  // "mail.beehiiv.com" has to match an entry for "beehiiv.com": cold outreach
  // platforms rotate subdomains as freely as they rotate local parts.
  for (const listed of list.domains) {
    if (domain === listed || domain.endsWith(`.${listed}`)) return true;
  }
  return false;
}

/**
 * Env ∪ table.
 *
 * A failed table read returns the env entries and reports the error rather
 * than pretending the list is empty. Getting this backwards would not lose
 * mail — it would let vendor noise back in, which is visible and recoverable.
 * The opposite default, treating a failed read as "ignore everything", would
 * silently discard customers.
 */
export async function loadIgnoreList(): Promise<{
  list: IgnoreList;
  error: string | null;
}> {
  const list = emptyIgnoreList();
  // Parsed here rather than imported from lib/google/inbound: inbound imports
  // THIS module, and a cycle between them would be resolved differently by
  // the bundler than by vitest.
  const fromEnv = (process.env.IGNORED_SENDER_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const address of fromEnv) {
    const parsed = normalizeIgnoreValue(address);
    if (!parsed) continue;
    if (parsed.kind === "address") list.addresses.add(parsed.value);
    else list.domains.add(parsed.value.slice(1));
  }

  const admin = createAdminClient();
  const { data, error } = await admin.from("ignored_senders").select("value, kind");
  if (error) return { list, error: error.message };

  for (const row of data ?? []) {
    const value = String(row.value).toLowerCase();
    if (row.kind === "domain") list.domains.add(value.replace(/^@/, ""));
    else list.addresses.add(value);
  }
  return { list, error: null };
}

/** The full list, for the Settings screen. */
export async function readIgnoredSenders(): Promise<{
  entries: IgnoredSenderEntry[];
  error: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ignored_senders")
    .select("id, value, kind, reason, created_at")
    .order("created_at", { ascending: false });
  if (error) return { entries: [], error: error.message };
  return { entries: (data ?? []) as IgnoredSenderEntry[], error: null };
}
