import { cn } from "@/lib/cn";
import type { Attachment } from "@/lib/types";
import { PaperclipIcon } from "@/components/ui/icons";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Attachments({
  attachments,
  onDark = false,
}: {
  attachments: Attachment[];
  /** Rendered on an outbound (dark) bubble. */
  onDark?: boolean;
}) {
  if (!attachments.length) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <a
          key={attachment.id}
          // Goes through the API route, which checks the session and issues a
          // short-lived signed URL — the storage path is never exposed.
          href={`/api/attachments/${attachment.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`${attachment.filename} — ${formatBytes(attachment.size_bytes)}`}
          className={cn(
            "inline-flex max-w-[240px] items-center gap-1.5 rounded-sm border px-2 py-1",
            "text-caption transition-colors duration-micro ease-out",
            onDark
              ? "border-white/20 text-gray-200 hover:border-white/40 hover:text-white"
              : "border-subtle text-secondary hover:border-strong hover:text-primary"
          )}
        >
          <PaperclipIcon size={12} className="flex-none" />
          <span className="truncate">{attachment.filename}</span>
          {attachment.size_bytes ? (
            <span className={onDark ? "flex-none text-gray-400" : "flex-none text-tertiary"}>
              {formatBytes(attachment.size_bytes)}
            </span>
          ) : null}
        </a>
      ))}
    </div>
  );
}
