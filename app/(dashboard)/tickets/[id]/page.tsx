import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Thread from "@/components/Thread";
import ReplyBox from "@/components/ReplyBox";
import TicketHeader from "@/components/TicketHeader";
import TicketSidePanel from "@/components/TicketSidePanel";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import {
  canEmail,
  reconcileStuckSends,
  resolveSender,
} from "@/lib/google/outbound";
import type { Ticket, Message, Agent, Tag } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Sweep abandoned sends before reading the thread, so a reply whose send
  // never completed shows "Failed — retry" rather than "Sending" forever.
  await reconcileStuckSends(id);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: ticket }, { data: messages }, { data: agents }, { data: tags }, { data: macros }] =
    await Promise.all([
      supabase
        .from("tickets")
        .select(
          "*, customer:customers(*), assignee:agents(*), ticket_tags(tag:tags(*))"
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

  if (!ticket) notFound();

  const t = ticket as Ticket;

  // Which Gmail this agent's replies would leave from, and how many other
  // tickets this customer has — both drive UI copy, so resolve them here
  // rather than round-tripping from the client.
  const [connection, { count: customerTicketCount }] = await Promise.all([
    user ? resolveSender(user.id) : Promise.resolve(null),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", t.customer_id)
      .neq("id", t.id),
  ]);

  return (
    <div className="flex h-full">
      <RealtimeRefresher />
      <div className="flex min-w-0 flex-1 flex-col">
        <TicketHeader
          ticket={t}
          agents={(agents as Agent[]) ?? []}
          currentAgentId={user?.id ?? null}
        />

        <div className="scrollbar-slim flex-1 overflow-y-auto bg-surface px-6 py-4">
          <Thread
            messages={(messages as Message[]) ?? []}
            customerName={t.customer?.name ?? t.customer?.email ?? "Customer"}
            customerId={t.customer?.id}
          />
        </div>

        <ReplyBox
          ticketId={t.id}
          macros={macros ?? []}
          customerFirstName={(t.customer?.name ?? "").split(" ")[0]}
          sendingAs={connection?.account_ref ?? null}
          emailCapable={canEmail(t.channel, t.customer?.email)}
        />
      </div>

      <TicketSidePanel
        ticket={t}
        allTags={(tags as Tag[]) ?? []}
        previousTicketCount={customerTicketCount ?? 0}
      />
    </div>
  );
}
