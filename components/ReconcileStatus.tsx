export interface ReconcileSummary {
  /** When the last CLEAN-or-complete run finished. Null if it could not run. */
  at: string | null;
  attemptedAt?: string | null;
  windowDays?: number;
  examined?: number;
  accounted?: Record<string, number>;
  discrepancies?: number;
  hitCap?: boolean;
  error?: string | null;
}

/**
 * When the mailbox was last reconciled against our record.
 *
 * The whole value of the reconciliation is that its silence means something,
 * and silence only means something if you can see it ran. Without this the job
 * could stop and look identical to a mailbox with nothing wrong.
 */
export default function ReconcileStatus({ last }: { last: ReconcileSummary | null }) {
  if (!last) {
    return (
      <p className="text-sm text-gray-500">
        Never run. This is the check that would notice mail going missing for a
        reason nothing else watches — it runs daily with the overnight jobs.
      </p>
    );
  }

  if (last.error) {
    return (
      <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
        <span className="font-semibold">The last reconciliation failed.</span>{" "}
        {last.error}
        {last.at && (
          <span className="mt-1 block opacity-80">
            Last successful run: <RelativeTime iso={last.at} />.
          </span>
        )}
      </div>
    );
  }

  if (!last.at) {
    return (
      <p className="text-sm text-gray-500">Has not completed a run yet.</p>
    );
  }

  const a = last.accounted ?? {};
  return (
    <div className="text-sm text-gray-600">
      <p>
        <span className="font-semibold text-gray-800">
          Checked <RelativeTime iso={last.at} />
        </span>{" "}
        — {last.examined ?? 0} message{last.examined === 1 ? "" : "s"} over the
        last {last.windowDays ?? 7} days,{" "}
        {last.discrepancies ? (
          <span className="font-semibold text-danger-text">
            {last.discrepancies} unaccounted for
          </span>
        ) : (
          <span className="text-emerald-700">all accounted for</span>
        )}
        .
      </p>
      <p className="mt-0.5 text-caption text-gray-500">
        {a.stored ?? 0} stored · {a.guardDropped ?? 0} dropped by a guard ·{" "}
        {a.quarantined ?? 0} quarantined · {a.goneFromMailbox ?? 0} gone from
        the mailbox · {a.tooRecent ?? 0} too recent to judge
      </p>
      {last.hitCap && (
        // Never a silent cap: a window that filled up has not been fully
        // checked, and saying "all accounted for" about it would be a lie.
        <p className="mt-1 text-caption text-warning-text">
          The window filled up, so older mail in it was not examined.
        </p>
      )}
    </div>
  );
}

/** Absolute date in a title, relative text in the body. */
function RelativeTime({ iso }: { iso: string }) {
  const at = new Date(iso);
  const hours = Math.floor((Date.now() - at.getTime()) / 3_600_000);
  const text =
    hours < 1 ? "less than an hour ago" : hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  return <time dateTime={iso} title={at.toISOString()}>{text}</time>;
}
