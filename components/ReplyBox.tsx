"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { sendReply } from "@/app/actions";
import { useHotkey } from "@/lib/shortcuts";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import MacroPicker, { type Macro } from "@/components/MacroPicker";
import { LockIcon, MailIcon, PaperclipIcon } from "@/components/ui/icons";

type Mode = "reply" | "note";

export default function ReplyBox({
  ticketId,
  macros,
  customerFirstName,
  sendingAs,
  emailCapable,
}: {
  ticketId: string;
  macros: Macro[];
  customerFirstName: string;
  /** Gmail address this agent's replies leave from, if connected. */
  sendingAs: string | null;
  /** False for tickets with no customer email — replies are stored only. */
  emailCapable: boolean;
}) {
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>("reply");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  const isNote = mode === "note";

  const focusComposer = useCallback((next: Mode) => {
    setMode(next);
    // Defer so the textarea has re-rendered into the new mode first.
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useHotkey("r", useCallback(() => focusComposer("reply"), [focusComposer]));
  useHotkey("n", useCallback(() => focusComposer("note"), [focusComposer]));

  function applyMacro(macro: Macro) {
    const text = macro.body.replaceAll(
      "{{customer.first_name}}",
      customerFirstName || "there"
    );
    setBody((prev) => (prev ? `${prev}\n\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function submit() {
    if (!body.trim() || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await sendReply(ticketId, body, isNote);
      if (res?.error) {
        setError(res.error);
        return;
      }
      // Stored successfully — clear the draft even if delivery failed, since
      // resending the same text would post a duplicate to the thread.
      setBody("");
      if (res?.warning) toast(res.warning, { tone: "error" });
      else if (isNote) toast("Note added", { tone: "success" });
      else
        toast(emailCapable ? "Reply sent" : "Reply saved to thread", {
          tone: "success",
        });
    });
  }

  return (
    <div
      className={cn(
        "flex-none border-t px-6 py-3 transition-colors duration-panel ease-out",
        // The whole surface turns amber in note mode — the strongest
        // available signal that this will not reach the customer.
        isNote ? "border-warning-border bg-warning-bg" : "border-subtle bg-panel"
      )}
    >
      <div className="mx-auto w-full max-w-[680px]">
        <div className="mb-2 flex items-center gap-2">
          {/* Segmented control */}
          <div
            role="tablist"
            aria-label="Reply mode"
            className={cn(
              "inline-flex rounded-sm p-0.5",
              isNote ? "bg-warning-border/50" : "bg-gray-100"
            )}
          >
            {(["reply", "note"] as Mode[]).map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-[4px] px-2.5 text-caption font-medium",
                  "transition-colors duration-micro ease-out",
                  mode === m
                    ? "bg-panel text-primary shadow-sm"
                    : "text-secondary hover:text-primary"
                )}
              >
                {m === "note" ? <LockIcon size={12} /> : <MailIcon size={12} />}
                {m === "note" ? "Internal note" : "Reply"}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          {!isNote && macros.length > 0 && (
            <MacroPicker macros={macros} onPick={applyMacro} />
          )}

          <Tooltip content="Attachments land with inbound email (Drop 4)">
            <span>
              <Button variant="ghost" size="sm" iconOnly disabled aria-label="Attach file">
                <PaperclipIcon size={14} />
              </Button>
            </span>
          </Tooltip>
        </div>

        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          rows={3}
          placeholder={
            isNote
              ? "Internal note — only the team sees this…"
              : "Write a reply…"
          }
          className={cn(
            "w-full resize-y rounded-md border px-3.5 py-2.5 text-body text-primary",
            "placeholder:text-tertiary transition-colors duration-micro ease-out",
            isNote
              ? "border-warning-border bg-panel focus:border-warning-text/40"
              : "border-subtle bg-panel hover:border-strong focus:border-brand-400"
          )}
        />

        <div className="mt-2 flex items-center gap-3">
          <div className="min-w-0 flex-1 text-caption">
            {error ? (
              <span className="text-danger-text">{error}</span>
            ) : isNote ? (
              <span className="text-warning-text">
                Visible to the team only — never sent to the customer.
              </span>
            ) : !emailCapable ? (
              <span className="text-tertiary">
                No email address on this ticket — the reply is saved to the
                thread only.
              </span>
            ) : sendingAs ? (
              <span className="truncate text-tertiary">
                Sending as <span className="text-secondary">{sendingAs}</span>
              </span>
            ) : (
              <span className="text-danger-text">
                No Gmail connected — connect it in Settings to send email.
              </span>
            )}
          </div>

          <span className="flex-none text-caption text-tertiary">⌘↵</span>
          <Button
            variant={isNote ? "secondary" : "primary"}
            size="md"
            onClick={submit}
            loading={pending}
            disabled={!body.trim()}
          >
            {isNote ? "Add note" : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
