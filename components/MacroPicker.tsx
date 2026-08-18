"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Dropdown } from "@/components/ui/Dropdown";
import { Input } from "@/components/ui/Field";
import { SearchIcon, ZapIcon } from "@/components/ui/icons";

export interface Macro {
  id: string;
  title: string;
  body: string;
}

export default function MacroPicker({
  macros,
  onPick,
}: {
  macros: Macro[];
  onPick: (macro: Macro) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return macros;
    // Match the body too — agents remember the phrasing, not the title.
    return macros.filter(
      (m) =>
        m.title.toLowerCase().includes(q) || m.body.toLowerCase().includes(q)
    );
  }, [macros, query]);

  // Mobile gets a sheet instead of a popover. A 320px dropdown anchored to a
  // toolbar button on a 390px screen leaves no room for the search field the
  // list needs, and the keyboard covers whatever is left.
  const sheet =
    open && typeof document !== "undefined"
      ? createPortal(
          <div className="fixed inset-0 z-50 flex flex-col justify-end sm:hidden">
            <div
              className="absolute inset-0 animate-fade-in bg-gray-950/40"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Macros"
              className="pb-safe-3 relative flex max-h-[80dvh] animate-slide-up flex-col rounded-t-2xl bg-panel shadow-lg"
            >
              <div className="flex-none px-3 pb-2 pt-3">
                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search macros…"
                  // 16px, or iOS zooms the page the moment this takes focus.
                  className="h-12 text-[16px]"
                />
              </div>
              <div className="scrollbar-slim scroll-touch min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {filtered.length === 0 ? (
                  <p className="px-2 py-8 text-center text-caption text-tertiary">
                    No macros match “{query}”.
                  </p>
                ) : (
                  filtered.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        onPick(m);
                        setOpen(false);
                        setQuery("");
                      }}
                      // 56px rows: this is a list you scan and tap while
                      // holding the phone one-handed.
                      className="block min-h-[56px] w-full rounded-md px-3 py-2.5 text-left active:bg-gray-100"
                    >
                      <span className="block text-label text-primary">{m.title}</span>
                      <span className="mt-0.5 block truncate text-caption text-tertiary">
                        {m.body.replace(/\s+/g, " ")}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
    {sheet}
    <Dropdown
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      side="top"
      align="end"
      // The popover itself is desktop-only; the sheet above covers mobile.
      menuClassName="hidden sm:block w-[320px] p-0"
      trigger={(isOpen) => (
        <span
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-sm px-2 text-caption font-medium",
            "transition-colors duration-micro ease-out",
            isOpen
              ? "bg-gray-100 text-primary"
              : "text-secondary hover:bg-gray-100 hover:text-primary"
          )}
        >
          <ZapIcon size={13} />
          Macros
        </span>
      )}
    >
      {(close) => (
        <div>
          <div className="relative border-b border-subtle p-2">
            <SearchIcon
              size={14}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-tertiary"
            />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search macros…"
              className="h-8 border-0 bg-transparent pl-7 shadow-none focus:border-0"
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[0]) {
                  onPick(filtered[0]);
                  close();
                }
              }}
            />
          </div>

          <div className="scrollbar-slim max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-caption text-tertiary">
                No macros match “{query}”.
              </p>
            ) : (
              filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onPick(m);
                    close();
                  }}
                  className="block w-full rounded-sm px-2 py-1.5 text-left transition-colors duration-micro ease-out hover:bg-gray-100"
                >
                  <span className="block text-label text-primary">{m.title}</span>
                  <span className="mt-0.5 block truncate text-caption text-tertiary">
                    {m.body.replace(/\s+/g, " ")}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Dropdown>
    </>
  );
}
