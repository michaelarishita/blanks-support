import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blanks Support",
  description: "Blanks Sports Nutrition help desk",
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
