"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import type { Attachment } from "@/lib/types";
import { XIcon, ChevronRightIcon, ChevronDownIcon } from "@/components/ui/icons";

/**
 * Full-size viewing for image attachments.
 *
 * Customers photograph a whole tub or a whole shipping label, so the useful
 * part of the picture is the whole picture. Clicking used to DOWNLOAD it —
 * which meant leaving the ticket, finding the file, opening a viewer, and
 * coming back. Download is still there, as a button, once you can see what
 * you're downloading.
 *
 * The provider sits at the THREAD level rather than per message, because the
 * arrow keys should walk every photo on the ticket. A customer who sends four
 * pictures of the same damaged box in one message and a fifth in a follow-up
 * has sent five pictures of one problem.
 */

export interface LightboxImage {
  id: string;
  filename: string;
  sizeBytes: number | null;
}

interface LightboxApi {
  /** Opens at this attachment id. Ignored if it isn't a viewable image. */
  open: (id: string) => void;
  /** Whether this attachment can be opened, so chips know how to behave. */
  canOpen: (id: string) => boolean;
}

const LightboxContext = createContext<LightboxApi>({
  open: () => {},
  canOpen: () => false,
});

export function useLightbox(): LightboxApi {
  return useContext(LightboxContext);
}

/**
 * Which attachments get the full-size treatment.
 *
 * HEIC is absent on purpose: Chrome and Firefox cannot decode it, so opening
 * one would present a broken-image icon in a dark box. It keeps the download
 * chip, which at least does something.
 */
const VIEWABLE = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isViewable(attachment: Attachment): boolean {
  return Boolean(attachment.mime_type && VIEWABLE.has(attachment.mime_type));
}

/**
 * The URL an <img> should use.
 *
 * `inline=1` drops the download disposition. The `r` counter exists for
 * expiry: the route hands back a 302 to a signed URL that lives 60 seconds,
 * so an image opened from a thread that has been sitting open can point at a
 * dead link. Bumping `r` makes it a different URL, which defeats the cache and
 * mints a fresh signature — a plain retry would be served the stale redirect.
 */
export function inlineSrc(id: string, retry = 0): string {
  return `/api/attachments/${id}?inline=1${retry ? `&r=${retry}` : ""}`;
}

export function LightboxProvider({
  images,
  children,
}: {
  /** Every viewable attachment on the ticket, in thread order. */
  images: LightboxImage[];
  children: ReactNode;
}) {
  const [index, setIndex] = useState<number | null>(null);

  const byId = useMemo(
    () => new Map(images.map((image, i) => [image.id, i])),
    [images]
  );

  const api = useMemo<LightboxApi>(
    () => ({
      open: (id: string) => {
        const found = byId.get(id);
        if (found !== undefined) setIndex(found);
      },
      canOpen: (id: string) => byId.has(id),
    }),
    [byId]
  );

  return (
    <LightboxContext.Provider value={api}>
      {children}
      {index !== null && (
        <Lightbox
          images={images}
          index={index}
          onIndex={setIndex}
          onClose={() => setIndex(null)}
        />
      )}
    </LightboxContext.Provider>
  );
}

function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: LightboxImage[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const image = images[index];
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);

  // A new picture is a new load, and a new chance for the signed URL to have
  // expired — so the retry budget resets with it.
  useEffect(() => {
    setRetry(0);
    setLoading(true);
  }, [index]);

  const go = useCallback(
    (delta: number) => {
      if (images.length < 2) return;
      // Wraps, because a viewer that dead-ends at the last photo makes people
      // close it and reopen the first one.
      onIndex((index + delta + images.length) % images.length);
    },
    [images.length, index, onIndex]
  );

  useEffect(() => {
    panelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [go, onClose]);

  if (typeof document === "undefined" || !image) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-gray-950/90 animate-fade-in"
      // Click-outside: only when the backdrop itself is hit, so a click that
      // began on the image and drifted doesn't dismiss it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={image.filename}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col outline-none"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {/* Toolbar */}
        <div className="flex flex-none items-center gap-3 px-3 py-2 text-white">
          <span className="min-w-0 flex-1 truncate text-label">
            {image.filename}
            {images.length > 1 && (
              <span className="ml-2 text-caption text-gray-400">
                {index + 1} of {images.length}
              </span>
            )}
          </span>

          {/* Download is a BUTTON here, not the click action on the thumbnail.
              Seeing the picture is the common case; saving it is not. */}
          <a
            href={`/api/attachments/${image.id}`}
            className="flex h-11 items-center gap-1.5 rounded-md px-3 text-label text-gray-200 hover:bg-white/10 hover:text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronDownIcon size={14} />
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            // 44px, because this is the control someone reaches for on a phone
            // and missing it means fighting the viewer.
            className="flex h-11 w-11 flex-none items-center justify-center rounded-md text-gray-200 hover:bg-white/10 hover:text-white"
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* Stage */}
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center p-2 sm:p-6"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          {loading && (
            <span className="absolute text-caption text-gray-400">Loading…</span>
          )}

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={`${image.id}-${retry}`}
            src={inlineSrc(image.id, retry)}
            alt={image.filename}
            onLoad={() => setLoading(false)}
            onError={() => {
              // One retry, and only one: a signed URL that expired mid-view
              // mints a fresh one, but a genuinely missing object must not
              // become an infinite reload loop against our own API.
              if (retry === 0) {
                setRetry(1);
                return;
              }
              setLoading(false);
            }}
            // Fitted, never cropped, and pinch-zoom left to the browser —
            // `touch-action` is what stops the page from swallowing the gesture.
            className="max-h-full max-w-full object-contain"
            style={{ touchAction: "pinch-zoom" }}
          />

          {images.length > 1 && (
            <>
              <StageButton side="left" onClick={() => go(-1)} />
              <StageButton side="right" onClick={() => go(1)} />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function StageButton({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={side === "left" ? "Previous attachment" : "Next attachment"}
      className={cn(
        "absolute top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center",
        "rounded-full bg-gray-950/60 text-white transition-colors duration-micro ease-out",
        "hover:bg-gray-950/80",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      <ChevronRightIcon size={18} className={side === "left" ? "rotate-180" : ""} />
    </button>
  );
}
