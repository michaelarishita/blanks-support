import { createClient } from "@/lib/supabase/server";
import TicketList from "@/components/TicketList";
import InboxHeader from "@/components/InboxHeader";
import { applyTicketFilters, resolveSort } from "@/lib/ticket-query";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import { agentDisplayName } from "@/lib/display";
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
  searchParams: Promise<{
    view?: string;
    channel?: string;
    sort?: string;
    customer?: string;
    assignee?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const view = params.view ?? "open";
  const sort = resolveSort(params.sort);

  // Same builder the ticket page uses to work out what comes next, so the two
  // orderings can't drift apart.
  //
  // The error is READ, not discarded.
  //
  // Dropping it meant a failed query produced `data: null`, which became an
  // empty array, which rendered "Inbox zero" over eight live tickets. That is
  // indistinguishable from a quiet morning and it is the worst lie this
  // product can tell.
  const { data: tickets, error: ticketsError } = await applyTicketFilters(
    supabase
      .from("tickets")
      // agents!tickets_assignee_id_fkey, not agents: 0015 added
      // tickets.risk_dismissed_by -> agents, so a bare `agents` embed is
      // ambiguous and PostgREST answers PGRST201 for the whole query.
      .select(
        "*, customer:customers(*), assignee:agents!tickets_assignee_id_fkey(*), ticket_tags(tag:tags(*))"
      )
      .limit(200),
    params,
    user?.id ?? null
  );
  const rows = (tickets as Ticket[]) ?? [];

  const channelLabel = params.channel
    ? (CHANNEL_META[params.channel as TicketChannel]?.label ?? params.channel)
    : null;

  const assigneeName = params.assignee
    ? agentDisplayName(rows.find((t) => t.assignee?.id === params.assignee)?.assignee)
    : null;

  const customerName = params.customer
    ? (rows[0]?.customer?.name ?? rows[0]?.customer?.email ?? "this customer")
    : null;

  return (
    <div className="mx-auto max-w-4xl px-0 pb-10 sm:px-6">
      <RealtimeRefresher />
      <InboxHeader
        title={
          assigneeName
            ? `Assigned to ${assigneeName}`
            : customerName
              ? `Tickets from ${customerName}`
              : (TITLES[view] ?? "Tickets")
        }
        count={rows.length}
        channelLabel={channelLabel}
        sort={sort}
      />
      <TicketList
        tickets={rows}
        view={view}
        currentAgentId={user?.id ?? null}
        error={
          ticketsError
            ? `${ticketsError.message}${ticketsError.hint ? ` — ${ticketsError.hint}` : ""}`
            : null
        }
      />
    </div>
  );
}
