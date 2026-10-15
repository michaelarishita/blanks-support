/**
 * Faceting for the search results page — the pure half.
 *
 * The question a search usually answers is not "list every match" but "is
 * there anything of this customer's still needing me". That is a COUNT per
 * status, from the current query — so the facets are computed here, over the
 * rows the RPC returned, with no database of their own. Kept dependency-light
 * so the same counting runs on the server render and in a test.
 */

import { agentDisplayName } from "@/lib/display";
import { CHANNEL_META, type TicketChannel, type TicketStatus } from "@/lib/types";
import type { SearchRow } from "@/lib/search";

/**
 * The three buckets the status facet offers. The raw ticket statuses collapse
 * into these because that is the question being asked: is it still open, is it
 * done, or was it junked — not whether it is `new` vs `open` vs `pending`.
 */
export type StatusBucket = "open" | "resolved" | "junk";
export const STATUS_BUCKETS: StatusBucket[] = ["open", "resolved", "junk"];
export const STATUS_BUCKET_LABEL: Record<StatusBucket, string> = {
  open: "Open",
  resolved: "Resolved",
  junk: "Junk",
};

/**
 * Default selection: Open and Resolved, Junk EXCLUDED.
 *
 * 168 junk tickets would bury real threads. But junk is deselected, never
 * hidden — its count stays visible and one click brings it in, because
 * sometimes you are searching precisely because something was junked wrongly.
 */
export const DEFAULT_BUCKETS: StatusBucket[] = ["open", "resolved"];

export function statusBucket(status: TicketStatus): StatusBucket {
  if (status === "junk") return "junk";
  if (status === "resolved" || status === "closed") return "resolved";
  return "open"; // new, open, pending — the actionable set
}

/** The assignee facet key: a real id, or the sentinel for unassigned. */
export const UNASSIGNED = "unassigned";

export interface SearchFilters {
  /** Selected status buckets. */
  statuses: StatusBucket[];
  channel: TicketChannel | null;
  /** Agent id, the UNASSIGNED sentinel, or null for "any". */
  assignee: string | null;
}

/**
 * Reads filters from the URL. An ABSENT status param means the default
 * (Open + Resolved), never "all" — the whole point is that junk stays out
 * until asked for. `status=all` is the explicit opt-in to everything.
 */
export function parseFilters(params: {
  status?: string | null;
  channel?: string | null;
  assignee?: string | null;
}): SearchFilters {
  const raw = params.status?.trim().toLowerCase();
  let statuses: StatusBucket[];
  if (!raw) {
    statuses = [...DEFAULT_BUCKETS];
  } else if (raw === "all") {
    statuses = [...STATUS_BUCKETS];
  } else {
    const parsed = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is StatusBucket => (STATUS_BUCKETS as string[]).includes(s));
    // A malformed/empty status param falls back to the default rather than
    // matching nothing — a URL typo must not render a customer invisible.
    statuses = parsed.length ? parsed : [...DEFAULT_BUCKETS];
  }

  const channelRaw = params.channel?.trim();
  const channel =
    channelRaw && channelRaw in CHANNEL_META ? (channelRaw as TicketChannel) : null;

  const assignee = params.assignee?.trim() || null;
  return { statuses, channel, assignee };
}

/** True when the selection is exactly the default (so it can stay out of the URL). */
export function isDefaultStatus(statuses: StatusBucket[]): boolean {
  return (
    statuses.length === DEFAULT_BUCKETS.length &&
    DEFAULT_BUCKETS.every((b) => statuses.includes(b))
  );
}

function assigneeKeyOf(row: SearchRow): string {
  return row.assignee_id ?? UNASSIGNED;
}

/**
 * Does a row satisfy the filters, OPTIONALLY ignoring one facet?
 *
 * Ignoring a facet is how each facet's own counts are computed: the status
 * counts reflect the channel/assignee selection but NOT the status selection,
 * so all three status counts are always shown. Standard faceted-search
 * behaviour — a facet never filters itself out of its own count.
 */
function matches(
  row: SearchRow,
  f: SearchFilters,
  ignore: "status" | "channel" | "assignee" | null
): boolean {
  if (ignore !== "status" && !f.statuses.includes(statusBucket(row.status))) {
    return false;
  }
  if (ignore !== "channel" && f.channel && row.channel !== f.channel) {
    return false;
  }
  if (ignore !== "assignee" && f.assignee) {
    if (f.assignee === UNASSIGNED) {
      if (row.assignee_id) return false;
    } else if (row.assignee_id !== f.assignee) {
      return false;
    }
  }
  return true;
}

/** The rows that match the full filter set — what the list should show. */
export function filterRows(rows: SearchRow[], f: SearchFilters): SearchRow[] {
  return rows.filter((row) => matches(row, f, null));
}

export interface FacetOption<K extends string> {
  key: K;
  label: string;
  count: number;
  selected: boolean;
}

export interface SearchFacets {
  statuses: FacetOption<StatusBucket>[];
  channels: FacetOption<TicketChannel>[];
  assignees: FacetOption<string>[];
}

/**
 * Counts for every facet, from the scanned rows, each facet counted as if it
 * were not filtered. Channels and assignees only list values that actually
 * occur in the matches — an assignee with nothing of this customer's is noise.
 */
export function computeFacets(rows: SearchRow[], f: SearchFilters): SearchFacets {
  const forStatus = rows.filter((r) => matches(r, f, "status"));
  const statuses: FacetOption<StatusBucket>[] = STATUS_BUCKETS.map((b) => ({
    key: b,
    label: STATUS_BUCKET_LABEL[b],
    count: forStatus.filter((r) => statusBucket(r.status) === b).length,
    selected: f.statuses.includes(b),
  }));

  const forChannel = rows.filter((r) => matches(r, f, "channel"));
  const channelCounts = new Map<TicketChannel, number>();
  for (const r of forChannel) {
    channelCounts.set(r.channel, (channelCounts.get(r.channel) ?? 0) + 1);
  }
  const channels: FacetOption<TicketChannel>[] = [...channelCounts.entries()]
    .map(([key, count]) => ({
      key,
      label: CHANNEL_META[key]?.label ?? key,
      count,
      selected: f.channel === key,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const forAssignee = rows.filter((r) => matches(r, f, "assignee"));
  const assigneeAgg = new Map<string, { label: string; count: number }>();
  for (const r of forAssignee) {
    const key = assigneeKeyOf(r);
    const label =
      key === UNASSIGNED
        ? "Unassigned"
        : agentDisplayName({
            name: r.assignee_name,
            display_name: r.assignee_display_name,
          });
    const entry = assigneeAgg.get(key) ?? { label, count: 0 };
    entry.count += 1;
    assigneeAgg.set(key, entry);
  }
  const assignees: FacetOption<string>[] = [...assigneeAgg.entries()]
    .map(([key, { label, count }]) => ({
      key,
      label,
      count,
      selected: f.assignee === key,
    }))
    // Unassigned last; otherwise by count then name.
    .sort((a, b) => {
      if (a.key === UNASSIGNED) return 1;
      if (b.key === UNASSIGNED) return -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });

  return { statuses, channels, assignees };
}

/**
 * When the filtered list is empty but the query DID match things, this is what
 * the page offers instead of a blank: the excluded facet values that WOULD
 * return rows, so "removing this filter shows N" is one click, not a guess.
 */
export function wouldReturn(
  facets: SearchFacets
): { statuses: FacetOption<StatusBucket>[]; channels: FacetOption<TicketChannel>[] } {
  return {
    statuses: facets.statuses.filter((o) => !o.selected && o.count > 0),
    channels: facets.channels.filter((o) => !o.selected && o.count > 0),
  };
}
