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
 * DELIBERATELY NO `deploymentId` HERE. Setting one broke production.
 *
 * Vercel sets NEXT_DEPLOYMENT_ID to its own `dpl_...` identifier. Next 16
 * compares that against a config `deploymentId` and THROWS on any mismatch,
 * before compiling anything — which is how a build fails in four seconds with
 * nothing useful on screen. We set ours to the git sha, so every production
 * build after that change failed, for four days, silently.
 *
 * The trap is that this only fires on Vercel: the check is gated on
 * `hasNextSupport`, which is `!!process.env.NOW_BUILDER`. Locally the config
 * value is simply used, so it builds fine and looks correct.
 *
 * Note the docs and the implementation disagree in 16.3.0. The doc says "if
 * both are set, the config value takes precedence over the environment
 * variable"; `server/config.ts` throws on the mismatch and then does
 * `result.deploymentId = process.env.NEXT_DEPLOYMENT_ID` unconditionally. So
 * on Vercel the config value could never have been used even if it had been
 * allowed through. Trust the code here, not the page.
 *
 * With no config value, Vercel's own id is picked up from the environment and
 * Skew Protection works exactly as it is meant to — `?dpl=` on assets, and a
 * hard navigation on a mismatched client transition. Off Vercel there is no
 * id and no skew protection, which is right for a dev server.
 *
 * Nothing in the app reads this. The build-sha meta tag, /api/version and
 * VersionWatcher all source their identity from VERCEL_GIT_COMMIT_SHA
 * independently — verified, not assumed.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
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
