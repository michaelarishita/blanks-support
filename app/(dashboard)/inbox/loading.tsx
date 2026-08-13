import Skeleton, { TicketRowSkeleton } from "@/components/ui/Skeleton";

// Shown while the inbox query runs, so the list fades in rather than popping.
export default function InboxLoading() {
  return (
    <div className="mx-auto max-w-4xl px-6 pb-10">
      <div className="sticky top-0 z-20 -mx-6 mb-3 border-b border-subtle bg-surface/85 px-6 py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-5 w-8 rounded-full" />
          <div className="flex-1" />
          <Skeleton className="h-7 w-32 rounded-sm" />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-subtle bg-panel shadow-sm">
        {Array.from({ length: 8 }).map((_, i) => (
          <TicketRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
