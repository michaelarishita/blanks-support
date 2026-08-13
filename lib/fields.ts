/**
 * Normalizes a free-text settings field before it is stored.
 *
 * These values are typed by agents and end up inside HTML email. The template
 * escapes them on render, but storing markup would still be wrong — it would
 * show up literally in the plain-text part and in the editor. So tags are
 * stripped here, whitespace is collapsed, and length is capped.
 */
export function plainField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;

  const cleaned = value
    // Drop script/style blocks with their contents, then any remaining tags.
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    // Control characters, including the newlines that would break headers.
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

export const FIELD_LIMITS = {
  name: 80,
  title: 80,
  phone: 40,
  companyName: 80,
  website: 200,
  websiteLabel: 80,
} as const;

/** Normalizes a URL to an absolute http(s) one, or null. */
export function absoluteUrl(value: unknown, maxLength = 200): string | null {
  const cleaned = plainField(value, maxLength);
  if (!cleaned) return null;
  // Accept a bare domain by assuming https, which is what people type.
  const candidate = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Normalizes a hex colour like #f5c518, or null. */
export function hexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(trimmed) ? trimmed : null;
}
