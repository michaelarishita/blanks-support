"use client";

import { useState } from "react";
import { TOPICS } from "@/lib/types";

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

export default function WidgetPage() {
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

  const showOrderField =
    form.topic === "Order questions" || form.topic === "Shipping & returns";

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError("");
    try {
      const res = await fetch("/api/tickets/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
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
    // `m-auto` on the card rather than `justify-center` on this container:
    // auto margins collapse to zero when the content is taller than the
    // viewport, so a long form on a short phone scrolls instead of having its
    // top clipped off above the scroll origin.
    // 100svh, not 100vh — vh on mobile is the tallest the viewport ever gets,
    // which means a chunk of the page sits under the browser chrome.
    <div className="theme-widget-dark flex min-h-[100svh] bg-widget-bg px-4 py-6 sm:px-6 sm:py-10">
      <main className="m-auto w-full max-w-[440px]">
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

              <form onSubmit={submit} className="space-y-4" noValidate={false}>
                {/* Honeypot — untouched. Real users never fill it, and the
                    intake endpoint silently accepts and drops anything that
                    does. Not `hidden`, because some bots skip those. */}
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
