import { createClient } from "@/lib/supabase/server";
import TicketList from "@/components/TicketList";
import InboxHeader, { SORTS, type SortKey } from "@/components/InboxHeader";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import { CHANNEL_META, type Ticket, type TicketChannel } from "@/lib/types";

export const dynamic = "force-dynamic";

const TITLES: Record<string, string> = {
  open: "Open tickets",
  mine: "My tickets",
  unassigned: "Unassigned",
  all: "All tickets",
  resolved: "Resolved",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; channel?: string; sort?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const view = params.view ?? "open";
  const sort: SortKey =
    params.sort && params.sort in SORTS ? (params.sort as SortKey) : "newest";

  let query = supabase
    .from("tickets")
    .select(
      "*, customer:customers(*), assignee:agents(*), ticket_tags(tag:tags(*))"
    )
    .limit(200);

  if (sort === "priority") {
    // The ticket_priority enum is declared low → urgent, so descending puts
    // urgent first; recency breaks ties.
    query = query
      .order("priority", { ascending: false })
      .order("last_message_at", { ascending: false });
  } else {
    query = query.order("last_message_at", { ascending: sort === "oldest" });
  }

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
  const rows = (tickets as Ticket[]) ?? [];

  const channelLabel = params.channel
    ? (CHANNEL_META[params.channel as TicketChannel]?.label ?? params.channel)
    : null;

  return (
    <div className="mx-auto max-w-4xl px-6 pb-10">
      <RealtimeRefresher />
      <InboxHeader
        title={TITLES[view] ?? "Tickets"}
        count={rows.length}
        channelLabel={channelLabel}
        sort={sort}
      />
      <TicketList tickets={rows} view={view} />
    </div>
  );
}
