import { createClient } from "@/lib/supabase/server";
import TicketList from "@/components/TicketList";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import type { Ticket } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; channel?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const view = params.view ?? "open";

  let query = supabase
    .from("tickets")
    .select(
      "*, customer:customers(*), assignee:agents(*), ticket_tags(tag:tags(*))"
    )
    .order("last_message_at", { ascending: false })
    .limit(200);

  if (view === "open") query = query.in("status", ["new", "open"]);
  if (view === "mine")
    query = query
      .eq("assignee_id", user!.id)
      .not("status", "in", "(resolved,closed)");
  if (view === "unassigned")
    query = query
      .is("assignee_id", null)
      .not("status", "in", "(resolved,closed)");
  if (view === "resolved") query = query.in("status", ["resolved", "closed"]);
  if (params.channel) query = query.eq("channel", params.channel);

  const { data: tickets } = await query;

  const titles: Record<string, string> = {
    open: "Open tickets",
    mine: "My tickets",
    unassigned: "Unassigned",
    all: "All tickets",
    resolved: "Resolved",
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-6">
      <RealtimeRefresher />
      <h1 className="mb-4 text-xl font-bold">
        {titles[view] ?? "Tickets"}
        {params.channel && (
          <span className="ml-2 text-sm font-normal text-gray-400">
            · {params.channel.replace("_", " ")}
          </span>
        )}
      </h1>
      <TicketList tickets={(tickets as Ticket[]) ?? []} />
    </div>
  );
}
