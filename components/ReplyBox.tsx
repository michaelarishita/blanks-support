"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { sendReply } from "@/app/actions";
import { isEmptyHtml } from "@/lib/html";
import { useHotkey } from "@/lib/shortcuts";
import RichTextEditor, {
  type RichTextEditorHandle,
} from "@/components/RichTextEditor";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import { useToast } from "@/components/ui/Toast";
import MacroPicker, { type Macro } from "@/components/MacroPicker";
import { LockIcon, MailIcon, PaperclipIcon, UserIcon } from "@/components/ui/icons";

type Mode = "reply" | "note";

export default function ReplyBox({
  ticketId,
  macros,
  customerFirstName,
  sendingAs,
  emailCapable,
  assignedToOther,
}: {
  ticketId: string;
  macros: Macro[];
  customerFirstName: string;
  /** Display name of the owner, when it's someone other than the reader. */
  assignedToOther: string | null;
  /** Gmail address this agent's replies leave from, if connected. */
  sendingAs: string | null;
  /** False for tickets with no customer email — replies are stored only. */
  emailCapable: boolean;
}) {
  // Holds HTML from the editor; the server sanitizes it and derives the
  // canonical plain text.
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>("reply");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<RichTextEditorHandle>(null);
  const toast = useToast();

  const isNote = mode === "note";
  const empty = isEmptyHtml(body);

  const focusComposer = useCallback((next: Mode) => {
    setMode(next);
    // Defer so the editor has re-rendered into the new mode first.
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  useHotkey("r", useCallback(() => focusComposer("reply"), [focusComposer]));
  useHotkey("n", useCallback(() => focusComposer("note"), [focusComposer]));

  function applyMacro(macro: Macro) {
    const text = macro.body.replaceAll(
      "{{customer.first_name}}",
      customerFirstName || "there"
    );
    // Macros are stored as plain text — escape it and convert newlines
    // before it enters an HTML editor.
    const html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br />");
    editorRef.current?.append(html);
  }

  function submit() {
    if (empty || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await sendReply(ticketId, body, isNote);
      if (res?.error) {
        setError(res.error);
        return;
      }
      // Stored successfully — clear the draft even if delivery failed, since
      // resending the same text would post a duplicate to the thread.
      editorRef.current?.clear();
      if (res?.warning) toast(res.warning, { tone: "error" });
      else if (isNote) toast("Note added", { tone: "success" });
      else
        toast(emailCapable ? "Reply sent" : "Reply saved to thread", {
          tone: "success",
        });

      // Surfaced separately so the assignment isn't a silent side effect of
      // hitting send.
      if (res?.claimed) {
        toast("This ticket is now assigned to you", { tone: "info" });
      }
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

        <RichTextEditor
          ref={editorRef}
          value={body}
          onChange={setBody}
          onSubmit={submit}
          tone={isNote ? "note" : "default"}
          placeholder={
            isNote
              ? "Internal note — only the team sees this…"
              : "Write a reply…"
          }
        />

        {/* Context, not a warning and not a block: covering someone else's
            ticket is normal, but sending without noticing whose it is isn't.
            Auto-assign deliberately won't take it from them. */}
        {assignedToOther && !isNote && (
          <p className="mt-2 flex items-center gap-1.5 text-caption text-tertiary">
            <UserIcon size={12} className="flex-none" />
            Assigned to <span className="text-secondary">{assignedToOther}</span>
          </p>
        )}

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
            disabled={empty}
          >
            {isNote ? "Add note" : "Send reply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
