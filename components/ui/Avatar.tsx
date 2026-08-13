import { cn } from "@/lib/cn";

// Deterministic colour per identity: the same person is always the same
// colour across the inbox, thread and side panel, which is what makes an
// avatar scannable rather than decorative.
const PALETTE = [
  "bg-[#4f7cf7] text-white",
  "bg-[#7c5cf0] text-white",
  "bg-[#c14fb8] text-white",
  "bg-[#d9534f] text-white",
  "bg-[#d97a2b] text-white",
  "bg-[#3f9d6d] text-white",
  "bg-[#2b9aa8] text-white",
  "bg-[#5a6b7d] text-white",
];

function hashToIndex(seed: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // keep in int32
  }
  return Math.abs(hash) % buckets;
}

/** First letter of the first two words — "Jane Doe" → JD, "support" → S. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.slice(0, 2).map((w) => w[0]);
  return letters.join("").toUpperCase();
}

const SIZES = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-[11px]",
  lg: "h-10 w-10 text-[13px]",
} as const;

export default function Avatar({
  name,
  /** Stable identity for colour selection — an id, not the display name. */
  seed,
  src,
  size = "md",
  className,
  title,
}: {
  name: string;
  seed?: string | null;
  src?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  title?: string;
}) {
  const label = title ?? name;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- avatars are
      // remote Google/Gravatar URLs; next/image would need per-host config.
      <img
        src={src}
        alt=""
        title={label}
        className={cn(
          "flex-none rounded-full object-cover ring-1 ring-black/5",
          SIZES[size],
          className
        )}
      />
    );
  }

  return (
    <span
      title={label}
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none select-none items-center justify-center rounded-full font-semibold ring-1 ring-black/5",
        SIZES[size],
        PALETTE[hashToIndex(seed || name || "?", PALETTE.length)],
        className
      )}
    >
      {initials(name)}
    </span>
  );
}
