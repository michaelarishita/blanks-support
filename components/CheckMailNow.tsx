"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { checkMailNow } from "@/app/(dashboard)/settings/actions";
import Button from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { RefreshIcon } from "@/components/ui/icons";

export default function CheckMailNow({ connected }: { connected: boolean }) {
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();

  function run() {
    setSummary(null);
    startTransition(async () => {
      const result = await checkMailNow();
      if (result.error) {
        toast(result.error, { tone: "error" });
        return;
      }

      const skipped = Object.entries(result.skipped);
      const ruleHits = Object.entries(result.ruleHits ?? {});
      setSummary(
        [
          `Checked ${result.checked}`,
          `${result.created} new ticket${result.created === 1 ? "" : "s"}`,
          `${result.appended} added to existing`,
          // Surfacing skips matters: "checked 3, created 0" with no reason
          // reads as broken when it's usually loop protection working.
          skipped.length
            ? `skipped ${skipped.map(([why, n]) => `${n} × ${why}`).join(", ")}`
            : null,
          // Same reasoning for routing: a rule that quietly reassigned inbound
          // mail should be visible from the button that pulled it in.
          ruleHits.length
            ? `rules ${ruleHits.map(([name, n]) => `${n} × ${name}`).join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      );

      if (result.created || result.appended) {
        toast(
          `${result.created + result.appended} message${
            result.created + result.appended === 1 ? "" : "s"
          } imported`,
          { tone: "success" }
        );
      }
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-gray-600">
          {connected
            ? "Pull anything new from the support mailbox right now."
            : "Connect the support mailbox first."}
        </p>
        <Button
          variant="secondary"
          onClick={run}
          loading={pending}
          disabled={!connected}
        >
          <RefreshIcon size={14} />
          Check mail now
        </Button>
      </div>
      {summary && <p className="mt-3 text-xs text-gray-600">{summary}</p>}
    </div>
  );
}
