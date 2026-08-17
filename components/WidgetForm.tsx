"use client";

import { useEffect, useRef, useState } from "react";
import { TOPICS } from "@/lib/types";
import { HEIGHT_MESSAGE_TYPE, isUsableHeight } from "@/lib/widget-frame";
import {
  ACCEPTED_DESCRIPTION,
  ACCEPT_ATTRIBUTE,
  MAX_FILES,
  MAX_FILE_BYTES,
  formatBytes,
} from "@/lib/uploads/limits";

// The customer-facing support form. Embedded on blankssportsnutrition.com via
// public/widget.js (iframe) and linked directly from the contact page, so it
// has to read as a deliberate full-screen page AND as a 380px panel.
//
// LOGO: there is deliberately no wordmark image here. The Blanks wordmark we
// hold is black artwork, which would be invisible on this background, and
// putting it on a white plate to compensate would look like a bug. The text
// lockup below stands in until a white/knockout asset exists.

/** 44px: the minimum comfortable tap target, and the reason for h-11. */
const FIELD =
  "h-11 w-full rounded-lg border border-widget-field-border bg-widget-field px-3 " +
  "text-[15px] text-widget-text " +
  "transition-colors duration-micro ease-out " +
  "hover:border-widget-muted focus:border-widget-accent focus:outline-none";

const LABEL = "mb-1.5 block text-[13px] font-medium text-widget-muted";

export default function WidgetForm({
  parentOrigin,
  allowedParents,
}: {
  /** Resolved and allowlisted by the server, or null for a hand-written embed. */
  parentOrigin: string | null;
  allowedParents: string[];
}) {
  const [form, setForm] = useState({
    name: "",
    email: "",
    topic: "",
    order_number: "",
    message: "",
    website: "", // honeypot
  });
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">(
    "idle"
  );
  const [ticketNumber, setTicketNumber] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Starts from the server's answer so the framed layout is in the first
  // paint. The effect below catches the other case: an embed written by hand,
  // with no ?parent parameter for the server to have seen.
  const [framed, setFramed] = useState(Boolean(parentOrigin));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.self !== window.top) setFramed(true);
  }, []);

  useHeightReporting({ enabled: framed, parentOrigin, allowedParents, rootRef });

  const showOrderField =
    form.topic === "Order questions" || form.topic === "Shipping & returns";

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  /**
   * Client-side checks are a courtesy, not a control: they save someone a
   * 10MB upload that was always going to be refused. The server re-checks
   * every one of them, and sniffs the actual bytes besides.
   */
  function addFiles(chosen: FileList | null) {
    if (!chosen?.length) return;
    setError("");

    const next = [...files];
    for (const file of Array.from(chosen)) {
      if (next.length >= MAX_FILES) {
        setError(`You can attach up to ${MAX_FILES} files.`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`“${file.name}” is too large — each file must be under 10MB.`);
        continue;
      }
      // Same name AND size: re-picking the same photo twice is a slip, not an
      // intent to send it twice.
      if (next.some((f) => f.name === file.name && f.size === file.size)) continue;
      next.push(file);
    }

    setFiles(next);
    // Clearing the input matters: without it, choosing the same file again
    // after removing it fires no change event and looks broken.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, i) => i !== index));
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError("");
    try {
      // Multipart only when there is something to carry; the JSON path stays
      // the common case and stays exactly as it was.
      let res: Response;
      if (files.length) {
        const payload = new FormData();
        for (const [key, value] of Object.entries(form)) payload.append(key, value);
        for (const file of files) payload.append("files", file);
        // No Content-Type header on purpose — the browser has to set it to
        // include the multipart boundary, and setting it by hand omits that.
        res = await fetch("/api/tickets/intake", { method: "POST", body: payload });
      } else {
        res = await fetch("/api/tickets/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setTicketNumber(data.ticket_number);
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("error");
    }
  }

  return (
    // Framed and standalone lay out differently on purpose.
    //
    // Standalone centres a card in the viewport: `m-auto` on the card rather
    // than `justify-center` here, because auto margins collapse to zero when
    // the content is taller than the viewport, so a long form on a short phone
    // scrolls instead of having its top clipped above the scroll origin.
    // 100svh, not 100vh — vh on mobile is the tallest the viewport ever gets,
    // which puts part of the page under the browser chrome.
    //
    // Framed drops BOTH. A min-height of 100svh inside an iframe we then size
    // to the content is a ratchet: the document is always at least as tall as
    // the frame, so the reported height can only ever grow. Centring is
    // meaningless in a frame cut to fit, too.
    <div
      ref={rootRef}
      className={
        framed
          ? "theme-widget-dark bg-widget-bg px-4 py-4"
          : "theme-widget-dark flex min-h-[100svh] bg-widget-bg px-4 py-6 sm:px-6 sm:py-10"
      }
    >
      <main className={framed ? "mx-auto w-full max-w-[440px]" : "m-auto w-full max-w-[440px]"}>
        <div className="rounded-2xl border border-widget-border bg-widget-card p-5 shadow-lg sm:p-7">
          {state === "done" ? (
            <Done email={form.email} ticketNumber={ticketNumber} />
          ) : (
            <>
              <header className="mb-6">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-widget-accent">
                  Blank&apos;s Sports Nutrition
                </p>
                <h1 className="mt-1.5 text-[22px] font-bold leading-tight text-widget-text">
                  How can we help?
                </h1>
                <p className="mt-1.5 text-[13px] text-widget-muted">
                  We reply by email, usually within one business day.
                </p>
              </header>

              <form onSubmit={submit} className="space-y-4">
                {/* Honeypot — untouched. Real users never fill it, and the
                    intake endpoint silently accepts and drops anything that
                    does. */}
                <input
                  type="text"
                  name="website"
                  value={form.website}
                  onChange={(e) => set("website", e.target.value)}
                  className="hidden"
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                />

                <div>
                  <label htmlFor="w-topic" className={LABEL}>
                    What&apos;s this about?
                  </label>
                  <select
                    id="w-topic"
                    required
                    value={form.topic}
                    onChange={(e) => set("topic", e.target.value)}
                    // The popup is drawn by the OS, not by us. `color-scheme:
                    // dark` on the wrapper is what makes it render dark rather
                    // than as a white sheet over a dark form.
                    className={`${FIELD} cursor-pointer appearance-none bg-[length:16px] bg-[right_0.75rem_center] bg-no-repeat pr-10`}
                    style={{
                      backgroundImage:
                        "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e97a6' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
                    }}
                  >
                    <option value="" disabled>
                      Choose a topic…
                    </option>
                    {TOPICS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="w-name" className={LABEL}>
                      Name
                    </label>
                    <input
                      id="w-name"
                      type="text"
                      autoComplete="name"
                      value={form.name}
                      onChange={(e) => set("name", e.target.value)}
                      className={FIELD}
                    />
                  </div>
                  <div>
                    <label htmlFor="w-email" className={LABEL}>
                      Email <span className="text-widget-accent">*</span>
                    </label>
                    <input
                      id="w-email"
                      type="email"
                      required
                      autoComplete="email"
                      inputMode="email"
                      value={form.email}
                      onChange={(e) => set("email", e.target.value)}
                      className={FIELD}
                    />
                  </div>
                </div>

                {/* Appearing and disappearing changes the document height —
                    which is exactly what the ResizeObserver is watching for,
                    rather than a timer guessing when it might have happened. */}
                {showOrderField && (
                  <div>
                    <label htmlFor="w-order" className={LABEL}>
                      Order number{" "}
                      <span className="font-normal opacity-70">
                        (if you have it)
                      </span>
                    </label>
                    <input
                      id="w-order"
                      type="text"
                      value={form.order_number}
                      onChange={(e) => set("order_number", e.target.value)}
                      placeholder="#1234"
                      className={FIELD}
                    />
                  </div>
                )}

                <div>
                  <label htmlFor="w-message" className={LABEL}>
                    Message <span className="text-widget-accent">*</span>
                  </label>
                  <textarea
                    id="w-message"
                    required
                    rows={5}
                    value={form.message}
                    onChange={(e) => set("message", e.target.value)}
                    placeholder="Tell us what's going on…"
                    className={`${FIELD} h-auto resize-y py-2.5 leading-relaxed`}
                  />
                </div>

                {/* File picker.
                    The native control is replaced wholesale rather than
                    styled: a bare <input type="file"> renders an OS button
                    whose background and text colour cannot be set, so on a
                    dark form it shows up as a light-grey slab with grey text
                    that reads as a rendering fault. The input is still there,
                    still the thing that opens the dialog and carries the
                    files — it is just visually hidden behind its own label. */}
                <div>
                  <span className={LABEL}>
                    Photos or files{" "}
                    <span className="font-normal opacity-70">(optional)</span>
                  </span>

                  <input
                    ref={fileInputRef}
                    id="w-files"
                    type="file"
                    multiple
                    accept={ACCEPT_ATTRIBUTE}
                    onChange={(e) => addFiles(e.target.files)}
                    className="sr-only"
                  />

                  <label
                    htmlFor="w-files"
                    className="flex min-h-[44px] cursor-pointer items-center justify-center gap-2
                      rounded-lg border border-dashed border-widget-field-border bg-widget-field px-3 py-2.5
                      text-[13px] text-widget-muted
                      transition-colors duration-micro ease-out
                      hover:border-widget-accent hover:text-widget-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 flex-none"
                      aria-hidden="true"
                    >
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                    {files.length >= MAX_FILES
                      ? `${MAX_FILES} files attached`
                      : "Add a photo or file"}
                  </label>

                  <p className="mt-1.5 text-[12px] text-widget-muted opacity-80">
                    Up to {MAX_FILES} files, 10MB each. {ACCEPTED_DESCRIPTION}.
                  </p>

                  {files.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                      {files.map((file, index) => (
                        <li
                          key={`${file.name}-${file.size}-${index}`}
                          className="flex items-center gap-2 rounded-lg border border-widget-border bg-widget-bg px-2.5 py-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-[13px] text-widget-text">
                            {file.name}
                          </span>
                          <span className="flex-none text-[12px] text-widget-muted">
                            {formatBytes(file.size)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeFile(index)}
                            aria-label={`Remove ${file.name}`}
                            // 44px target: this sits next to a filename on a
                            // phone, and a 16px × is a mis-tap generator.
                            className="-my-2 -mr-1.5 flex h-11 w-11 flex-none items-center justify-center
                              rounded-lg text-widget-muted transition-colors duration-micro ease-out
                              hover:text-widget-danger"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              className="h-4 w-4"
                              aria-hidden="true"
                            >
                              <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {error && (
                  <p
                    role="alert"
                    className="rounded-lg border border-widget-danger/30 bg-widget-danger/10 px-3 py-2 text-[13px] text-widget-danger"
                  >
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={state === "sending"}
                  // Hover DARKENS. brand-500 carries white at 5.06:1 and a
                  // lighter hover would drop it under AA — the contrast test
                  // asserts this in both directions.
                  className="h-12 w-full rounded-lg bg-brand-500 px-4 text-[15px] font-semibold text-white
                    transition-colors duration-micro ease-out
                    hover:bg-brand-600 active:bg-brand-700
                    disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {state === "sending" ? "Sending…" : "Send message"}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-[12px] text-widget-muted">
          Or email us at{" "}
          <a
            href="mailto:hello@blankssportsnutrition.com"
            className="text-widget-accent underline decoration-widget-accent/40 underline-offset-2 hover:decoration-widget-accent"
          >
            hello@blankssportsnutrition.com
          </a>
        </p>
      </main>
    </div>
  );
}

/**
 * Reports the rendered height to the host page so the iframe can size itself.
 *
 * A ResizeObserver rather than a timer: every case that changes the height —
 * first paint, the order-number field appearing, the success state replacing
 * the form, a reflow from a viewport change — is a size change on the observed
 * element, so one observer covers all of them and fires when they actually
 * happen instead of on a polling interval that is either too slow to see or
 * too fast to be free.
 */
function useHeightReporting({
  enabled,
  parentOrigin,
  allowedParents,
  rootRef,
}: {
  enabled: boolean;
  parentOrigin: string | null;
  allowedParents: string[];
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Joined so the effect doesn't re-run on every render just because the
  // parent handed it a fresh array literal.
  const targetKey = parentOrigin ?? allowedParents.join(",");

  useEffect(() => {
    if (!enabled) return;
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;

    // A known parent gets exactly one message. Without one — a hand-written
    // embed, no ?parent to read — we address every allowed origin in turn.
    // Only the real parent's origin matches, and the browser silently drops
    // the rest, so this stays precise without ever needing targetOrigin "*".
    const targets = parentOrigin ? [parentOrigin] : allowedParents;
    if (!targets.length) return;

    let lastSent = -1;

    const post = () => {
      // The ROOT element, not document.scrollHeight: in the framed layout the
      // root is exactly the content, whereas the document also carries
      // whatever height the iframe currently has.
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (!isUsableHeight(height)) return;
      // Sub-pixel reflows fire the observer constantly; without this the
      // storefront would get a burst of identical messages on every keystroke
      // that rewraps a line.
      if (height === lastSent) return;
      lastSent = height;

      for (const target of targets) {
        window.parent.postMessage(
          { type: HEIGHT_MESSAGE_TYPE, height },
          target
        );
      }
    };

    const observer = new ResizeObserver(post);
    observer.observe(node);
    // ResizeObserver already fires once on observe, so this is belt-and-braces
    // for the initial report; the dedupe above keeps it from doubling up.
    post();

    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, parentOrigin, targetKey, rootRef]);
}

/**
 * The finished state.
 *
 * Deliberately not a bare "thanks": it names the reference number, repeats the
 * address the reply is going to (the single most common thing to typo), and
 * says when to expect one. An empty-looking success screen makes people submit
 * a second time.
 */
function Done({
  email,
  ticketNumber,
}: {
  email: string;
  ticketNumber: number | null;
}) {
  return (
    <div className="py-4 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-widget-success/15"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="rgb(110 231 168)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>

      <h1 className="mt-4 text-[20px] font-bold text-widget-text">
        Message sent
      </h1>

      <p className="mx-auto mt-2 max-w-[34ch] text-[14px] leading-relaxed text-widget-muted">
        We&apos;ll reply to <span className="text-widget-text">{email}</span>,
        usually within one business day.
      </p>

      {ticketNumber !== null && (
        <p className="mt-5 inline-block rounded-lg border border-widget-border bg-widget-field px-3 py-2 text-[13px] text-widget-muted">
          Your reference{" "}
          <span className="font-mono font-semibold tracking-tight text-widget-text">
            BLK-{ticketNumber}
          </span>
        </p>
      )}

      <p className="mt-5 text-[12px] text-widget-muted">
        Keep an eye on your spam folder — our first reply sometimes lands there.
      </p>
    </div>
  );
}
