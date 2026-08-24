import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * What a failed read looks like on screen.
 *
 * Exists because the alternative keeps being chosen by accident: a discarded
 * error leaves `data: null`, `null` becomes an empty array or a missing row,
 * and the page renders "Inbox zero" or "not found" over live customer
 * tickets. Those are indistinguishable from the real thing, so a failure has
 * to say so in its own words, with the database's reason attached.
 *
 * Rendered inline rather than thrown. A server-component throw reaches
 * production as a digest with the message stripped, so the one piece of
 * information worth having — WHY — is exactly what would be lost.
 */
export default function QueryError({
  title,
  reason,
  note,
}: {
  title: string;
  reason: string;
  note?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-border bg-danger-bg p-4 text-caption text-danger-text"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex-none">
          <AlertTriangleIcon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 break-words font-mono text-mono opacity-90">{reason}</p>
          {note && <p className="mt-2 opacity-80">{note}</p>}
        </div>
      </div>
    </div>
  );
}
