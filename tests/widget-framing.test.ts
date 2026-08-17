import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig, {
  WIDGET_FRAME_FALLBACK_ORIGINS,
  frameAncestors,
} from "../next.config.mjs";
import { FALLBACK_ORIGINS } from "@/lib/cors";
import {
  HEIGHT_MESSAGE_TYPE,
  isUsableHeight,
  resolveParentOrigin,
} from "@/lib/widget-frame";

/**
 * Framing is the kind of thing that fails silently and in one direction: an
 * over-tight policy shows a blank panel on the storefront with the reason
 * buried in the browser console, and an over-loose one lets anyone frame the
 * form to phish with. Neither is visible from inside the app.
 */

describe("frame-ancestors policy", () => {
  it("keeps next.config.mjs's origin list in step with lib/cors.ts", () => {
    // The two lists cannot import each other across the .mjs/.ts line, so the
    // only thing keeping them together is this assertion.
    expect(WIDGET_FRAME_FALLBACK_ORIGINS).toEqual(FALLBACK_ORIGINS);
  });

  it("allows the storefront, with and without www", () => {
    const value = frameAncestors();
    expect(value).toContain("https://blankssportsnutrition.com");
    expect(value).toContain("https://www.blankssportsnutrition.com");
  });

  // Without 'self' the page could ONLY be framed, never opened directly —
  // which would break the contact-page link that ships first.
  it("includes 'self' so the standalone page still loads", () => {
    expect(frameAncestors().split(" ")).toContain("'self'");
  });

  it("does not fall back to a wildcard", () => {
    expect(frameAncestors()).not.toContain("*");
  });

  async function widgetHeaders() {
    const rules = await nextConfig.headers!();
    return rules.filter((rule) => rule.source === "/widget");
  }

  it("sets the CSP on /widget", async () => {
    const [rule] = await widgetHeaders();
    expect(rule).toBeDefined();
    const csp = rule.headers.find(
      (h: { key: string }) => h.key === "Content-Security-Policy"
    );
    expect(csp?.value).toMatch(/^frame-ancestors /);
  });

  it("scopes the policy to /widget and nothing else", async () => {
    const rules = await nextConfig.headers!();
    // The dashboard has no business being framed; a broader source here would
    // hand it the storefront's framing rights too.
    expect(rules.map((rule) => rule.source)).toEqual(["/widget"]);
  });

  /**
   * X-Frame-Options has no multi-origin form — ALLOW-FROM was dropped by every
   * browser — so any value it could carry contradicts frame-ancestors, and
   * browsers that understand both prefer X-Frame-Options. This is the header
   * that silently wins an argument nobody knew was happening.
   */
  it("sets no X-Frame-Options anywhere", async () => {
    const rules = await nextConfig.headers!();
    const keys = rules.flatMap((rule) =>
      rule.headers.map((h: { key: string }) => h.key.toLowerCase())
    );
    expect(keys).not.toContain("x-frame-options");
  });

  it("has no X-Frame-Options in the source either", () => {
    // Covers the other places a header could be set — the proxy, a route
    // handler — which the config object above cannot see.
    for (const file of ["../proxy.ts", "../next.config.mjs"]) {
      const source = readFileSync(
        fileURLToPath(new URL(file, import.meta.url)),
        "utf8"
      );
      // The word appears in next.config.mjs's comment explaining its absence,
      // so match on it actually being SET rather than merely mentioned.
      expect(source).not.toMatch(/["']X-Frame-Options["']\s*[,:]/i);
    }
  });
});

describe("resolveParentOrigin", () => {
  const allowed = [
    "https://blankssportsnutrition.com",
    "https://www.blankssportsnutrition.com",
  ];

  it("accepts an allowlisted origin", () => {
    expect(resolveParentOrigin("https://blankssportsnutrition.com", allowed)).toBe(
      "https://blankssportsnutrition.com"
    );
  });

  it("accepts the www host separately from the apex", () => {
    expect(
      resolveParentOrigin("https://www.blankssportsnutrition.com", allowed)
    ).toBe("https://www.blankssportsnutrition.com");
  });

  it("tolerates a trailing slash", () => {
    expect(resolveParentOrigin("https://blankssportsnutrition.com/", allowed)).toBe(
      "https://blankssportsnutrition.com"
    );
  });

  /**
   * The value comes from the URL, so anyone can set it. Returning it unchecked
   * would address our postMessage to whatever origin the attacker named — the
   * targetOrigin argument is the only thing keeping a hostile framer from
   * receiving these messages.
   */
  it("rejects an origin that isn't on the list", () => {
    expect(resolveParentOrigin("https://evil.example", allowed)).toBeNull();
  });

  it("rejects a lookalike host", () => {
    expect(
      resolveParentOrigin("https://blankssportsnutrition.com.evil.example", allowed)
    ).toBeNull();
  });

  it("rejects a scheme downgrade", () => {
    expect(resolveParentOrigin("http://blankssportsnutrition.com", allowed)).toBeNull();
  });

  it("rejects a wildcard", () => {
    expect(resolveParentOrigin("*", allowed)).toBeNull();
  });

  it("returns null when the parameter is absent", () => {
    expect(resolveParentOrigin(undefined, allowed)).toBeNull();
  });

  it("returns null when the parameter is empty", () => {
    expect(resolveParentOrigin("   ", allowed)).toBeNull();
  });

  // Next hands back an array for a repeated parameter. Two answers to "who is
  // my parent" is not a question worth guessing at.
  it("returns null when the parameter is repeated", () => {
    expect(
      resolveParentOrigin(
        ["https://blankssportsnutrition.com", "https://evil.example"],
        allowed
      )
    ).toBeNull();
  });
});

describe("height messages", () => {
  it("uses the type the loader script listens for", () => {
    // public/widget.js cannot import this module, so the string is duplicated
    // there. If this changes, the panel silently stops resizing.
    const loader = readFileSync(
      fileURLToPath(new URL("../public/widget.js", import.meta.url)),
      "utf8"
    );
    expect(loader).toContain(HEIGHT_MESSAGE_TYPE);
  });

  it("has the loader check both the origin and the frame", () => {
    const loader = readFileSync(
      fileURLToPath(new URL("../public/widget.js", import.meta.url)),
      "utf8"
    );
    expect(loader).toContain("event.origin !== ORIGIN");
    expect(loader).toContain("event.source !== iframe.contentWindow");
  });

  it("never posts to a wildcard target origin", () => {
    const form = readFileSync(
      fileURLToPath(new URL("../components/WidgetForm.tsx", import.meta.url)),
      "utf8"
    );
    expect(form).toMatch(/postMessage\(/);
    expect(form).not.toMatch(/postMessage\([^)]*["']\*["']/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses to report a height of %s",
    (height) => {
      // Zero means "not laid out yet". Forwarding it collapses the panel.
      expect(isUsableHeight(height)).toBe(false);
    }
  );

  it("accepts a real height", () => {
    expect(isUsableHeight(612)).toBe(true);
  });
});
