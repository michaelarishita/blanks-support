/**
 * Origin allowlist for the public widget intake endpoint.
 *
 * Scope note: the embedded widget renders `/widget` in a same-origin iframe,
 * so its own POST never needs CORS. This allowlist exists to stop *other*
 * sites scripting the endpoint from a visitor's browser. It is not a spam
 * control — CORS is enforced by browsers, not by curl — so the honeypot and
 * rate limit in the route remain the real defences.
 */

/**
 * Exported so tests can hold next.config.mjs's copy of this list against it —
 * that file is .mjs and cannot import from here, so the two are kept in step
 * by a test rather than by the module system.
 */
export const FALLBACK_ORIGINS = [
  "https://blankssportsnutrition.com",
  "https://www.blankssportsnutrition.com",
];

export function allowedOrigins(): string[] {
  const configured = (process.env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const origins = new Set(configured.length ? configured : FALLBACK_ORIGINS);

  // Our own deployment, so the widget page works when framed from anywhere
  // we host it ourselves.
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    origins.add(process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, ""));
  }
  // Local dev only — never added to a production build.
  if (process.env.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
  }

  return [...origins];
}

/**
 * A request with no Origin header is same-origin or non-browser (curl, a
 * server, a health check). Those are allowed through: blocking them would
 * break the widget's own same-origin POST for no security gain, since
 * anything that can omit the header can also forge it.
 */
export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true;
  return allowedOrigins().includes(origin.replace(/\/$/, ""));
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // The response varies by Origin, so a shared cache must not reuse one
    // origin's CORS headers for another.
    Vary: "Origin",
  };

  // Echo the specific origin rather than "*": that's what the allowlist is.
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
