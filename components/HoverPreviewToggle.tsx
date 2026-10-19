"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { setHoverPreview } from "@/app/(dashboard)/settings/actions";
import { useToast } from "@/components/ui/Toast";

/**
 * The desktop hover-preview on/off switch. Off by default; some people read the
 * queue by sweeping and want the pane, others find it noisy — so it is
 * per-agent rather than a global.
 */
export default function HoverPreviewToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [on, setOn] = useState(enabled);
  const [pending, start] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next); // optimistic
    start(async () => {
      const res = await setHoverPreview(next);
      if (res?.error) {
        setOn(!next);
        toast(res.error, { tone: "error" });
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-gray-800">Hover preview</div>
        <p className="mt-0.5 text-caption text-gray-500">
          On a wide screen, hovering a ticket row shows a reading pane with the
          message — enough to judge it without opening it.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Hover preview"
        disabled={pending}
        onClick={toggle}
        className={cn(
          "relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors duration-micro ease-out disabled:opacity-60",
          on ? "bg-gray-900" : "bg-gray-300"
        )}
      >
        <span
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-micro ease-out",
            on ? "translate-x-5" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  );
}
