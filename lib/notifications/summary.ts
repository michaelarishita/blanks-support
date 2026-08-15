import { htmlToPlainText } from "@/lib/html";
import { splitQuotedText } from "@/lib/email/parse";

/**
 * A short preview of what the customer actually said.
 *
 * Deliberately mechanical: strip markup, drop the quoted history a reply
 * carries, collapse whitespace, cut on a word boundary. A real summary is an
 * Ike job later — this is the seam it will replace, not an attempt at it.
 */
export const SUMMARY_MAX_CHARS = 200;

export function summarizeMessage(
  input: { bodyText?: string | null; bodyHtml?: string | null } | null | undefined,
  maxChars = SUMMARY_MAX_CHARS
): string {
  if (!input) return "";

  const raw = input.bodyText?.trim()
    ? input.bodyText
    : htmlToPlainText(input.bodyHtml ?? "");
  if (!raw) return "";

  // Only what they wrote this time, not the thread quoted underneath.
  const { visible } = splitQuotedText(raw);
  const flat = visible.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;

  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour the word boundary if it isn't absurdly early — a single long
  // token shouldn't collapse the preview to nothing.
  const trimmed = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.replace(/[.,;:!?—-]+$/, "")}…`;
}

/** "3 days", "4 hours", "12 minutes" — coarse age for a notification. */
export function describeAge(from: string | Date, now = Date.now()): string {
  const then = typeof from === "string" ? new Date(from) : from;
  const minutes = Math.max(0, Math.floor((now - then.getTime()) / 60_000));

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
