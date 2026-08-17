import { cn } from "@/lib/cn";
import type { Attachment } from "@/lib/types";
import { PaperclipIcon } from "@/components/ui/icons";

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Which attachments get a picture.
 *
 * HEIC is deliberately NOT here. Chrome and Firefox cannot decode it, so an
 * <img> would render as a broken-image icon — worse than the chip, which at
 * least says what the file is and downloads on click. Safari could show it;
 * the thread would then look different per browser, which is its own bug.
 */
const THUMBNAILABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

function isThumbnailable(attachment: Attachment): boolean {
  return Boolean(attachment.mime_type && THUMBNAILABLE.has(attachment.mime_type));
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

  const images = attachments.filter(isThumbnailable);
  const others = attachments.filter((a) => !isThumbnailable(a));

  return (
    <div className="mt-2 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((attachment) => (
            <a
              key={attachment.id}
              href={`/api/attachments/${attachment.id}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`${attachment.filename} — ${formatBytes(attachment.size_bytes)}`}
              className={cn(
                "block overflow-hidden rounded-sm border transition-colors duration-micro ease-out",
                onDark
                  ? "border-white/20 hover:border-white/40"
                  : "border-subtle hover:border-strong"
              )}
            >
              {/* Plain <img>, not next/image: the source is a route that 302s
                  to a signed URL which expires in 60s, so there is nothing
                  stable for the optimiser to cache or re-fetch later.
                  ?inline=1 drops the download disposition that would otherwise
                  make this save the file instead of showing it. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/attachments/${attachment.id}?inline=1`}
                alt={attachment.filename}
                loading="lazy"
                className="h-28 w-28 bg-gray-100 object-cover"
              />
            </a>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {others.map((attachment) => (
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
      )}
    </div>
  );
}
