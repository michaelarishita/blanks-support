import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import TicketList from "@/components/TicketList";
import InboxHeader from "@/components/InboxHeader";
import MineStatusFilter from "@/components/MineStatusFilter";
import SenderFilter from "@/components/SenderFilter";
import {
  applyTicketFilters,
  resolveMineStatus,
  resolveSenderCustomerIds,
  resolveSort,
  viewQueryString,
  type TicketViewParams,
} from "@/lib/ticket-query";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import { agentDisplayName } from "@/lib/display";
import { CHANNEL_META, type Ticket, type TicketChannel } from "@/lib/types";
import { JUNK_RETENTION_DAYS } from "@/lib/inbound/junk";

export const dynamic = "force-dynamic";

const TITLES: Record<string, string> = {
  open: "Open tickets",
  mine: "My tickets",
  unassigned: "Unassigned",
  all: "All tickets",
  resolved: "Resolved",
  junk: "Junk",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<TicketViewParams>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const view = params.view ?? "open";
  const sort = resolveSort(params.sort);

  // My-tickets remembers its status scope for the session. When the URL does
  // not carry one — e.g. the sidebar's static "My tickets" link — fall back to
  // the cookie the toggle wrote, and NORMALISE the URL so the ordered list, the
  // ticket links and "next ticket" all read the same scope. Without the
  // redirect, TicketList's links (built from the URL) would drop the status and
  // auto-advance would jump into the wrong list.
  if (view === "mine" && params.status === undefined) {
    const remembered = (await cookies()).get("mine_status")?.value;
    if (remembered === "resolved" || remembered === "all") {
      redirect(`/inbox${viewQueryString({ ...params, view: "mine", status: remembered })}`);
    }
  }

  // The sender text is resolved to customer ids here (the filter builder is
  // synchronous). undefined when there is no sender filter, so it is skipped;
  // an empty array when the text matched nobody, which is zero results.
  const senderCustomerIds = params.sender
    ? await resolveSenderCustomerIds(supabase, params.sender)
    : undefined;

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
      // agents!tickets_assignee_id_fkey, not agents: 0015 added
      // tickets.risk_dismissed_by -> agents, so a bare `agents` embed is
      // ambiguous and PostgREST answers PGRST201 for the whole query.
      .from("tickets")
      .select(
        "*, customer:customers(*), assignee:agents!tickets_assignee_id_fkey(*), ticket_tags(tag:tags(*))"
      )
      .limit(200),
    params,
    user?.id ?? null,
    senderCustomerIds
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

  const title = assigneeName
    ? `Assigned to ${assigneeName}`
    : params.sender
      ? `Tickets from “${params.sender}”`
      : customerName
        ? `Tickets from ${customerName}`
        : (TITLES[view] ?? "Tickets");

  return (
    <div className="mx-auto max-w-4xl px-0 pb-10 sm:px-6">
      <RealtimeRefresher />
      <InboxHeader
        title={title}
        count={rows.length}
        channelLabel={channelLabel}
        sort={sort}
      />

      {/* Junk is filed, not deleted — but it does not live forever. Say so, so
          the purge is never a surprise and an agent knows the review window. */}
      {view === "junk" && (
        <div className="px-3 pb-3 sm:px-0">
          <p className="rounded-md border border-subtle bg-panel px-3 py-2 text-caption text-tertiary">
            Mail a guard, an override, or the classifier filed as junk. Nothing
            here is in anyone&rsquo;s queue. Open one and choose{" "}
            <span className="font-medium text-secondary">Not spam</span> to send it
            back to the inbox. Junk is purged after {JUNK_RETENTION_DAYS} days.
          </p>
        </div>
      )}

      {/* Sender filter lives on the All view — it combines with the channel
          filter rather than replacing it. */}
      {view === "all" && (
        <div className="px-3 pb-3 sm:px-0">
          <SenderFilter initial={params.sender ?? ""} />
        </div>
      )}

      {/* The Open / Resolved / All scope for My tickets. */}
      {view === "mine" && (
        <div className="px-3 pb-3 sm:px-0">
          <MineStatusFilter status={resolveMineStatus(params.status)} />
        </div>
      )}

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
