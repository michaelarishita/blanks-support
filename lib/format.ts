/**
 * Compact relative time — "4m", "2h", "3d", "5w", "1y".
 * Inbox rows show a lot of these; the long form ("about 2 hours") makes the
 * column ragged and pushes the status badge around.
 */
export function shortAgo(input: string | Date): string {
  const then = typeof input === "string" ? new Date(input) : input;
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000);

  if (seconds < 60) return "now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  const weeks = days / 7;
  if (weeks < 52) return `${Math.floor(weeks)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** "Today" / "Yesterday" / "Aug 12" / "Aug 12, 2024" for thread day dividers. */
export function dayLabel(input: string | Date): string {
  const date = typeof input === "string" ? new Date(input) : input;
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}
