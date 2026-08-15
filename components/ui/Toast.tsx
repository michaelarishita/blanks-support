"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { AlertTriangleIcon, CheckIcon, XIcon } from "./icons";

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  tone?: ToastTone;
  /** Label + handler for a single inline action, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /**
   * Optional navigation alongside the action — used when a toast outlives the
   * page that raised it, so there's still a way back to what it refers to.
   */
  link?: { label: string; href: string };
  /** Milliseconds before auto-dismiss. Errors default to staying longer. */
  duration?: number;
}

interface ToastRecord extends Required<Pick<ToastOptions, "tone">> {
  id: number;
  message: string;
  action?: ToastOptions["action"];
  link?: ToastOptions["link"];
}

const ToastContext = createContext<(message: string, options?: ToastOptions) => void>(
  () => {}
);

/** `const toast = useToast(); toast("Reply sent", { tone: "success" })` */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = nextId.current++;
      const tone = options.tone ?? "info";
      setToasts((current) => [
        // Cap the stack so a burst of realtime updates can't cover the screen.
        ...current.slice(-2),
        { id, message, tone, action: options.action, link: options.link },
      ]);

      // A toast carrying navigation is one the reader has to act on, so it
      // stays put longer than a simple confirmation.
      const duration =
        options.duration ??
        (tone === "error" ? 7000 : options.link || options.action ? 8000 : 4000);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration)
      );
    },
    [dismiss]
  );

  // Clear pending timers if the provider unmounts mid-flight.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        // polite: a toast is a confirmation, it shouldn't interrupt a
        // screen reader mid-sentence.
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex animate-toast-in items-start gap-2.5 rounded-md bg-gray-900 py-2.5 pl-3 pr-2 shadow-lg"
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex-none",
                t.tone === "success" && "text-success-border",
                t.tone === "error" && "text-danger-border",
                t.tone === "info" && "text-brand-300"
              )}
            >
              {t.tone === "error" ? <AlertTriangleIcon /> : <CheckIcon />}
            </span>
            <p className="min-w-0 flex-1 break-words py-0.5 text-body text-white">
              {t.message}
            </p>
            {t.link && (
              <Link
                href={t.link.href}
                onClick={() => dismiss(t.id)}
                className="flex-none rounded-sm px-2 py-1 text-label font-semibold text-brand-300 transition-colors duration-micro ease-out hover:bg-white/10"
              >
                {t.link.label}
              </Link>
            )}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="flex-none rounded-sm px-2 py-1 text-label font-semibold text-brand-300 transition-colors duration-micro ease-out hover:bg-white/10"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="flex-none rounded-sm p-1 text-gray-400 transition-colors duration-micro ease-out hover:bg-white/10 hover:text-white"
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
