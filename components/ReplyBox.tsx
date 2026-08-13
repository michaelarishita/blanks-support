"use client";

import { useState, useTransition } from "react";
import { sendReply } from "@/app/actions";

interface Macro {
  id: string;
  title: string;
  body: string;
}

export default function ReplyBox({
  ticketId,
  macros,
  customerFirstName,
}: {
  ticketId: string;
  macros: Macro[];
  customerFirstName: string;
}) {
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  function applyMacro(id: string) {
    const macro = macros.find((m) => m.id === id);
    if (!macro) return;
    const text = macro.body.replaceAll(
      "{{customer.first_name}}",
      customerFirstName || "there"
    );
    setBody((prev) => (prev ? prev + "\n\n" + text : text));
  }

  function submit() {
    if (!body.trim()) return;
    setError(null);
    setWarning(null);
    startTransition(async () => {
      const res = await sendReply(ticketId, body, mode === "note");
      if (res?.error) {
        setError(res.error);
        return;
      }
      // Stored successfully — clear the draft even if delivery failed, since
      // resending the same text would post a duplicate to the thread.
      setBody("");
      if (res?.warning) setWarning(res.warning);
    });
  }

  return (
    <div className="border-t border-gray-200 bg-white px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => setMode("reply")}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              mode === "reply"
                ? "bg-gray-900 text-white"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            Reply
          </button>
          <button
            onClick={() => setMode("note")}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              mode === "note"
                ? "bg-amber-400 text-amber-950"
                : "bg-gray-100 text-gray-500 hover:bg-gray-200"
            }`}
          >
            🔒 Internal note
          </button>
          <div className="flex-1" />
          {macros.length > 0 && mode === "reply" && (
            <select
              onChange={(e) => {
                if (e.target.value) applyMacro(e.target.value);
                e.target.value = "";
              }}
              defaultValue=""
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600"
            >
              <option value="" disabled>
                ⚡ Insert macro…
              </option>
              {macros.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          )}
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          rows={3}
          placeholder={
            mode === "note"
              ? "Internal note — only the team sees this…"
              : "Write a reply… (⌘↵ to send)"
          }
          className={`w-full resize-y rounded-xl border px-4 py-3 text-sm focus:outline-none ${
            mode === "note"
              ? "border-amber-300 bg-amber-50 focus:border-amber-400"
              : "border-gray-300 focus:border-gray-500"
          }`}
        />
        <div className="mt-2 flex items-center justify-between gap-4">
          <span className="text-xs text-red-500">
            {error}
            {warning && <span className="text-amber-600">⚠️ {warning}</span>}
          </span>
          <button
            onClick={submit}
            disabled={pending || !body.trim()}
            className="rounded-lg bg-gray-900 px-5 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-40"
          >
            {pending
              ? "Sending…"
              : mode === "note"
              ? "Add note"
              : "Send reply"}
          </button>
        </div>
      </div>
    </div>
  );
}
