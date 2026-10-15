import { createClient } from "@/lib/supabase/server";
import SearchBox from "@/components/SearchBox";
import SearchResults from "@/components/SearchResults";
import SearchFilters from "@/components/SearchFilters";
import QueryError from "@/components/QueryError";
import EmptyState from "@/components/ui/EmptyState";
import { SearchIcon } from "@/components/ui/icons";
import {
  MAX_SEARCH_RESULTS,
  SEARCH_SCAN_LIMIT,
  normalizeQuery,
  type SearchRow,
} from "@/lib/search";
import {
  computeFacets,
  filterRows,
  parseFilters,
  wouldReturn,
  STATUS_BUCKET_LABEL,
} from "@/lib/search-facets";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    channel?: string;
    assignee?: string;
  }>;
}) {
  const sp = await searchParams;
  const query = normalizeQuery(sp.q);

  return (
    <div className="mx-auto max-w-4xl px-3 pb-10 pt-3 sm:px-6">
      <div className="mb-4">
        <SearchBox initialQuery={query ?? ""} autoFocus preserveFilters />
        <p className="mt-2 px-1 text-caption text-tertiary">
          Searches subjects, message bodies, customers and ticket numbers —
          resolved tickets included.
        </p>
      </div>

      {query ? (
        <Results query={query} params={sp} />
      ) : (
        <div className="rounded-lg border border-subtle bg-panel">
          <EmptyState
            icon={<SearchIcon size={20} />}
            title="Search every ticket"
            description="Find a reply you sent months ago by the words in it, or look a customer up by name, email or ticket number."
          />
        </div>
      )}
    </div>
  );
}

async function Results({
  query,
  params,
}: {
  query: string;
  params: { status?: string; channel?: string; assignee?: string };
}) {
  const supabase = await createClient();
  const filters = parseFilters(params);

  // The error is READ, and it is the whole point of this branch. A search that
  // FAILED and a search that MATCHED NOTHING look identical on screen — an
  // empty list — and lead to opposite actions: retry versus rephrase.
  //
  // include_resolved is always true here: the status facet is applied in the
  // page, AFTER the counts are taken, so Junk and Resolved counts are visible
  // even when deselected. The RPC scans up to SEARCH_SCAN_LIMIT so the counts
  // cover the whole match set for any realistic query.
  const { data, error } = await supabase.rpc("search_tickets", {
    q: query,
    include_resolved: true,
    max_results: SEARCH_SCAN_LIMIT,
  });

  if (error) {
    return (
      <QueryError
        title="Search could not run — this is NOT “no results found”."
        reason={`${error.message}${error.hint ? ` — ${error.hint}` : ""}`}
        note="Nothing was searched. Try again; if it keeps failing, the search index migration (0024) may not be applied."
      />
    );
  }

  const scan = (data as SearchRow[] | null) ?? [];

  // Nothing matched the QUERY at all — the customer/words genuinely aren't
  // here. This is the only true "no match"; a filter emptying the list is a
  // different state handled below.
  if (scan.length === 0) {
    return (
      <div className="rounded-lg border border-subtle bg-panel">
        <EmptyState
          icon={<SearchIcon size={20} />}
          title={`No tickets matched “${query}”`}
          description="Every ticket was searched, including resolved and junk. Try fewer or different words."
        />
      </div>
    );
  }

  const totalMatches = scan[0].total_matches;
  // The scan itself was capped — the facet counts are over the best N, not the
  // true total. Rare for a real query; said plainly when it happens.
  const scanCapped = totalMatches > scan.length;

  const facets = computeFacets(scan, filters);
  const matched = filterRows(scan, filters);
  const shown = matched.slice(0, MAX_SEARCH_RESULTS);
  const listTruncated = matched.length > shown.length;

  const suggestions = wouldReturn(facets);
  const suggestionText = [
    ...suggestions.statuses.map(
      (s) => `${s.count} ${STATUS_BUCKET_LABEL[s.key].toLowerCase()}`
    ),
    ...suggestions.channels.map((c) => `${c.count} ${c.label.toLowerCase()}`),
  ];

  return (
    <div className="flex flex-col gap-3">
      <SearchFilters facets={facets} filters={filters} />

      <div className="px-1 text-caption text-tertiary">
        {matched.length > 0 ? (
          <>
            {listTruncated
              ? `Showing ${shown.length} of ${matched.length} with these filters`
              : `${matched.length} ${matched.length === 1 ? "result" : "results"} with these filters`}
            {scanCapped && " · counts are over the first " + scan.length + " best matches"}
          </>
        ) : (
          `${totalMatches} total ${totalMatches === 1 ? "match" : "matches"} for “${query}”`
        )}
      </div>

      {scanCapped && (
        <p
          role="status"
          className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-caption text-warning-text"
        >
          “{query}” matched {totalMatches} tickets — more than the page can count
          exactly. The facet counts are over the {scan.length} best matches. Add a
          word to narrow it.
        </p>
      )}

      {matched.length > 0 ? (
        <SearchResults rows={shown} />
      ) : (
        // A filter combination with no results must never read as "the customer
        // doesn't exist". Say it's the filters, and show what removing them
        // returns — the facet bar above is live, so it's one click.
        <div className="rounded-lg border border-subtle bg-panel">
          <EmptyState
            icon={<SearchIcon size={20} />}
            title="No results with these filters"
            description={
              suggestionText.length
                ? `“${query}” has ${suggestionText.join(", ")} behind the filters you've turned off. Adjust the filters above to see them.`
                : `“${query}” matched ${totalMatches}, but none under the current filters. Reset the filters above.`
            }
          />
        </div>
      )}
    </div>
  );
}
