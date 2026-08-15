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
  currentAgentId: string | null
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
  if (view === "mine" && currentAgentId)
    q = q.eq("assignee_id", currentAgentId).not("status", "in", "(resolved,closed)");
  if (view === "unassigned")
    q = q.is("assignee_id", null).not("status", "in", "(resolved,closed)");
  if (view === "resolved") q = q.in("status", ["resolved", "closed"]);
  if (params.channel) q = q.eq("channel", params.channel);
  if (params.customer) q = q.eq("customer_id", params.customer);
  if (params.assignee) q = q.eq("assignee_id", params.assignee);

  return q as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Serialises the view back into a query string, omitting defaults. */
export function viewQueryString(params: TicketViewParams): string {
  const search = new URLSearchParams();
  if (params.view && params.view !== "open") search.set("view", params.view);
  if (params.channel) search.set("channel", params.channel);
  if (params.sort && params.sort !== "newest") search.set("sort", params.sort);
  if (params.customer) search.set("customer", params.customer);
  if (params.assignee) search.set("assignee", params.assignee);
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
