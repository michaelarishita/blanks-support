"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { XIcon } from "@/components/ui/icons";
import {
  STATUS_BUCKETS,
  isDefaultStatus,
  type SearchFacets,
  type SearchFilters,
  type StatusBucket,
} from "@/lib/search-facets";
import type { TicketChannel } from "@/lib/types";

/**
 * Faceted filters for the search results page. One set of controls, shown as a
 * row on desktop and inside a sheet on mobile — the same vocabulary as the
 * inbox filters, never a second one.
 *
 * Every control writes to the URL (via replace, so refining doesn't stack
 * history), so a filtered search is bookmarkable and survives editing the
 * query. The counts come from the current query and are always visible —
 * including Junk's, which is deselected by default but one click away, because
 * sometimes the thing you're looking for is the one that got junked wrongly.
 */
export default function SearchFilters({
  facets,
  filters,
}: {
  facets: SearchFacets;
  filters: SearchFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);

  function apply(next: SearchFilters) {
    const q = new URLSearchParams(params.toString());

    // Status: default (Open+Resolved) stays out of the URL; everything else is
    // explicit so the URL reads as what you'd expect to share.
    if (isDefaultStatus(next.statuses)) q.delete("status");
    else if (next.statuses.length === STATUS_BUCKETS.length) q.set("status", "all");
    else q.set("status", [...next.statuses].sort().join(","));

    if (next.channel) q.set("channel", next.channel);
    else q.delete("channel");

    if (next.assignee) q.set("assignee", next.assignee);
    else q.delete("assignee");

    router.replace(`${pathname}?${q.toString()}`);
  }

  function toggleStatus(bucket: StatusBucket) {
    const has = filters.statuses.includes(bucket);
    const next = has
      ? filters.statuses.filter((b) => b !== bucket)
      : [...filters.statuses, bucket];
    // Never let the list empty out to "match nothing you can't see" — the last
    // selected status is sticky; deselect it by picking another instead.
    if (next.length === 0) return;
    apply({ ...filters, statuses: next });
  }

  // Channel/assignee are single-select: clicking the active one clears it.
  function pickChannel(channel: TicketChannel) {
    apply({ ...filters, channel: filters.channel === channel ? null : channel });
  }
  function pickAssignee(key: string) {
    apply({ ...filters, assignee: filters.assignee === key ? null : key });
  }

  function reset() {
    const q = new URLSearchParams(params.toString());
    q.delete("status");
    q.delete("channel");
    q.delete("assignee");
    router.replace(`${pathname}?${q.toString()}`);
  }

  const activeCount =
    (isDefaultStatus(filters.statuses) ? 0 : 1) +
    (filters.channel ? 1 : 0) +
    (filters.assignee ? 1 : 0);

  const controls = (
    <div className="flex flex-col gap-3">
      <FacetGroup label="Status">
        {facets.statuses.map((o) => (
          <Pill
            key={o.key}
            label={o.label}
            count={o.count}
            selected={o.selected}
            onClick={() => toggleStatus(o.key)}
          />
        ))}
      </FacetGroup>

      {facets.channels.length > 0 && (
        <FacetGroup label="Channel">
          {facets.channels.map((o) => (
            <Pill
              key={o.key}
              label={o.label}
              count={o.count}
              selected={o.selected}
              onClick={() => pickChannel(o.key)}
            />
          ))}
        </FacetGroup>
      )}

      {facets.assignees.length > 0 && (
        <FacetGroup label="Assignee">
          {facets.assignees.map((o) => (
            <Pill
              key={o.key}
              label={o.label}
              count={o.count}
              selected={o.selected}
              onClick={() => pickAssignee(o.key)}
            />
          ))}
        </FacetGroup>
      )}

      {activeCount > 0 && (
        <button
          type="button"
          onClick={reset}
          className="self-start text-caption text-brand-link underline-offset-2 hover:underline"
        >
          Reset filters
        </button>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: the controls inline. */}
      <div className="hidden rounded-lg border border-subtle bg-panel px-3 py-2.5 sm:block">
        {controls}
      </div>

      {/* Mobile: a button that opens a sheet — never a row of chips wrapping
          three deep. */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        className="flex items-center justify-between rounded-md border border-subtle bg-panel px-3 py-2 text-body text-primary sm:hidden"
      >
        <span>Filters</span>
        <span className="text-caption text-tertiary">
          {activeCount > 0 ? `${activeCount} active` : "Open · Resolved"}
        </span>
      </button>

      {sheetOpen && (
        <FilterSheet onClose={() => setSheetOpen(false)}>{controls}</FilterSheet>
      )}
    </>
  );
}

function FacetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-16 flex-none text-caption font-medium text-tertiary sm:w-auto">
        {label}
      </span>
      {children}
    </div>
  );
}

function Pill({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption transition-colors duration-micro ease-out",
        selected
          ? "border-gray-900 bg-gray-900 text-white"
          : "border-subtle text-secondary hover:border-strong hover:text-primary"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "tnum rounded-full px-1.5 text-[10px] font-semibold",
          selected ? "bg-white/20 text-white" : "bg-gray-100 text-tertiary"
        )}
      >
        {count}
      </span>
    </button>
  );
}

function FilterSheet({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] sm:hidden" role="dialog" aria-modal="true" aria-label="Search filters">
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-gray-950/40"
      />
      <div className="absolute inset-x-0 bottom-0 animate-slide-up rounded-t-2xl bg-panel pb-safe-3 pt-2 shadow-lg">
        <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-gray-300" />
        <div className="flex items-center justify-between px-4 pb-2">
          <span className="text-body font-semibold text-primary">Filters</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Done"
            className="rounded-sm p-1 text-tertiary hover:bg-gray-100 hover:text-primary"
          >
            <XIcon size={16} />
          </button>
        </div>
        <div className="px-4 pb-2">{children}</div>
      </div>
    </div>,
    document.body
  );
}
