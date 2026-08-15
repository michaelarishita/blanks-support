import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPANY } from "@/lib/email/template";

/**
 * Legibility guards for the brand palette.
 *
 * These read the ACTUAL token values out of app/globals.css rather than
 * duplicating them, so a future palette tweak is checked rather than merely
 * hoped about. #0061ff clears AA for normal text on white, but only by a
 * little — which is exactly the situation where an unchecked "let's lighten
 * it" lands below the line without anyone noticing.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8"
);

/** Reads `--name: R G B;` out of the token block, following one alias hop. */
function token(name: string): [number, number, number] {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  if (!match) throw new Error(`token --${name} not found in globals.css`);
  const value = match[1].trim();

  const alias = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
  if (alias) return token(alias[1]);

  const parts = value.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`token --${name} is not an RGB triple: ${value}`);
  }
  return parts as [number, number, number];
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(
  a: [number, number, number],
  b: [number, number, number]
): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: [number, number, number] = [255, 255, 255];
const round = (n: number) => Math.round(n * 100) / 100;

describe("brand palette", () => {
  it("has #0061ff as the 500 step", () => {
    expect(token("brand-500")).toEqual([0, 97, 255]);
  });

  it("runs light to dark across the ramp", () => {
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
    const lums = steps.map((s) => luminance(token(`brand-${s}`)));
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i]).toBeLessThan(lums[i - 1]);
    }
  });

  it("uses the same accent in email as in the app", () => {
    const [r, g, b] = token("brand-500");
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    expect(DEFAULT_COMPANY.brand_color.toLowerCase()).toBe(hex);
  });
});

describe("WCAG AA contrast", () => {
  // Buttons: white label on the brand fill.
  it("white on brand-500 clears AA for normal text", () => {
    const ratio = contrast(WHITE, token("brand-500"));
    expect(round(ratio)).toBeGreaterThanOrEqual(4.5);
  });

  // The hover state must not drop below the resting state's legibility —
  // this is why hover darkens the fill instead of lightening it.
  it.each(["brand-600", "brand-700"])(
    "white on %s stays above AA (hover/active)",
    (step) => {
      expect(contrast(WHITE, token(step))).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("brand-400 would FAIL as a button fill, which is why it isn't one", () => {
    // Documents the trap rather than the fix: a lighter hover would break it.
    expect(contrast(WHITE, token("brand-400"))).toBeLessThan(4.5);
  });

  // Inline links and small text on white use the darker step.
  it("brand-link on white clears AA", () => {
    expect(contrast(token("brand-link"), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it("brand-link on white clears AAA, since links are our smallest brand text", () => {
    expect(contrast(token("brand-link"), WHITE)).toBeGreaterThanOrEqual(7);
  });

  // Badge: brand tone is text on a tinted background.
  it("brand-800 on brand-50 clears AA", () => {
    expect(contrast(token("brand-800"), token("brand-50"))).toBeGreaterThanOrEqual(4.5);
  });

  // Active nav row.
  it("brand-900 on brand-50 clears AA", () => {
    expect(contrast(token("brand-900"), token("brand-50"))).toBeGreaterThanOrEqual(4.5);
  });

  // Links inside a dark outbound bubble.
  it("brand-300 on gray-900 clears AA", () => {
    expect(contrast(token("brand-300"), token("gray-900"))).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * The priority palette inverts the usual convention (red is High, not
 * Urgent), so it leans harder on labels than on hue. These assertions cover
 * the two things colour still has to do: stay legible, and stay
 * distinguishable from the warning tone that already means something else.
 */
describe("priority palette", () => {
  it.each(["urgent", "high", "normal", "low"])(
    "%s chip text clears AA on its fill",
    (name) => {
      const ratio = contrast(token(`priority-${name}-fg`), token(`priority-${name}-bg`));
      expect(round(ratio)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("gives Low dark text, because white on yellow is illegible", () => {
    expect(contrast(WHITE, token("priority-low-bg"))).toBeLessThan(4.5);
    expect(token("priority-low-fg")).toEqual(token("gray-900"));
  });

  it.each(["urgent", "high", "normal"])("%s chip carries white text", (name) => {
    expect(token(`priority-${name}-fg`)).toEqual(WHITE);
  });

  // Amber already means "warning / internal note" here. A Low chip that reads
  // as a warning would be actively misleading.
  //
  // Judged on SATURATION, not contrast: both are light colours, so their
  // luminance ratio is near 1 no matter how obviously different they look.
  // What separates a vivid yellow from a pale cream is chroma.
  it("keeps Low visually distinct from the warning tone", () => {
    const low = token("priority-low-bg");
    const warning = token("warning-bg");

    const chroma = (c: [number, number, number]) => Math.max(...c) - Math.min(...c);
    // Vivid: the yellow is fully saturated.
    expect(chroma(low)).toBeGreaterThan(180);
    // Pale: the warning wash is nearly white.
    expect(chroma(warning)).toBeLessThan(40);

    const distance = Math.sqrt(
      low.reduce((sum, channel, i) => sum + (channel - warning[i]) ** 2, 0)
    );
    expect(distance).toBeGreaterThan(60);
  });

  it("keeps every priority fill distinct from every other", () => {
    const names = ["urgent", "high", "normal", "low"];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = token(`priority-${names[i]}-bg`);
        const b = token(`priority-${names[j]}-bg`);
        expect(a).not.toEqual(b);
      }
    }
  });
});

describe("semantic tones keep their own hues", () => {
  it.each([
    ["success-text", "success-bg"],
    ["warning-text", "warning-bg"],
    ["danger-text", "danger-bg"],
    ["info-text", "info-bg"],
  ])("%s on %s clears AA", (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  // Amber now means exactly one thing. If warning ever drifts blue, the
  // distinction between "brand" and "something needs attention" is gone.
  it("warning stays amber, not blue", () => {
    const [r, g, b] = token("warning-text");
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });
});
