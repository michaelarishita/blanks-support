"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { acknowledgeSystemAlert } from "@/app/actions";
import { useToast } from "@/components/ui/Toast";

/**
 * Acknowledging is a claim that a person looked, so it records WHO and WHEN
 * rather than just hiding the row. If the same condition recurs afterwards a
 * fresh alert is raised, starting its own count — an acknowledgement is not a
 * mute.
 */
export default function AcknowledgeAlert({ alertId }: { alertId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await acknowledgeSystemAlert(alertId);
          if (result?.error) {
            toast(result.error, { tone: "error" });
            return;
          }
          router.refresh();
        })
      }
      className="flex-none rounded-md border border-danger-border px-2.5 py-1 text-caption font-semibold text-danger-text hover:bg-danger-bg disabled:opacity-50"
    >
      {pending ? "…" : "I'm on it"}
    </button>
  );
}
