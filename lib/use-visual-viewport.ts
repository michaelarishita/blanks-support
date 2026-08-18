"use client";

import { useEffect, useState } from "react";

/**
 * How much of the viewport the on-screen keyboard is covering.
 *
 * THE single biggest cause of "I can't use it on my phone". A composer fixed
 * to the bottom of the layout viewport sits BEHIND the iOS keyboard: you tap
 * the field, the keyboard opens, and the thing you were typing into is gone.
 * iOS does not resize the layout viewport for the keyboard, so no amount of
 * CSS height maths can see it — `visualViewport` is the only API that can.
 *
 * Returns the number of pixels to lift by, and 0 everywhere the API is absent
 * (older browsers, desktop), where a plain sticky footer is already correct.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    function update() {
      const vp = window.visualViewport;
      if (!vp) return;
      // What the layout viewport has that the visual one doesn't: the
      // keyboard, plus any browser chrome overlaying the page. offsetTop
      // accounts for the page being scrolled within the visual viewport,
      // which happens when iOS scrolls a focused field into view itself.
      const covered = window.innerHeight - vp.height - vp.offsetTop;
      // Small values are chrome shifting during a scroll, not a keyboard.
      // Reacting to those makes the composer jitter as the page moves.
      setInset(covered > 80 ? Math.round(covered) : 0);
    }

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
