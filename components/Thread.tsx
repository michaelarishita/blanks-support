"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { dayLabel } from "@/lib/format";
import { sanitizeRichText } from "@/lib/html";
import { splitQuotedText } from "@/lib/email/parse";
import Attachments from "@/components/Attachments";
import { retryDelivery } from "@/app/actions";
import type { Message } from "@/lib/types";
import Avatar from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import {
  AlertTriangleIcon,
  CheckDoubleIcon,
  CheckIcon,
  ClockIcon,
  LockIcon,
} from "@/components/ui/icons";

/** Messages from the same author inside this window share one header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const DELIVERY = {
  queued: { label: "Sending", Icon: ClockIcon, className: "text-tertiary" },
  sent: { label: "Sent", Icon: CheckIcon, className: "text-tertiary" },
  // Reserved for a future read/delivery receipt — nothing sets it today.
  delivered: {
    label: "Delivered",
    Icon: CheckDoubleIcon,
    className: "text-tertiary",
  },
  failed: {
    label: "Failed",
    Icon: AlertTriangleIcon,
    className: "text-danger-text",
  },
  stored: { label: "Not emailed", Icon: null, className: "text-tertiary" },
} as const;

/** Identity for grouping: same person *and* same kind of message. */
function authorKey(m: Message): string {
  if (m.type === "internal_note") return `note:${m.agent_id ?? "?"}`;
  if (m.direction === "outbound") return `agent:${m.agent_id ?? "?"}`;
  return "customer";
}

function DeliveryStatus({
  message,
  onRetry,
  retrying,
}: {
  message: Message;
  onRetry: () => void;
  retrying: boolean;
}) {
  const meta = DELIVERY[message.delivery_status as keyof typeof DELIVERY];
  if (!meta) return null;

  const body = (
    <>
      {meta.Icon && <meta.Icon size={12} />}
      {message.delivery_status === "failed"
        ? retrying
          ? "Retrying…"
          : "Failed — retry"
        : meta.label}
    </>
  );

  if (message.delivery_status === "failed") {
    return (
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm text-caption font-medium",
          "transition-opacity duration-micro ease-out hover:underline disabled:opacity-60",
          meta.className
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1 text-caption", meta.className)}>
      {body}
    </span>
  );
}

/** Inbound replies carry the whole thread quoted underneath; hide it. */
function MessageBody({ text, onDark }: { text: string; onDark: boolean }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { visible, quoted } = splitQuotedText(text);

  return (
    <>
      <div className="whitespace-pre-wrap break-words">{visible}</div>
      {quoted && (
        <>
          <button
            type="button"
            onClick={() => setShowQuoted((v) => !v)}
            aria-expanded={showQuoted}
            className={cn(
              "mt-1.5 rounded-sm px-1.5 py-0.5 text-caption leading-none",
              "transition-colors duration-micro ease-out",
              onDark
                ? "bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                : "bg-gray-100 text-tertiary hover:bg-gray-200 hover:text-secondary"
            )}
            title={showQuoted ? "Hide quoted text" : "Show quoted text"}
          >
            •••
          </button>
          {showQuoted && (
            <div
              className={cn(
                "mt-2 whitespace-pre-wrap break-words border-l-2 pl-2.5 text-caption",
                onDark ? "border-white/20 text-gray-400" : "border-gray-200 text-tertiary"
              )}
            >
              {quoted}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function Thread({
  messages,
  customerName,
  customerId,
}: {
  messages: Message[];
  customerName: string;
  customerId?: string | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Tracked per-message so one retry doesn't spin every failed reply.
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const toast = useToast();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  function retry(id: string) {
    setRetryingId(id);
    startTransition(async () => {
      const res = await retryDelivery(id);
      if (res?.error) toast(res.error, { tone: "error" });
      else toast("Reply sent", { tone: "success" });
      setRetryingId(null);
    });
  }

  return (
    <div className="mx-auto w-full max-w-[680px] pb-2">
      {messages.map((m, i) => {
        const previous = i > 0 ? messages[i - 1] : null;
        const isNote = m.type === "internal_note";
        const isAgent = m.direction === "outbound";
        const author = isAgent ? (m.agent?.name ?? "Agent") : customerName;

        const showDivider =
          !previous || dayLabel(previous.created_at) !== dayLabel(m.created_at);

        const grouped =
          !showDivider &&
          previous !== null &&
          authorKey(previous) === authorKey(m) &&
          new Date(m.created_at).getTime() -
            new Date(previous.created_at).getTime() <
            GROUP_WINDOW_MS;

        const time = new Date(m.created_at).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });

        return (
          <div key={m.id}>
            {showDivider && (
              <div className="flex items-center gap-3 py-4">
                <div className="h-px flex-1 bg-gray-200" />
                <span className="text-caption font-medium text-tertiary">
                  {dayLabel(m.created_at)}
                </span>
                <div className="h-px flex-1 bg-gray-200" />
              </div>
            )}

            <div
              className={cn(
                "flex items-end gap-2",
                grouped ? "mt-0.5" : "mt-3",
                isNote ? "justify-start" : isAgent ? "justify-end" : "justify-start"
              )}
            >
              {/* Leading avatar for inbound + notes; a spacer keeps grouped
                  messages aligned with the first in their run. */}
              {!isAgent || isNote ? (
                <div className="w-7 flex-none self-end">
                  {!grouped && (
                    <Avatar
                      name={author}
                      seed={isNote ? (m.agent_id ?? author) : (customerId ?? author)}
                      src={isNote ? m.agent?.avatar_url : null}
                      size="sm"
                    />
                  )}
                </div>
              ) : null}

              <div className={cn("min-w-0 max-w-[82%]")}>
                {!grouped && (
                  <div
                    className={cn(
                      "mb-1 flex items-baseline gap-2 text-caption",
                      isAgent && !isNote ? "justify-end" : "justify-start"
                    )}
                  >
                    <span
                      className={cn(
                        "font-medium",
                        isNote ? "text-warning-text" : "text-secondary"
                      )}
                    >
                      {isNote && (
                        <LockIcon size={11} className="mr-1 inline align-[-1px]" />
                      )}
                      {isNote ? `Internal note · ${author}` : author}
                    </span>
                    <time
                      dateTime={m.created_at}
                      title={new Date(m.created_at).toLocaleString()}
                      className="text-tertiary"
                    >
                      {time}
                    </time>
                  </div>
                )}

                <div
                  className={cn(
                    "px-3.5 py-2.5 text-body",
                    isNote
                      ? // Off the record: amber wash, dashed rail, square-ish
                        // so it never reads as something the customer saw.
                        "rounded-md border-l-2 border-dashed border-warning-border bg-warning-bg text-primary"
                      : isAgent
                        ? "rounded-bubble rounded-br-[4px] bg-gray-900/[0.96] text-white shadow-sm"
                        : "rounded-bubble rounded-bl-[4px] border border-subtle bg-panel text-primary shadow-sm"
                  )}
                >
                  {m.body_html ? (
                    // Sanitized on write; sanitized again here because this
                    // renders as markup and defence in depth is cheap.
                    <div
                      className={cn(
                        "break-words",
                        "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
                        "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5",
                        "[&_a]:underline",
                        isAgent && !isNote ? "[&_a]:text-brand-300" : "[&_a]:text-brand-800"
                      )}
                      dangerouslySetInnerHTML={{
                        __html: sanitizeRichText(m.body_html),
                      }}
                    />
                  ) : (
                    <MessageBody
                      text={m.body_text}
                      onDark={isAgent && !isNote}
                    />
                  )}
                  {m.attachments && m.attachments.length > 0 && (
                    <Attachments
                      attachments={m.attachments}
                      onDark={isAgent && !isNote}
                    />
                  )}
                </div>

                {isAgent && !isNote && (
                  <div className="mt-1 flex justify-end">
                    <DeliveryStatus
                      message={m}
                      retrying={retryingId === m.id}
                      onRetry={() => retry(m.id)}
                    />
                  </div>
                )}
              </div>

              {/* Trailing avatar for outbound replies. */}
              {isAgent && !isNote ? (
                <div className="w-7 flex-none self-end">
                  {!grouped && (
                    <Avatar
                      name={author}
                      seed={m.agent_id ?? author}
                      src={m.agent?.avatar_url}
                      size="sm"
                    />
                  )}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
