"use client";

import { useCallback, useState } from "react";
import { useHotkey } from "@/lib/shortcuts";
import Modal from "@/components/ui/Modal";

const GROUPS: {
  title: string;
  items: { keys: string[]; label: string; pending?: boolean }[];
}[] = [
  {
    title: "Inbox",
    items: [
      { keys: ["j"], label: "Move down" },
      { keys: ["k"], label: "Move up" },
      { keys: ["↵"], label: "Open ticket" },
      { keys: ["/"], label: "Search", pending: true },
    ],
  },
  {
    title: "Ticket",
    items: [
      { keys: ["r"], label: "Reply" },
      { keys: ["n"], label: "Internal note" },
      { keys: ["e"], label: "Resolve" },
      { keys: ["a"], label: "Assign" },
      { keys: ["⌘", "↵"], label: "Send reply" },
      { keys: ["esc"], label: "Leave the composer" },
    ],
  },
  {
    title: "Anywhere",
    items: [{ keys: ["?"], label: "This help" }],
  },
];

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-[4px] border border-subtle bg-gray-50 px-1.5 font-sans text-[11px] font-medium text-secondary shadow-sm">
      {children}
    </kbd>
  );
}

export default function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useHotkey("?", useCallback(() => setOpen((v) => !v), []));
  // Escape is handled by Modal itself once open.

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      size="md"
    >
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
              {group.title}
            </div>
            <ul className="space-y-1.5">
              {group.items.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center justify-between gap-4"
                >
                  <span
                    className={
                      item.pending ? "text-body text-tertiary" : "text-body text-secondary"
                    }
                  >
                    {item.label}
                    {item.pending && (
                      <span className="ml-1.5 text-caption text-tertiary">
                        (Phase 4)
                      </span>
                    )}
                  </span>
                  <span className="flex flex-none gap-1">
                    {item.keys.map((k) => (
                      <Key key={k}>{k}</Key>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}
