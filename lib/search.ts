/**
 * Full-text search — the pure half.
 *
 * The SQL lives in 0024_search.sql and the query runs there; everything a test
 * or a component needs to reason about without a database is here. Kept
 * dependency-free so the snippet parsing runs identically on the server render
 * and any client that reuses it.
 */

import type { TicketChannel, TicketPriority, TicketStatus } from "@/lib/types";

/**
 * The highlight delimiters ts_headline wraps matched terms in.
 *
 * Two CONTROL characters, NOT `<mark>`: the snippet is built from raw customer
 * text, which can contain anything, and returning HTML from the database to be
 * rendered as markup would reintroduce the injection the thread avoids by
 * rendering inbound bodies as plain text. Control characters never appear in
 * real email, so `renderSnippet` can split on them and the caller wraps the
 * matches itself — with everything else escaped as ordinary text by React.
 *
 * These MUST match the StartSel/StopSel in 0024_search.sql (\x01 / \x02).
 */
export const HL_START = "\u0001";
export const HL_END = "\u0002";

/**
 * How many results the RPC returns. When the true match count exceeds this,
 * the page says so rather than presenting a silent partial answer — a capped
 * search that looks complete is the same defect class as an inbox showing zero
 * over eight live tickets.
 */
export const MAX_SEARCH_RESULTS = 50;

/** Shape of one row from the `search_tickets` RPC. */
export interface SearchRow {
  id: string;
  number: number;
  subject: string;
  status: TicketStatus;
  channel: TicketChannel;
  priority: TicketPriority;
  last_message_at: string;
  created_at: string;
  customer_id: string;
  customer_name: string | null;
  customer_email: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_display_name: string | null;
  /** Which field the best match was found in. */
  matched_in: "subject" | "message" | "customer" | "number";
  /** ts_headline output, delimited with HL_START / HL_END. */
  snippet: string | null;
  rank: number;
  /** The full match count before the cap; identical on every row. */
  total_matches: number;
}

/** A run of snippet text, flagged if it was a matched term. */
export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

/**
 * Trims a raw query and returns null when there is nothing to search for.
 *
 * A blank or whitespace query must NOT be handed to the RPC — an empty search
 * is not "everything", it is nothing, and the page shows its resting state
 * rather than the entire inbox.
 */
export function normalizeQuery(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Splits a delimited snippet into highlighted and plain runs.
 *
 * Tolerant of malformed delimiter runs: an unmatched start or end simply
 * toggles the state, so a truncated ts_headline fragment can never throw.
 */
export function renderSnippet(snippet: string | null | undefined): SnippetSegment[] {
  if (!snippet) return [];
  const segments: SnippetSegment[] = [];
  let buffer = "";
  let highlight = false;

  const flush = () => {
    if (buffer) segments.push({ text: buffer, highlight });
    buffer = "";
  };

  for (const ch of snippet) {
    if (ch === HL_START) {
      flush();
      highlight = true;
    } else if (ch === HL_END) {
      flush();
      highlight = false;
    } else {
      buffer += ch;
    }
  }
  flush();
  return segments;
}

/** Human phrasing for where the match was found, shown on each result row. */
export function matchedInLabel(matchedIn: SearchRow["matched_in"]): string {
  switch (matchedIn) {
    case "subject":
      return "Subject";
    case "message":
      return "Message";
    case "customer":
      return "Customer";
    case "number":
      return "Ticket number";
    default:
      return "Match";
  }
}

/**
 * True when the RPC returned fewer rows than exist.
 *
 * Read from `total_matches` (a window count taken before the cap) rather than
 * inferred from `rows.length === MAX`, so it stays correct if the cap changes
 * and never claims truncation on an exactly-full page that happened to be the
 * whole set.
 */
export function isTruncated(rows: Pick<SearchRow, "total_matches">[]): boolean {
  if (!rows.length) return false;
  return rows[0].total_matches > rows.length;
}
