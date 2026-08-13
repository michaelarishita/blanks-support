import { cn } from "@/lib/cn";

/** Shimmering placeholder block. Sized by the caller via className. */
export default function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-sm bg-gray-200",
        // Shimmer rather than pulse — it reads as "loading" instead of
        // "disabled". The reduced-motion rule in globals.css stops it.
        // Tokens are RGB channels, so they need wrapping in rgb() here.
        "bg-[linear-gradient(90deg,rgb(var(--gray-200))_25%,rgb(var(--gray-100))_37%,rgb(var(--gray-200))_63%)]",
        "bg-[length:200%_100%] animate-shimmer",
        className
      )}
    />
  );
}

/** Matches the geometry of a TicketList row so the swap doesn't jump. */
export function TicketRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-subtle px-4 py-3 last:border-b-0">
      <Skeleton className="h-4 w-4 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-6 w-6 rounded-full" />
      <Skeleton className="h-5 w-16 rounded-full" />
      <Skeleton className="h-3 w-10" />
    </div>
  );
}
