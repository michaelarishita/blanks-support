/**
 * Origins allowed to FRAME /widget.
 *
 * Duplicated from FALLBACK_ORIGINS in lib/cors.ts deliberately: this file is
 * .mjs and cannot import the TypeScript module, and converting the config to
 * .ts is not a risk worth taking on a project that has already lost days to
 * Vercel build failures. tests/widget-framing.test.ts imports BOTH this array
 * and lib/cors.ts's and fails if they drift apart.
 *
 * Exported for that test. Next reads only the default export, so extra named
 * exports here are inert.
 */
export const WIDGET_FRAME_FALLBACK_ORIGINS = [
  "https://blankssportsnutrition.com",
  "https://www.blankssportsnutrition.com",
];

/**
 * The frame-ancestors source list.
 *
 * Read at server start, not per request — WIDGET_ALLOWED_ORIGINS must be set
 * before the build/boot on Vercel, not merely at runtime.
 */
export function frameAncestors() {
  const configured = (process.env.WIDGET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const origins = new Set(
    configured.length ? configured : WIDGET_FRAME_FALLBACK_ORIGINS
  );
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    origins.add(process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, ""));
  }

  // 'self' keeps the standalone page working: without it, the page can only
  // be framed, never opened directly, which is the opposite of the goal.
  return ["'self'", ...origins].join(" ");
}

/**
 * The build identifier, and the reason the app can tell a stale tab from an
 * outage.
 *
 * Next uses this for version-skew protection: it stamps `data-dpl-id` on the
 * <html> element, appends `?dpl=` to asset URLs, and turns a mismatched
 * client-side navigation into a full reload. We read the same attribute to
 * warn BEFORE an action fails.
 *
 * Undefined in ordinary local development on purpose. With no id there is
 * nothing to compare, so the version watcher stays quiet instead of announcing
 * a new release every time the dev server restarts. Set NEXT_PUBLIC_BUILD_ID
 * by hand to exercise it.
 */
export const BUILD_ID =
  process.env.NEXT_PUBLIC_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA || undefined;

/** @type {import('next').NextConfig} */
const nextConfig = {
  deploymentId: BUILD_ID,
  async headers() {
    return [
      {
        // Only /widget. The rest of the app has no business being framed, and
        // widening this would be a clickjacking surface on the dashboard.
        source: "/widget",
        headers: [
          {
            // frame-ancestors is a HEADER-only directive — the same policy in
            // a <meta> tag is ignored outright, which is the usual reason
            // "I set the CSP and it still doesn't frame" happens.
            key: "Content-Security-Policy",
            value: `frame-ancestors ${frameAncestors()};`,
          },
        ],
      },
    ];
  },
};

// NOTE: X-Frame-Options is deliberately NOT set anywhere. It has no
// multi-origin form — the old ALLOW-FROM was dropped by every browser — so any
// value it could take (DENY, SAMEORIGIN) would contradict frame-ancestors, and
// browsers that understand both prefer X-Frame-Options. A test asserts no
// route configures one.

export default nextConfig;
