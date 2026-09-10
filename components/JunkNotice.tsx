import type { JunkReason } from "@/lib/types";
import { describeJunkReason, JUNK_RETENTION_DAYS } from "@/lib/inbound/junk";

/**
 * Why this ticket is in Junk, shown above the thread.
 *
 * The whole point of the folder is that a drop is no longer a decision with the
 * evidence discarded — so the evidence is on screen: which guard, which rule,
 * the classifier's score. The action ("Not spam") lives in the header and the
 * side panel; this only explains.
 */
export default function JunkNotice({
  reason,
  junkedAt,
}: {
  reason: JunkReason | null | undefined;
  junkedAt: string | null | undefined;
}) {
  const purgeNote = junkedAt
    ? (() => {
        const purgeAt =
          new Date(junkedAt).getTime() + JUNK_RETENTION_DAYS * 86_400_000;
        const daysLeft = Math.max(0, Math.ceil((purgeAt - Date.now()) / 86_400_000));
        return `Purged in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`;
      })()
    : `Purged ${JUNK_RETENTION_DAYS} days after it was junked.`;

  return (
    <div
      role="status"
      className="flex flex-none items-start gap-2 border-b border-subtle bg-gray-50 px-4 py-2.5 text-caption text-secondary sm:px-5"
    >
      <span className="font-semibold text-primary">In Junk</span>
      <span className="min-w-0">
        {describeJunkReason(reason)} It is out of every queue. Choose{" "}
        <span className="font-medium">Not spam</span> to send it to the inbox.{" "}
        <span className="text-tertiary">{purgeNote}</span>
        {(reason?.classifierReasons?.length ?? 0) > 0 && (
          <span className="mt-1 block text-tertiary">
            Classifier signals: {reason!.classifierReasons!.map((r) => r.label).join("; ")}
          </span>
        )}
      </span>
    </div>
  );
}
