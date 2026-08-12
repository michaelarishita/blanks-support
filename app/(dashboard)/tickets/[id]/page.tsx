import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import Thread from "@/components/Thread";
import ReplyBox from "@/components/ReplyBox";
import TicketSidePanel from "@/components/TicketSidePanel";
import RealtimeRefresher from "@/components/RealtimeRefresher";
import { CHANNEL_META, STATUS_META } from "@/lib/types";
import type { Ticket, Message, Agent, Tag } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();

  const [{ data: ticket }, { data: messages }, { data: agents }, { data: tags }, { data: macros }] =
    await Promise.all([
      supabase
        .from("tickets")
        .select(
          "*, customer:customers(*), assignee:agents(*), ticket_tags(tag:tags(*))"
        )
        .eq("id", params.id)
        .single(),
      supabase
        .from("messages")
        .select("*, agent:agents(*)")
        .eq("ticket_id", params.id)
        .order("created_at", { ascending: true }),
      supabase.from("agents").select("*").eq("is_active", true).order("name"),
      supabase.from("tags").select("*").order("name"),
      supabase.from("macros").select("*").order("title"),
    ]);

  if (!ticket) notFound();

  const t = ticket as Ticket;
  const status = STATUS_META[t.status];
  const channel = CHANNEL_META[t.channel];

  return (
    <div className="flex h-full">
      <RealtimeRefresher />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* header */}
        <div className="flex items-center gap-3 border-b border-gray-200 bg-white px-6 py-3.5">
          <Link href="/inbox" className="text-gray-400 hover:text-gray-700">
            ←
          </Link>
          <span className="text-lg">{channel.icon}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">{t.subject}</div>
            <div className="text-xs text-gray-400">
              #{t.number} · {channel.label}
              {t.topic ? ` · ${t.topic}` : ""}
            </div>
          </div>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${status.classes}`}
          >
            {status.label}
          </span>
        </div>

        {/* thread */}
        <div className="flex-1 overflow-y-auto bg-gray-50 px-6 py-5">
          <Thread messages={(messages as Message[]) ?? []} customerName={t.customer?.name ?? t.customer?.email ?? "Customer"} />
        </div>

        {/* reply */}
        <ReplyBox ticketId={t.id} macros={macros ?? []} customerFirstName={(t.customer?.name ?? "").split(" ")[0]} />
      </div>

      <TicketSidePanel
        ticket={t}
        agents={(agents as Agent[]) ?? []}
        allTags={(tags as Tag[]) ?? []}
      />
    </div>
  );
}
