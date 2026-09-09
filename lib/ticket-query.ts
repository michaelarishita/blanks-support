import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The inbox's filter and sort, in one place.
 *
 * Shared because the ticket page has to reproduce the list EXACTLY to know
 * which ticket comes next. Two copies of this logic would drift, and the
 * symptom would be "auto-advance sometimes goes to the wrong ticket", which
 * is close to impossible to spot from a bug report.
 */

export interface TicketViewParams {
  view?: string;
  channel?: string;
  sort?: string;
  customer?: string;
  assignee?: string;
  /** Free-text sender filter (name or email); resolved to customer ids. */
  sender?: string;
  /** Overrides the "My tickets" status scope: open | resolved | all. */
  status?: string;
}

/** Never a real row — used to force zero results when a filter matched nobody. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The status scopes the My-tickets view can be narrowed to. */
export const MINE_STATUSES = {
  open: "Open",
  resolved: "Resolved",
  all: "All",
} as const;

export type MineStatus = keyof typeof MINE_STATUSES;

/** Defaults to `open` — the queue's value is that it lists work needing action. */
export function resolveMineStatus(status: string | undefined): MineStatus {
  return status && status in MINE_STATUSES ? (status as MineStatus) : "open";
}

export const SORTS = {
  newest: "Newest activity",
  oldest: "Oldest activity",
  priority: "Priority",
} as const;

export type SortKey = keyof typeof SORTS;

export function resolveSort(sort: string | undefined): SortKey {
  return sort && sort in SORTS ? (sort as SortKey) : "newest";
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the Supabase query
   builder's generics don't survive being passed around like this, and the
   filters below are all string-keyed. */
export function applyTicketFilters<T extends any>(
  query: T,
  params: TicketViewParams,
  currentAgentId: string | null,
  /**
   * Customer ids the `sender` text resolved to, pre-fetched by the caller (the
   * builder is synchronous). An EMPTY array means the text matched nobody —
   * which is zero results, NOT "no filter". `undefined` means the caller did
   * not resolve it, so the sender filter is skipped.
   */
  senderCustomerIds?: string[] | null
): T {
  const view = params.view ?? "open";
  let q: any = query;

  if (resolveSort(params.sort) === "priority") {
    // The ticket_priority enum is declared low → urgent, so descending puts
    // urgent first; recency breaks ties.
    q = q
      .order("priority", { ascending: false })
      .order("last_message_at", { ascending: false });
  } else {
    q = q.order("last_message_at", {
      ascending: resolveSort(params.sort) === "oldest",
    });
  }

  if (view === "open") q = q.in("status", ["new", "open"]);
  if (view === "mine" && currentAgentId) {
    q = q.eq("assignee_id", currentAgentId);
    // The DEFAULT stays open work only — mixing resolved back in is what made
    // the queue's counts meaningless. Resolved is reachable, not the default.
    const mineStatus = resolveMineStatus(params.status);
    if (mineStatus === "resolved") q = q.in("status", ["resolved", "closed"]);
    else if (mineStatus === "open")
      q = q.not("status", "in", "(resolved,closed)");
    // "all" adds no status constraint.
  }
  if (view === "unassigned")
    q = q.is("assignee_id", null).not("status", "in", "(resolved,closed)");
  if (view === "resolved") q = q.in("status", ["resolved", "closed"]);
  if (params.channel) q = q.eq("channel", params.channel);
  if (params.customer) q = q.eq("customer_id", params.customer);
  if (params.assignee) q = q.eq("assignee_id", params.assignee);
  if (params.sender) {
    const ids = senderCustomerIds ?? [];
    // NIL_UUID guarantees an empty result rather than dropping the filter when
    // the sender matched no customer — otherwise a typo would silently show
    // the whole inbox.
    q = q.in("customer_id", ids.length ? ids : [NIL_UUID]);
  }

  return q as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Resolves a free-text sender filter to the customer ids it matches.
 *
 * Name OR email, substring, case-insensitive. A name that several customer
 * records share (the same person writing from two addresses) resolves to all
 * of them, so the filter follows the person rather than one address — but ONLY
 * when the records genuinely share a name. It does not invent a link between
 * two addresses the database does not already relate.
 */
export async function resolveSenderCustomerIds(
  supabase: SupabaseClient,
  sender: string
): Promise<string[]> {
  // Strip the characters that are structural in a PostgREST `or` string, and
  // the `*` wildcard, so the term matches literally.
  const term = sender.replace(/[,()*]/g, " ").trim();
  if (!term) return [];
  const pattern = `*${term}*`;
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .or(`name.ilike.${pattern},email.ilike.${pattern}`)
    .limit(500);
  if (error) {
    console.error("[ticket-query] sender resolution failed:", error.message);
    // A failed lookup must not read as "no sender matched" (which would show
    // the whole inbox). Returning [] forces zero results — the honest outcome
    // when we could not determine who the sender is.
    return [];
  }
  return (data ?? []).map((row) => row.id as string);
}

/** Serialises the view back into a query string, omitting defaults. */
export function viewQueryString(params: TicketViewParams): string {
  const search = new URLSearchParams();
  if (params.view && params.view !== "open") search.set("view", params.view);
  if (params.channel) search.set("channel", params.channel);
  if (params.sort && params.sort !== "newest") search.set("sort", params.sort);
  if (params.customer) search.set("customer", params.customer);
  if (params.assignee) search.set("assignee", params.assignee);
  if (params.sender) search.set("sender", params.sender);
  // Only the non-default My-tickets scopes travel; "open" is the resting state
  // and stays out of the URL, exactly like `view=open` and `sort=newest`.
  if (params.status && params.status !== "open")
    search.set("status", params.status);
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** Where "back to the list" goes for a given view. */
export function inboxHref(params: TicketViewParams): string {
  return `/inbox${viewQueryString(params)}`;
}

/**
 * The ticket after `currentId` in an ordered list of ids.
 *
 * Returns null when it's the last one, or when the ticket isn't in the list
 * at all — someone opened it directly rather than from the inbox — and the
 * caller should fall back to the list.
 */
export function nextTicketId(
  orderedIds: string[],
  currentId: string
): string | null {
  const index = orderedIds.indexOf(currentId);
  if (index === -1) return null;
  return orderedIds[index + 1] ?? null;
}

/** Link to a ticket that carries the view, so it can advance within it. */
export function ticketHref(id: string, params: TicketViewParams): string {
  return `/tickets/${id}${viewQueryString(params)}`;
}

export type SupabaseLike = SupabaseClient;
