import type { Config } from "tailwindcss";

// Every value here points at a token in app/globals.css. Adding a raw hex or
// px value to this file (or to a component) means the token layer has a gap —
// fill the gap instead.
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
        gray: {
          50: "var(--gray-50)",
          100: "var(--gray-100)",
          200: "var(--gray-200)",
          300: "var(--gray-300)",
          400: "var(--gray-400)",
          500: "var(--gray-500)",
          600: "var(--gray-600)",
          700: "var(--gray-700)",
          800: "var(--gray-800)",
          900: "var(--gray-900)",
          950: "var(--gray-950)",
        },
        // The brand accent. Also aliased as `amber` so pre-existing amber-*
        // classes pick up the real brand yellow rather than Tailwind's orange.
        brand: {
          50: "var(--brand-50)",
          100: "var(--brand-100)",
          200: "var(--brand-200)",
          300: "var(--brand-300)",
          400: "var(--brand-400)",
          500: "var(--brand-500)",
          600: "var(--brand-600)",
          700: "var(--brand-700)",
          800: "var(--brand-800)",
          900: "var(--brand-900)",
          950: "var(--brand-950)",
        },
        amber: {
          50: "var(--brand-50)",
          100: "var(--brand-100)",
          200: "var(--brand-200)",
          300: "var(--brand-300)",
          400: "var(--brand-400)",
          500: "var(--brand-500)",
          600: "var(--brand-600)",
          700: "var(--brand-700)",
          800: "var(--brand-800)",
          900: "var(--brand-900)",
          950: "var(--brand-950)",
        },
        success: {
          bg: "var(--success-bg)",
          border: "var(--success-border)",
          text: "var(--success-text)",
        },
        warning: {
          bg: "var(--warning-bg)",
          border: "var(--warning-border)",
          text: "var(--warning-text)",
        },
        danger: {
          bg: "var(--danger-bg)",
          border: "var(--danger-border)",
          text: "var(--danger-text)",
        },
        info: {
          bg: "var(--info-bg)",
          border: "var(--info-border)",
          text: "var(--info-text)",
        },
      },
      backgroundColor: {
        surface: "var(--surface)",
        panel: "var(--panel)",
      },
      borderColor: {
        subtle: "var(--border-subtle)",
        strong: "var(--border-strong)",
      },
      textColor: {
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        tertiary: "var(--text-tertiary)",
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
