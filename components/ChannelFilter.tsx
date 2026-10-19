"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { setOpenChannels } from "@/app/(dashboard)/settings/actions";
import ChannelIcon from "@/components/ui/ChannelIcon";
import { CHANNEL_META, type TicketChannel } from "@/lib/types";

/**
 * The per-agent channel filter on the Open view, remembered in the agent row
 * (not a cookie): the default differs per person — Michael is Website + Email,
 * everyone else all channels — which a cookie can't express.
 *
 * `selected === null` means all channels (the default). The counts live in the
 * sidebar, which always shows every channel, so a deselected channel reads as
 * deselected here while its real count stays visible there — never silently
 * gone. The last selected channel is sticky, like the search facets: filtering
 * the Open view down to nothing you can't see is not a state worth reaching by
 * accident.
 */
const CHANNELS: TicketChannel[] = ["web_form", "email", "instagram", "messenger"];

export default function ChannelFilter({ selected }: { selected: string[] | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const isOn = (c: TicketChannel) => selected === null || selected.includes(c);

  function toggle(c: TicketChannel) {
    const current = selected ?? [...CHANNELS];
    const next = isOn(c) ? current.filter((x) => x !== c) : [...current, c];
    if (next.length === 0) return; // keep at least one selected
    start(async () => {
      await setOpenChannels(next);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter Open by channel">
      <span className="mr-1 text-caption font-medium text-tertiary">Channels</span>
      {CHANNELS.map((c) => {
        const on = isOn(c);
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            disabled={pending}
            onClick={() => toggle(c)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption transition-colors duration-micro ease-out disabled:opacity-60",
              on
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-subtle text-secondary hover:border-strong hover:text-primary"
            )}
          >
            <ChannelIcon channel={c} />
            {CHANNEL_META[c].label}
          </button>
        );
      })}
    </div>
  );
}
