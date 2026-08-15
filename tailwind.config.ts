import type { Config } from "tailwindcss";

// Every value here points at a token in app/globals.css. Adding a raw hex or
// px value to this file (or to a component) means the token layer has a gap —
// fill the gap instead.
//
// Tokens are RGB channels, referenced as `rgb(var(--x) / <alpha-value>)` so
// Tailwind's opacity modifiers (bg-gray-900/96, ring-brand-400/60) compile
// correctly. A bare `var(--x)` would silently drop the alpha.
const channel = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const ramp = (prefix: string) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [
      step,
      channel(`${prefix}-${step}`),
    ])
  );

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Replaces Tailwind's default neutral so there is exactly one ramp.
        gray: ramp("gray"),
        brand: { ...ramp("brand"), link: channel("brand-link") },
        // No `amber` alias. Amber now means exactly one thing — the semantic
        // warning tone below — so an amber-* class is a mistake, not a brand
        // colour, and should fail to resolve.
        panel: channel("panel"),
        success: {
          bg: channel("success-bg"),
          border: channel("success-border"),
          text: channel("success-text"),
        },
        warning: {
          bg: channel("warning-bg"),
          border: channel("warning-border"),
          text: channel("warning-text"),
        },
        danger: {
          bg: channel("danger-bg"),
          border: channel("danger-border"),
          text: channel("danger-text"),
        },
        info: {
          bg: channel("info-bg"),
          border: channel("info-border"),
          text: channel("info-text"),
        },
      },
      backgroundColor: {
        surface: channel("surface"),
        panel: channel("panel"),
      },
      borderColor: {
        subtle: channel("border-subtle"),
        strong: channel("border-strong"),
      },
      textColor: {
        primary: channel("text-primary"),
        secondary: channel("text-secondary"),
        tertiary: channel("text-tertiary"),
      },
      fontSize: {
        display: ["24px", { lineHeight: "1.2", letterSpacing: "-0.02em" }],
        title: ["18px", { lineHeight: "1.3", letterSpacing: "-0.01em" }],
        body: ["14px", { lineHeight: "1.5" }],
        label: ["13px", { lineHeight: "1.4", fontWeight: "500" }],
        caption: ["12px", { lineHeight: "1.4" }],
        mono: ["12.5px", { lineHeight: "1.4" }],
      },
      borderRadius: {
        sm: "6px",
        md: "8px",
        lg: "12px",
        bubble: "14px",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
      transitionDuration: {
        micro: "var(--duration-micro)",
        panel: "var(--duration-panel)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        shimmer: {
          from: { backgroundPosition: "-200% 0" },
          to: { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in var(--duration-micro) var(--ease-out)",
        "slide-up": "slide-up var(--duration-panel) var(--ease-out)",
        "toast-in": "toast-in var(--duration-panel) var(--ease-out)",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
export default config;
