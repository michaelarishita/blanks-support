import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ShortcutsOverlay from "@/components/ShortcutsOverlay";
import MailPoller from "@/components/MailPoller";
import SystemAlertBanner from "@/components/SystemAlertBanner";
import SchemaBanner from "@/components/SchemaBanner";
import { ToastProvider } from "@/components/ui";
import MobileTopBar from "@/components/MobileTopBar";
import PullToRefresh from "@/components/PullToRefresh";
import type { TicketChannel } from "@/lib/types";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("agents")
    .select("*")
    .eq("id", user.id)
    .single();

  const { data: counts, error: countsError } = await supabase
    .from("tickets")
    .select("status, assignee_id, channel");

  // A failed count must not render as "0 open". Zero is a claim about the
  // inbox; a failure is the absence of one, and the sidebar shows nothing at
  // all rather than a number nobody measured.
  if (countsError) {
    console.error("[layout] ticket counts failed:", countsError);
  }

  /** What the Open view means, in one place now that two things ask. */
  const isOpen = (status: string) => ["new", "open"].includes(status);

  const measured = !countsError;
  const open = counts?.filter((t) => isOpen(t.status)).length ?? 0;
  const mine =
    counts?.filter(
      (t) => t.assignee_id === user.id && !["resolved", "closed"].includes(t.status)
    ).length ?? 0;
  const unassigned =
    counts?.filter(
      (t) => !t.assignee_id && !["resolved", "closed"].includes(t.status)
    ).length ?? 0;

  // Counted here rather than with four `head: true` count queries: the rows
  // are already loaded for the view counts above, so this is free.
  const byChannel: Record<TicketChannel, number> = {
    web_form: 0,
    email: 0,
    instagram: 0,
    messenger: 0,
  };
  for (const ticket of counts ?? []) {
    const channel = ticket.channel as TicketChannel;
    if (isOpen(ticket.status) && channel in byChannel) byChannel[channel]++;
  }

  return (
    <ToastProvider>
      {/* dvh, not vh: on iOS Safari 100vh is the tallest the viewport ever
          gets, so a full-height app layout puts its own bottom edge behind the
          browser chrome and nothing at the foot of the page is reachable. */}
      <div className="flex h-[100dvh] bg-surface">
        {/* The sidebar is the desktop navigation. On a phone it becomes the
            chip bar below — not a hamburger, because switching views is the
            most frequent thing triage does and a menu adds two taps to it. */}
        <div className="hidden md:flex">
          <Sidebar
            me={me}
            counts={measured ? { open, mine, unassigned } : null}
            channelCounts={measured ? byChannel : null}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileTopBar
            counts={measured ? { open, mine, unassigned } : null}
            channelCounts={measured ? byChannel : null}
          />
          {/* Schema first: an unrun migration explains most other symptoms. */}
          <SchemaBanner />
          <SystemAlertBanner />
          <PullToRefresh className="scrollbar-slim scroll-touch flex-1 overflow-y-auto">
            {children}
          </PullToRefresh>
        </div>
      </div>
      <ShortcutsOverlay />
      {/* Safety net behind Pub/Sub push; 5 min unless overridden. */}
      <MailPoller
        intervalSeconds={Number(process.env.NEXT_PUBLIC_MAIL_POLL_SECONDS) || 300}
      />
    </ToastProvider>
  );
}
