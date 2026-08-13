import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Thread from "@/components/Thread";
import ReplyBox from "@/components/ReplyBox";
import TicketHeader from "@/components/TicketHeader";
import TicketSidePanel from "@/components/TicketSidePanel";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import type { Ticket, Message, Agent, Tag } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

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
        .select("*, agent:agents(*)")
        .eq("ticket_id", id)
        .order("created_at", { ascending: true }),
      supabase.from("agents").select("*").eq("is_active", true).order("name"),
      supabase.from("tags").select("*").order("name"),
      supabase.from("macros").select("*").order("title"),
    ]);

  if (!ticket) notFound();

  const t = ticket as Ticket;

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
        />
      </div>

      <TicketSidePanel
        ticket={t}
        agents={(agents as Agent[]) ?? []}
        allTags={(tags as Tag[]) ?? []}
      />
    </div>
  );
}
