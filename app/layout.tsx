import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blanks Support",
  description: "Blanks Sports Nutrition help desk",
};

/**
 * viewport-fit=cover is what makes env(safe-area-inset-*) resolve to anything
 * other than 0 on a notched iPhone. Without it every safe-area rule in
 * globals.css is inert, the layout looks correct in a devtools emulator, and
 * the header sits under the notch on the one device it matters on.
 *
 * No maximumScale / userScalable: pinch-zoom is an accessibility feature, and
 * locking it is the wrong fix for iOS focus-zoom. The right one is a 16px
 * minimum font-size on inputs, which is the composer's job.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0061ff",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      {/* Colours, type and font stack come from the tokens in globals.css. */}
      <body>{children}</body>
    </html>
  );
}
