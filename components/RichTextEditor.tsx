"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";
import { isEmptyHtml } from "@/lib/html";
import Tooltip from "@/components/ui/Tooltip";
import {
  BoldIcon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  ListNumberedIcon,
  UnderlineIcon,
} from "@/components/ui/icons";

// A deliberately small contenteditable editor.
//
// It drives formatting through document.execCommand, which is formally
// deprecated but implemented everywhere and needs no dependency. The
// alternative (Tiptap/ProseMirror/Lexical) would add a large tree with its
// own React peer-dependency constraints, and CLAUDE.md's hardest rule is that
// `npm ci` must resolve without --legacy-peer-deps.
//
// Nothing here is trusted: output is sanitized server-side before storage and
// again before rendering.

export interface RichTextEditorHandle {
  focus: () => void;
  /** Appends HTML at the end, used by the macro picker. */
  append: (html: string) => void;
  clear: () => void;
}

interface ToolbarButton {
  command: string;
  value?: string;
  label: string;
  shortcut?: string;
  Icon: (props: { size?: number }) => React.ReactElement;
}

const BUTTONS: ToolbarButton[] = [
  { command: "bold", label: "Bold", shortcut: "⌘B", Icon: BoldIcon },
  { command: "italic", label: "Italic", shortcut: "⌘I", Icon: ItalicIcon },
  { command: "underline", label: "Underline", shortcut: "⌘U", Icon: UnderlineIcon },
  { command: "insertUnorderedList", label: "Bulleted list", Icon: ListBulletIcon },
  { command: "insertOrderedList", label: "Numbered list", Icon: ListNumberedIcon },
];

const RichTextEditor = forwardRef<
  RichTextEditorHandle,
  {
    value: string;
    onChange: (html: string) => void;
    onSubmit?: () => void;
    placeholder?: string;
    tone?: "default" | "note";
    className?: string;
  }
>(function RichTextEditor(
  { value, onChange, onSubmit, placeholder, tone = "default", className },
  ref
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});

  // Only write into the DOM when the value diverges from what the user typed —
  // assigning innerHTML on every keystroke would reset the caret to the start.
  useEffect(() => {
    const el = editorRef.current;
    if (el && value !== el.innerHTML) el.innerHTML = value;
  }, [value]);

  const refreshActive = useCallback(() => {
    if (typeof document === "undefined") return;
    const next: Record<string, boolean> = {};
    for (const button of BUTTONS) {
      try {
        next[button.command] = document.queryCommandState(button.command);
      } catch {
        next[button.command] = false;
      }
    }
    setActive(next);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    append: (html: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.innerHTML = isEmptyHtml(el.innerHTML) ? html : `${el.innerHTML}<br />${html}`;
      onChange(el.innerHTML);
      el.focus();
      // Put the caret at the very end of the appended content.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    clear: () => {
      const el = editorRef.current;
      if (el) el.innerHTML = "";
      onChange("");
    },
  }));

  function exec(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    onChange(editorRef.current?.innerHTML ?? "");
    refreshActive();
  }

  function insertLink() {
    const selection = window.getSelection();
    const selected = selection?.toString() ?? "";
    const url = window.prompt(
      selected ? `Link "${selected}" to:` : "Paste a URL to insert:",
      "https://"
    );
    if (!url) return;
    if (!/^(https?:|mailto:)/i.test(url.trim())) {
      window.alert("Links must start with http://, https:// or mailto:");
      return;
    }
    if (selected) exec("createLink", url.trim());
    else exec("insertHTML", `<a href="${url.trim()}">${url.trim()}</a>`);
  }

  const empty = isEmptyHtml(value);
  const isNote = tone === "note";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border transition-colors duration-micro ease-out",
        isNote
          ? "border-warning-border bg-panel focus-within:border-warning-text/40"
          : "border-subtle bg-panel hover:border-strong focus-within:border-brand-400",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center gap-0.5 border-b px-1.5 py-1",
          isNote ? "border-warning-border/60" : "border-subtle"
        )}
      >
        {BUTTONS.map((button) => (
          <Tooltip
            key={button.command}
            content={
              button.shortcut ? `${button.label} (${button.shortcut})` : button.label
            }
          >
            <button
              type="button"
              aria-label={button.label}
              aria-pressed={active[button.command] ?? false}
              // Keep focus in the editor so the command applies to the selection.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec(button.command, button.value)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-sm",
                "transition-colors duration-micro ease-out",
                active[button.command]
                  ? "bg-gray-200 text-primary"
                  : "text-secondary hover:bg-gray-100 hover:text-primary"
              )}
            >
              <button.Icon size={15} />
            </button>
          </Tooltip>
        ))}
        <Tooltip content="Insert link">
          <button
            type="button"
            aria-label="Insert link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={insertLink}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-secondary transition-colors duration-micro ease-out hover:bg-gray-100 hover:text-primary"
          >
            <LinkIcon size={15} />
          </button>
        </Tooltip>
      </div>

      <div className="relative">
        {empty && placeholder && (
          <span className="pointer-events-none absolute left-3.5 top-2.5 text-[16px] text-tertiary sm:text-body">
            {placeholder}
          </span>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder ?? "Message"}
          onInput={(e) => onChange(e.currentTarget.innerHTML)}
          onKeyUp={refreshActive}
          onMouseUp={refreshActive}
          onFocus={refreshActive}
          onPaste={(e) => {
            // Paste as plain text: pasting from a webmail client otherwise
            // drags in fonts, colours and tracking markup.
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            document.execCommand("insertText", false, text);
            onChange(editorRef.current?.innerHTML ?? "");
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSubmit?.();
              return;
            }
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          className={cn(
            "scrollbar-slim max-h-64 min-h-[76px] overflow-y-auto px-3.5 py-2.5",
            // 16px on a phone, 14 from sm up. Anything under 16px makes iOS
            // Safari zoom the page when the field takes focus, and it does not
            // zoom back — you are left in a magnified layout mid-reply.
            "text-[16px] text-primary outline-none sm:text-body",
            // Lists need their markers back — Tailwind's preflight removes them.
            "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
            "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
            "[&_a]:text-brand-link [&_a]:underline"
          )}
        />
      </div>
    </div>
  );
});

export default RichTextEditor;
