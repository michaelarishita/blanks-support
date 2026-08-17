/**
 * Blanks Support widget loader.
 * Drop this on blankssportsnutrition.com:
 *
 *   <script src="https://support.blankssportsnutrition.com/widget.js" defer></script>
 *
 * Renders a floating "Support" button that opens the ticket form in a panel.
 *
 * Everything here is inline style on purpose: this runs on the storefront,
 * where a stylesheet of ours would be one more thing to collide with the
 * theme's CSS. Colours are duplicated from the tokens in app/globals.css
 * because this file cannot import them — if the widget palette changes, both
 * places move.
 */
(function () {
  var ORIGIN = (function () {
    var s = document.currentScript;
    try {
      return new URL(s.src).origin;
    } catch (e) {
      return "https://support.blankssportsnutrition.com";
    }
  })();

  // Mirrors --widget-* in app/globals.css.
  var BG = "#0b0d10";
  var BORDER = "#262b33";
  var BRAND = "#0061ff";
  var BRAND_HOVER = "#0052db"; // Darker, never lighter — white label is 5.06:1.

  // floating button
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Support";
  btn.setAttribute("aria-label", "Open support");
  btn.setAttribute("aria-expanded", "false");
  var btnBase =
    "position:fixed;bottom:20px;right:20px;z-index:99998;color:#fff;" +
    "border:none;border-radius:999px;padding:14px 22px;" +
    "font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    // 44px minimum tap target, and a shadow dark enough to hold against a
    // white storefront background.
    "min-height:48px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.28);" +
    "transition:background-color 120ms ease";
  btn.style.cssText = btnBase + ";background:" + BRAND;

  btn.addEventListener("mouseenter", function () {
    btn.style.backgroundColor = BRAND_HOVER;
  });
  btn.addEventListener("mouseleave", function () {
    btn.style.backgroundColor = BRAND;
  });

  // panel
  //
  // The background is the widget's OWN near-black, not #fff. A white panel
  // behind a dark iframe shows as a bright frame at the rounded corners and
  // as a full white flash for the moment before the iframe paints.
  var panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;bottom:80px;right:20px;z-index:99999;width:380px;max-width:calc(100vw - 40px);" +
    "height:560px;max-height:calc(100vh - 120px);border-radius:16px;overflow:hidden;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.45);display:none;" +
    "background:" + BG + ";border:1px solid " + BORDER + ";color-scheme:dark";

  var iframe = document.createElement("iframe");
  // Tell the widget who framed it, so its height messages can be addressed to
  // exactly this origin instead of broadcast. The value is matched against the
  // server's allowlist over there — it is a hint, not a grant.
  iframe.src =
    ORIGIN + "/widget?parent=" + encodeURIComponent(window.location.origin);
  iframe.title = "Blanks Support";
  // Same background again: an iframe paints its own canvas white by default,
  // before the document inside it has any styles at all.
  iframe.style.cssText =
    "width:100%;height:100%;border:0;display:block;background:" + BG;
  panel.appendChild(iframe);

  // ---- Auto-sizing -------------------------------------------------------
  //
  // The widget measures itself and posts its height whenever it changes: on
  // load, when the conditional order-number field appears, and when the
  // success state replaces the form.
  var HEIGHT_MESSAGE = "blanks-widget-height"; // mirrors lib/widget-frame.ts
  var MIN_HEIGHT = 260;
  var VIEWPORT_MARGIN = 120; // clears the floating button and a little air

  window.addEventListener("message", function (event) {
    // Three checks, and all three matter. Any page on the internet can
    // postMessage into this window, so the sender has to be OUR origin AND
    // OUR iframe — the origin alone would let a second Blanks iframe on the
    // same page drive this panel.
    if (event.origin !== ORIGIN) return;
    if (event.source !== iframe.contentWindow) return;

    var data = event.data;
    if (!data || data.type !== HEIGHT_MESSAGE) return;

    var height = Number(data.height);
    if (!isFinite(height) || height <= 0) return;

    // Clamped both ways: a mid-transition measurement must not collapse the
    // panel, and a long form must not run off the bottom of the screen. Past
    // the ceiling the iframe scrolls internally, which is the correct
    // fallback rather than a panel taller than the viewport.
    var ceiling = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN);
    panel.style.height =
      Math.min(Math.max(height, MIN_HEIGHT), ceiling) + "px";
  });

  var open = false;
  btn.addEventListener("click", function () {
    open = !open;
    panel.style.display = open ? "block" : "none";
    btn.textContent = open ? "Close" : "Support";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.body.appendChild(btn);
  document.body.appendChild(panel);
})();
