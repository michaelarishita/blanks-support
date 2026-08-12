"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import type { Agent } from "@/lib/types";

const VIEWS = [
  { key: "open", label: "Open", href: "/inbox?view=open" },
  { key: "mine", label: "My tickets", href: "/inbox?view=mine" },
  { key: "unassigned", label: "Unassigned", href: "/inbox?view=unassigned" },
  { key: "all", label: "All tickets", href: "/inbox?view=all" },
  { key: "resolved", label: "Resolved", href: "/inbox?view=resolved" },
];

const CHANNELS = [
  { key: "web_form", label: "🌐 Website" },
  { key: "email", label: "📧 Email" },
  { key: "instagram", label: "📸 Instagram" },
  { key: "messenger", label: "💬 Messenger" },
];

export default function Sidebar({
  me,
  counts,
}: {
  me: Agent | null;
  counts: { open: number; mine: number; unassigned: number };
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const activeView = params.get("view") ?? "open";
  const activeChannel = params.get("channel");

  async function signOut() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const countFor = (key: string) =>
    key === "open" ? counts.open : key === "mine" ? counts.mine : key === "unassigned" ? counts.unassigned : null;

  return (
    <aside className="flex w-60 flex-none flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-5 py-4">
        <div className="text-[10px] font-bold uppercase tracking-widest text-amber-500">
          Blanks
        </div>
        <div className="text-lg font-bold leading-tight">Support</div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Views
        </div>
        {VIEWS.map((v) => {
          const active = pathname === "/inbox" && activeView === v.key && !activeChannel;
          const n = countFor(v.key);
          return (
            <Link
              key={v.key}
              href={v.href}
              className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm ${
                active
                  ? "bg-amber-50 font-semibold text-amber-800"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {v.label}
              {n !== null && n > 0 && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                  {n}
                </span>
              )}
            </Link>
          );
        })}

        <div className="mb-1 mt-5 px-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Channels
        </div>
        {CHANNELS.map((c) => {
          const active = activeChannel === c.key;
          return (
            <Link
              key={c.key}
              href={`/inbox?view=all&channel=${c.key}`}
              className={`block rounded-lg px-2.5 py-1.5 text-sm ${
                active
                  ? "bg-amber-50 font-semibold text-amber-800"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {c.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-gray-100 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold">{me?.name ?? "…"}</div>
            <div className="text-xs text-gray-400">{me?.role}</div>
          </div>
          <button
            onClick={signOut}
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
