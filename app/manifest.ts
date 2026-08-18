import type { MetadataRoute } from "next";

/**
 * Makes the dashboard installable to a home screen.
 *
 * Cheap, and it changes what we are testing: `display: standalone` removes the
 * browser chrome, which is exactly when `env(safe-area-inset-*)` starts
 * mattering. Testing the mobile layout in a Safari tab and shipping it to a
 * home-screen icon would mean testing a different set of insets from the one
 * the team ends up using.
 *
 * DELIBERATELY NO SERVICE WORKER. A support tool that serves a cached ticket
 * list is worse than a slow one — an agent replying to a resolved ticket, or
 * missing one that arrived, because the shell handed them yesterday's data.
 * The manifest alone gets the icon and the standalone window; nothing here
 * caches anything.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Blanks Support",
    short_name: "Support",
    description: "Blank's Sports Nutrition help desk",
    start_url: "/inbox",
    display: "standalone",
    // Matches the panel the app opens on, so the status bar doesn't flash a
    // different colour on launch.
    background_color: "#ffffff",
    theme_color: "#0061ff",
    orientation: "any",
    icons: [
      {
        // SVG, because there is no raster app icon in the repo yet and a
        // stretched placeholder PNG would look worse than a clean wordmark.
        // Replace with 192/512 PNGs when Michael supplies artwork.
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
