"use client";

import { useEffect, useRef, useState } from "react";
import { TOPICS } from "@/lib/types";
import {
  HEIGHT_MESSAGE_TYPE,
  isUsableHeight,
  isValidTargetOrigin,
} from "@/lib/widget-frame";
import {
  GENERIC_FAILURE,
  messageForThrown,
  readSubmissionResponse,
} from "@/lib/widget-errors";
import {
  ACCEPTED_DESCRIPTION,
  ACCEPT_ATTRIBUTE,
  MAX_FILES,
  MAX_FILE_BYTES,
  formatBytes,
} from "@/lib/uploads/limits";
import { putWithProgress, requestUploadUrls } from "@/lib/uploads/direct";

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

/** One picked file and where its upload has got to. */
interface Attachment {
  /** Local key only. Nothing server-side ever sees it. */
  id: number;
  file: File;
  /** 0-100, driven by XHR upload progress. */
  progress: number;
  status: "uploading" | "done" | "failed";
  /** Signed proof the server minted this path. Present once uploaded. */
  grant?: string;
  error?: string;
}

/**
 * Automatic retries before the customer is told anything.
 *
 * Two, because the failure this answers is a moment of bad mobile data and
 * those clear quickly; a third attempt mostly adds delay to a file that is
 * not going to upload on this connection.
 */
const UPLOAD_RETRIES = 2;
/** Multiplied by the attempt number, so 400ms then 800ms. */
const UPLOAD_BACKOFF_MS = 400;

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextIdRef = useRef(0);

  const uploading = attachments.some((a) => a.status === "uploading");
  /**
   * A file that failed and has not been dealt with. Submit waits for it.
   *
   * This is the whole fix. `readyGrants` has always filtered to "done", so a
   * failed upload was simply absent from the payload — the server never
   * learned a file was meant to exist, could not reject, could not log, and
   * could not count it. The customer was told it worked.
   *
   * Blocking on it does not take the choice away: removing the file is one
   * tap and re-enables submit immediately. It only stops the choice being
   * made by accident.
   */
  const unresolved = attachments.some((a) => a.status === "failed");
  const readyGrants = attachments
    .filter((a) => a.status === "done" && a.grant)
    .map((a) => a.grant as string);

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
   * How many files the customer removed BECAUSE they would not upload.
   *
   * Carried into the ticket body: the agent needs to know a photo was meant
   * to be here, or they will answer a damaged-product complaint without
   * realising there was a picture of the damage.
   */
  const [abandoned, setAbandoned] = useState(0);

  function patchAttachment(id: number, patch: Partial<Attachment>) {
    setAttachments((current) =>
      current.map((a) => (a.id === id ? { ...a, ...patch } : a))
    );
  }

  /**
   * Uploads start the moment a file is PICKED, not on submit.
   *
   * On a phone over mobile data three photos take real time, and doing it at
   * submit means a form that sits frozen after the one action the customer
   * thinks finished the job. Uploading while they type the message hides
   * nearly all of it, and submit is then instant.
   */
  async function beginUpload(pending: Attachment[]) {
    const minted = await requestUploadUrls(
      pending.map((a) => ({ name: a.file.name, size: a.file.size }))
    );

    if (!minted.ok) {
      for (const item of pending) {
        patchAttachment(item.id, { status: "failed", error: minted.error });
      }
      return;
    }

    await Promise.all(
      pending.map(async (item, index) => {
        const target = minted.uploads[index];

        /**
         * RETRIED BEFORE THE CUSTOMER EVER HEARS ABOUT IT.
         *
         * The likeliest cause of a failed PUT is a moment of bad mobile
         * data, and most of those succeed on the next attempt. Asking
         * somebody to intervene in a problem that would have fixed itself is
         * how a form starts feeling broken.
         */
        for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
          try {
            await putWithProgress(target.url, item.file, (percent) =>
              patchAttachment(item.id, { progress: percent })
            );
            // The grant is only worth keeping once the bytes are actually
            // there — claiming it earlier would just fail server-side.
            patchAttachment(item.id, {
              status: "done",
              progress: 100,
              grant: target.grant,
              error: undefined,
            });
            return;
          } catch (error) {
            console.error(
              `[widget] upload failed (attempt ${attempt + 1}/${UPLOAD_RETRIES + 1}):`,
              error
            );
            if (attempt === UPLOAD_RETRIES) break;
            // Backoff, and the bar resets so the retry is visibly a retry
            // rather than a stall at 60%.
            patchAttachment(item.id, { progress: 0 });
            await new Promise((r) => setTimeout(r, UPLOAD_BACKOFF_MS * (attempt + 1)));
          }
        }

        /**
         * Out of retries. This file now BLOCKS submit until the customer
         * either retries it or removes it.
         *
         * Not silently dropped, which is what used to happen: the grant was
         * simply absent from the payload, the server never learned a file was
         * meant to exist, and the ticket arrived without it while the
         * customer was told everything worked.
         *
         * And not a hard block on the form either. Somebody on a bad
         * connection who cannot file a ticket at all is worse off than
         * somebody whose photo went missing — they came here with a problem.
         * The choice stays theirs; it just has to be made on purpose.
         */
        patchAttachment(item.id, {
          status: "failed",
          progress: 0,
          error: "This didn't upload. Try again, or remove it to send without it.",
        });
      })
    );
  }

  /** Puts one failed file back in the queue, on the customer's say-so. */
  async function retryUpload(id: number) {
    const item = attachments.find((a) => a.id === id);
    if (!item) return;
    patchAttachment(id, { status: "uploading", progress: 0, error: undefined });
    await beginUpload([{ ...item, status: "uploading", progress: 0 }]);
  }

  /**
   * Client-side checks are a courtesy, not a control: they save someone a
   * 10MB upload that was always going to be refused. The server re-checks
   * every one of them against the bytes that actually landed in storage.
   */
  function addFiles(chosen: FileList | null) {
    if (!chosen?.length) return;
    setError("");

    const accepted: Attachment[] = [];
    let count = attachments.length;

    for (const file of Array.from(chosen)) {
      if (count >= MAX_FILES) {
        setError(`You can attach up to ${MAX_FILES} files.`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        setError(`\u201C${file.name}\u201D is too large \u2014 each file must be under 10MB.`);
        continue;
      }
      // Same name AND size: re-picking the same photo twice is a slip, not an
      // intent to send it twice.
      if (
        attachments.some(
          (a) => a.file.name === file.name && a.file.size === file.size
        )
      ) {
        continue;
      }

      accepted.push({
        id: nextIdRef.current++,
        file,
        progress: 0,
        status: "uploading",
      });
      count++;
    }

    if (accepted.length) {
      setAttachments((current) => [...current, ...accepted]);
      void beginUpload(accepted);
    }

    // Clearing the input matters: without it, choosing the same file again
    // after removing it fires no change event and looks broken.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(id: number) {
    // The uploaded object is left for the daily sweep rather than deleted
    // here: doing it properly would need another public endpoint that takes a
    // grant and deletes bytes, which is a lot of new attack surface to save a
    // few megabytes for 24 hours.
    setAttachments((current) => {
      // Counted only when they are removing something that FAILED. Removing a
      // file they simply changed their mind about is not a lost photo and
      // must not put a misleading line in the ticket.
      if (current.find((a) => a.id === id)?.status === "failed") {
        setAbandoned((n) => n + 1);
      }
      return current.filter((a) => a.id !== id);
    });
    setError("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (uploading || unresolved) return;

    setState("sending");
    setError("");

    const hadFiles = attachments.length > 0;

    try {
      // Always JSON now, and small. The files went straight to storage when
      // they were picked; what travels here is a signed grant per file,
      // naming a path the server minted and can verify. This is what keeps
      // the request under Vercel's 4.5MB function body limit — the limit that
      // was rejecting three iPhone photos before any of our code ran.
      const res = await fetch("/api/tickets/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          // Says so IN THE TICKET, not just in a log. An agent reading
          // "the tub arrived smashed" needs to know a photo of it was meant
          // to be attached, or they will answer without asking for one.
          message: abandoned
            ? `${form.message}\n\n---\n[${abandoned} ${
                abandoned === 1 ? "file" : "files"
              } could not be uploaded from the customer's device — ask them to send ${
                abandoned === 1 ? "it" : "them"
              } by reply.]`
            : form.message,
          attachments: readyGrants,
        }),
      });

      // NOT res.json(). That throws the browser's own parse error on any
      // non-JSON body, and this catch used to put that string straight in
      // front of the customer — which in Safari reads "The string did not
      // match the expected pattern."
      const result = await readSubmissionResponse(res, hadFiles);
      if (!result.ok) {
        setError(result.error ?? GENERIC_FAILURE);
        setState("error");
        return;
      }

      setTicketNumber(result.ticketNumber ?? null);
      setState("done");
    } catch (err) {
      // Whatever this is — a DOMException, a network TypeError, something a
      // future browser invents — the customer sees our copy. The raw value
      // goes to the console, where it is useful and harmless.
      console.error("[widget] submit failed:", err);
      setError(messageForThrown(err, hadFiles));
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
                    {attachments.length >= MAX_FILES
                      ? `${MAX_FILES} files attached`
                      : "Add a photo or file"}
                  </label>

                  <p className="mt-1.5 text-[12px] text-widget-muted opacity-80">
                    Up to {MAX_FILES} files, 10MB each. {ACCEPTED_DESCRIPTION}.
                  </p>

                  {attachments.length > 0 && (
                    <ul className="mt-2 space-y-1.5">
                      {attachments.map((item) => (
                        <li
                          key={item.id}
                          className="rounded-lg border border-widget-border bg-widget-bg px-2.5 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] text-widget-text">
                              {item.file.name}
                            </span>
                            <span
                              className={
                                item.status === "failed"
                                  ? "flex-none text-[12px] text-widget-danger"
                                  : "flex-none text-[12px] text-widget-muted"
                              }
                            >
                              {item.status === "uploading"
                                ? `${item.progress}%`
                                : item.status === "failed"
                                  ? "Failed"
                                  : formatBytes(item.file.size)}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeFile(item.id)}
                              aria-label={`Remove ${item.file.name}`}
                              // 44px target: this sits next to a filename on a
                              // phone, and a 16px x is a mis-tap generator.
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
                          </div>

                          {/* A determinate bar, not a spinner: on mobile data
                              the difference between "working" and "how much
                              longer" is the difference between waiting and
                              giving up. */}
                          {item.status === "uploading" && (
                            <div
                              className="mt-1.5 h-1 overflow-hidden rounded-full bg-widget-field"
                              role="progressbar"
                              aria-valuenow={item.progress}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`Uploading ${item.file.name}`}
                            >
                              <div
                                className="h-full rounded-full bg-widget-accent transition-[width] duration-200 ease-out"
                                style={{ width: `${item.progress}%` }}
                              />
                            </div>
                          )}

                          {item.status === "failed" && (
                            <div className="mt-1">
                              <p className="text-[12px] text-widget-danger">
                                {item.error}
                              </p>
                              {/* Two explicit ways out, and no third. The
                                  customer decides whether to send without the
                                  photo; the form no longer decides for them
                                  by quietly leaving it behind. */}
                              <button
                                type="button"
                                onClick={() => retryUpload(item.id)}
                                className="mt-1.5 h-9 rounded-md border border-widget-border px-3 text-[13px] font-semibold text-widget-text active:bg-widget-muted/40"
                              >
                                Try again
                              </button>
                            </div>
                          )}
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
                  // Disabled while bytes are still moving: submitting now
                  // would file the ticket without the photo the customer is
                  // watching upload.
                  disabled={state === "sending" || uploading || unresolved}
                  // Hover DARKENS. brand-500 carries white at 5.06:1 and a
                  // lighter hover would drop it under AA — the contrast test
                  // asserts this in both directions.
                  className="h-12 w-full rounded-lg bg-brand-500 px-4 text-[15px] font-semibold text-white
                    transition-colors duration-micro ease-out
                    hover:bg-brand-600 active:bg-brand-700
                    disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {unresolved
                    ? "Retry or remove the file above"
                    : uploading
                    ? "Uploading…"
                    : state === "sending"
                      ? "Sending…"
                      : "Send message"}
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
    //
    // Filtered, because postMessage THROWS on a malformed target rather than
    // ignoring it, and a throw in here happens inside the observer callback
    // where nothing is watching for it. A misconfigured origin should cost the
    // panel its auto-sizing, not the whole form.
    const targets = (parentOrigin ? [parentOrigin] : allowedParents).filter(
      isValidTargetOrigin
    );
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
