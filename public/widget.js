/**
 * Blanks Support widget loader.
 * Drop this on blankssportsnutrition.com:
 *
 *   <script src="https://support.blankssportsnutrition.com/widget.js" defer></script>
 *
 * Renders a floating "Support" button that opens the ticket form in a panel.
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

  // floating button
  var btn = document.createElement("button");
  btn.textContent = "💬 Support";
  btn.setAttribute("aria-label", "Open support");
  btn.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:99998;background:#111;color:#fff;" +
    "border:none;border-radius:999px;padding:12px 20px;font:600 14px -apple-system,sans-serif;" +
    "cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)";

  // panel
  var panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;bottom:80px;right:20px;z-index:99999;width:380px;max-width:calc(100vw - 40px);" +
    "height:560px;max-height:calc(100vh - 120px);border-radius:16px;overflow:hidden;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.3);display:none;background:#fff";

  var iframe = document.createElement("iframe");
  iframe.src = ORIGIN + "/widget";
  iframe.title = "Blanks Support";
  iframe.style.cssText = "width:100%;height:100%;border:0";
  panel.appendChild(iframe);

  var open = false;
  btn.addEventListener("click", function () {
    open = !open;
    panel.style.display = open ? "block" : "none";
    btn.textContent = open ? "✕ Close" : "💬 Support";
  });

  document.body.appendChild(btn);
  document.body.appendChild(panel);
})();
