import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import QueryError from "@/components/QueryError";
import Thread from "@/components/Thread";
import ReplyBox from "@/components/ReplyBox";
import TicketHeader from "@/components/TicketHeader";
import TicketSidePanel from "@/components/TicketSidePanel";
import MobileContextSheet from "@/components/MobileContextSheet";
import RiskNotice from "@/components/RiskNotice";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import { ShopifyProvider } from "@/components/ShopifyContext";
import { isMetaChannel, currentReplyWindow } from "@/lib/meta/outbound";
import { markMetaSeen } from "@/lib/meta/send";
import {
  canEmail,
  reconcileStuckSends,
  resolveSender,
} from "@/lib/google/outbound";
import {
  agentDisplayName,
  customerDisplayName,
  customerFirstName,
} from "@/lib/display";
import {
  applyTicketFilters,
  inboxHref,
  nextTicketId,
  ticketHref,
  type TicketViewParams,
} from "@/lib/ticket-query";
import type { Ticket, Message, Agent, Tag } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<TicketViewParams>;
}) {
  const { id } = await params;
  // The view the agent came from, carried on the link out of the inbox, so
  // "next ticket" means next in the list they were actually looking at.
  const view = await searchParams;
  const supabase = await createClient();

  // Sweep abandoned sends before reading the thread, so a reply whose send
  // never completed shows "Failed — retry" rather than "Sending" forever.
  await reconcileStuckSends(id);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [
    { data: ticket, error: ticketError },
    { data: messages },
    { data: agents },
    { data: tags },
    { data: macros },
  ] =
    await Promise.all([
      supabase
        .from("tickets")
        .select(
          "*, customer:customers(*), assignee:agents!tickets_assignee_id_fkey(*), ticket_tags(tag:tags(*))"
        )
        .eq("id", id)
        .single(),
      supabase
        .from("messages")
        .select("*, agent:agents(*), attachments(*)")
        .eq("ticket_id", id)
        .order("created_at", { ascending: true }),
      supabase.from("agents").select("*").eq("is_active", true).order("name"),
      supabase.from("tags").select("*").order("name"),
      supabase.from("macros").select("*").order("title"),
    ]);

  // A failed query is not a missing ticket. notFound() would tell an agent
  // this conversation does not exist — the same lie as "Inbox zero" over a
  // full inbox — so a real error is thrown and the dashboard error boundary
  // shows it with its reason.
  //
  // PGRST116 is the exception: .single() reports "0 rows" as an error, and
  // that one genuinely IS a missing ticket, so it falls through to notFound().
  if (ticketError && ticketError.code !== "PGRST116") {
    return (
      <div className="mx-auto max-w-xl px-6 py-16">
        <QueryError
          title="Couldn't load this ticket — it has NOT been deleted."
          reason={`${ticketError.message}${ticketError.hint ? ` — ${ticketError.hint}` : ""}`}
          note="The conversation is still in the database. This is a read failure, not a missing ticket."
        />
      </div>
    );
  }
  if (!ticket) notFound();

  const t = ticket as Ticket;

  // Which Gmail this agent's replies would leave from, and how many other
  // tickets this customer has — both drive UI copy, so resolve them here
  // rather than round-tripping from the client.
  // The ordered ids of the view, so assigning away or resolving can advance
  // to whatever the agent would have opened next.
  // No error branch on purpose, and the only one on this page: losing this
  // costs the "next ticket" jump, and nothing else on screen becomes untrue.
  const { data: viewRows } = await applyTicketFilters(
    supabase.from("tickets").select("id").limit(200),
    view,
    user?.id ?? null
  );
  const orderedIds = (viewRows ?? []).map((row) => row.id as string);
  const nextId = nextTicketId(orderedIds, id);
  const advanceHref = nextId ? ticketHref(nextId, view) : inboxHref(view);

  // Social tickets: tell Meta the message was seen, and work out how long is
  // left to reply. Both are best-effort — neither may stop the thread
  // rendering, which is why they are awaited separately from the data the
  // page actually needs.
  const replyWindowState = isMetaChannel(t.channel)
    ? await currentReplyWindow(t.id)
    : null;

  if (isMetaChannel(t.channel)) {
    const metaId =
      t.channel === "instagram" ? t.customer?.ig_user_id : t.customer?.fb_psid;
    // Fire-and-forget on purpose: a read receipt is a courtesy to the
    // customer, and failing to set one must not delay opening a ticket.
    if (metaId) void markMetaSeen(metaId);
  }

  const [connection, { count: customerTicketCount }] = await Promise.all([
    user ? resolveSender(user.id) : Promise.resolve(null),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", t.customer_id)
      .neq("id", t.id),
  ]);

  return (
    <ShopifyProvider
      email={t.customer?.email ?? null}
      orderNumber={t.order_number}
    >
    <div className="flex h-full">
      <RealtimeRefresher />
      <div className="flex min-w-0 flex-1 flex-col">
        <TicketHeader
          ticket={t}
          agents={(agents as Agent[]) ?? []}
          currentAgentId={user?.id ?? null}
          advanceHref={advanceHref}
          isLastInView={!nextId}
        />

        {(t.risk_reasons?.length ?? 0) > 0 && (
          <RiskNotice
            ticketId={t.id}
            reasons={t.risk_reasons ?? []}
            dismissedAt={t.risk_dismissed_at ?? null}
          />
        )}

        <div className="scrollbar-slim flex-1 overflow-y-auto bg-surface px-6 py-4">
          <Thread
            messages={(messages as Message[]) ?? []}
            customerName={customerDisplayName(t.customer)}
            customerId={t.customer?.id}
          />
        </div>

        <ReplyBox
          ticketId={t.id}
          macros={macros ?? []}
          customerFirstName={customerFirstName(t.customer)}
          sendingAs={connection?.account_ref ?? null}
          emailCapable={canEmail(t.channel, t.customer?.email)}
          assignedToOther={
            t.assignee && t.assignee.id !== user?.id
              ? agentDisplayName(t.assignee)
              : null
          }
          replyWindow={replyWindowState}
        />

        {/* Context lives ONLY here on a phone — never as a side column. */}
        <MobileContextSheet
          ticket={t}
          agents={(agents as Agent[]) ?? []}
          currentAgentId={user?.id ?? null}
          advanceHref={advanceHref}
          isLastInView={!nextId}
          allTags={(tags as Tag[]) ?? []}
          previousTicketCount={customerTicketCount ?? 0}
        />
      </div>

      {/* Desktop only for now. On a phone this becomes a bottom sheet, which
          is the next piece of 8C — hidden rather than squeezed, because a
          280px context pane beside a 375px thread leaves neither usable. */}
      <div className="hidden md:flex">
      <TicketSidePanel
        ticket={t}
        agents={(agents as Agent[]) ?? []}
        currentAgentId={user?.id ?? null}
        advanceHref={advanceHref}
        isLastInView={!nextId}
        allTags={(tags as Tag[]) ?? []}
        previousTicketCount={customerTicketCount ?? 0}
      />
      </div>
    </div>
    </ShopifyProvider>
  );
}
