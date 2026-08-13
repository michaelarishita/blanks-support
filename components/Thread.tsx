"use client";

import { useEffect, useRef } from "react";
import { format } from "date-fns";
import type { Message } from "@/lib/types";

// Delivery state of an outbound public reply, as shown on the agent's bubble
// (dark background, so these are light-on-dark tones).
const DELIVERY_META: Record<string, { label: string; classes: string }> = {
  queued: { label: "Sending…", classes: "text-gray-400" },
  sent: { label: "✓ Sent", classes: "text-emerald-300" },
  failed: { label: "⚠ Not delivered", classes: "text-red-300" },
  stored: { label: "Not emailed", classes: "text-gray-500" },
};

export default function Thread({
  messages,
  customerName,
}: {
  messages: Message[];
  customerName: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {messages.map((m) => {
        const isNote = m.type === "internal_note";
        const isAgent = m.direction === "outbound";
        const author = isAgent ? m.agent?.name ?? "Agent" : customerName;

        return (
          <div
            key={m.id}
            className={`flex ${isAgent ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm ${
                isNote
                  ? "border border-amber-200 bg-amber-50"
                  : isAgent
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 bg-white"
              }`}
            >
              <div
                className={`mb-1 flex items-baseline gap-2 text-[11px] ${
                  isNote
                    ? "text-amber-600"
                    : isAgent
                    ? "text-gray-400"
                    : "text-gray-400"
                }`}
              >
                <span className="font-semibold">
                  {isNote ? `🔒 Internal note · ${author}` : author}
                </span>
                <span>{format(new Date(m.created_at), "MMM d, h:mm a")}</span>
                {!isNote && isAgent && (
                  <span
                    className={
                      DELIVERY_META[m.delivery_status]?.classes ?? "text-gray-400"
                    }
                    title={
                      m.delivery_status === "failed"
                        ? "The reply is saved here but the email did not send — see the ticket history for the reason."
                        : undefined
                    }
                  >
                    {DELIVERY_META[m.delivery_status]?.label ?? m.delivery_status}
                  </span>
                )}
              </div>
              <div className="whitespace-pre-wrap">{m.body_text}</div>
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
