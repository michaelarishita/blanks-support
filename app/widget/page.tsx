"use client";

import { useState } from "react";
import { TOPICS } from "@/lib/types";

// The customer-facing support form. Embedded on blankssportsnutrition.com
// via public/widget.js (iframe) or linked directly.
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

  if (state === "done") {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <div className="text-4xl">✅</div>
        <h1 className="mt-4 text-xl font-bold">Got it!</h1>
        <p className="mt-2 text-sm text-gray-600">
          Your request <span className="font-mono font-semibold">#BLK-{ticketNumber}</span> is
          in. We&apos;ll get back to you at <b>{form.email}</b> — usually within one
          business day.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-6 py-8">
      <div className="mb-6">
        <div className="text-[10px] font-bold uppercase tracking-widest text-amber-500">
          Blanks Sports Nutrition
        </div>
        <h1 className="text-xl font-bold">How can we help?</h1>
      </div>

      <form onSubmit={submit} className="space-y-4">
        {/* honeypot — hidden from real users */}
        <input
          type="text"
          value={form.website}
          onChange={(e) => set("website", e.target.value)}
          className="hidden"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
        />

        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-600">
            What&apos;s this about?
          </label>
          <select
            required
            value={form.topic}
            onChange={(e) => set("topic", e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-amber-400 focus:outline-none"
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

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-600">
              Name
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-amber-400 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-600">
              Email *
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-amber-400 focus:outline-none"
            />
          </div>
        </div>

        {showOrderField && (
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-600">
              Order number <span className="font-normal text-gray-400">(if you have it)</span>
            </label>
            <input
              type="text"
              value={form.order_number}
              onChange={(e) => set("order_number", e.target.value)}
              placeholder="#1234"
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-amber-400 focus:outline-none"
            />
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-semibold text-gray-600">
            Message *
          </label>
          <textarea
            required
            rows={5}
            value={form.message}
            onChange={(e) => set("message", e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-amber-400 focus:outline-none"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={state === "sending"}
          className="w-full rounded-lg bg-gray-900 px-4 py-3 text-sm font-bold text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {state === "sending" ? "Sending…" : "Send message"}
        </button>
      </form>
    </div>
  );
}
