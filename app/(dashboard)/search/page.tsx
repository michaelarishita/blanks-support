import { createClient } from "@/lib/supabase/server";
import SearchBox from "@/components/SearchBox";
import SearchResults from "@/components/SearchResults";
import QueryError from "@/components/QueryError";
import EmptyState from "@/components/ui/EmptyState";
import { SearchIcon } from "@/components/ui/icons";
import {
  MAX_SEARCH_RESULTS,
  isTruncated,
  normalizeQuery,
  type SearchRow,
} from "@/lib/search";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = normalizeQuery(q);

  return (
    <div className="mx-auto max-w-4xl px-3 pb-10 pt-3 sm:px-6">
      <div className="mb-4">
        <SearchBox initialQuery={query ?? ""} autoFocus />
        <p className="mt-2 px-1 text-caption text-tertiary">
          Searches subjects, message bodies, customers and ticket numbers —
          resolved tickets included.
        </p>
      </div>

      {query ? (
        <Results query={query} />
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

async function Results({ query }: { query: string }) {
  const supabase = await createClient();

  // The error is READ, and it is the whole point of this branch. A search that
  // FAILED and a search that MATCHED NOTHING look identical on screen — an
  // empty list — and lead to opposite actions: retry versus rephrase. Rendering
  // a failure as "no results found" is the same class of lie as an inbox
  // showing zero over eight live tickets.
  const { data, error } = await supabase.rpc("search_tickets", {
    q: query,
    include_resolved: true,
    max_results: MAX_SEARCH_RESULTS,
  });

  if (error) {
    return (
      <QueryError
        title="Search could not run — this is NOT “no results found”."
        reason={`${error.message}${error.hint ? ` — ${error.hint}` : ""}`}
        note="Nothing was searched. Try again; if it keeps failing, the search index migration (0023) may not be applied."
      />
    );
  }

  const rows = (data as SearchRow[] | null) ?? [];

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-subtle bg-panel">
        <EmptyState
          icon={<SearchIcon size={20} />}
          title={`No tickets matched “${query}”`}
          description="Every ticket was searched, including resolved ones. Try fewer or different words."
        />
      </div>
    );
  }

  const truncated = isTruncated(rows);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-caption text-tertiary">
          {truncated
            ? `${rows.length} of ${rows[0].total_matches} matches`
            : `${rows.length} ${rows.length === 1 ? "match" : "matches"}`}
        </span>
      </div>

      {/* A capped answer says so, on screen. A silent partial answer to a
          search reads as "that's everything", which is exactly wrong. */}
      {truncated && (
        <p
          role="status"
          className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-caption text-warning-text"
        >
          Showing the {rows.length} best matches of {rows[0].total_matches}. Add
          a word to narrow the search.
        </p>
      )}

      <SearchResults rows={rows} />
    </div>
  );
}
