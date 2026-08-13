import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { ToastProvider } from "@/components/ui";

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

  const { data: counts } = await supabase
    .from("tickets")
    .select("status, assignee_id");

  const open =
    counts?.filter((t) => ["new", "open"].includes(t.status)).length ?? 0;
  const mine =
    counts?.filter(
      (t) => t.assignee_id === user.id && !["resolved", "closed"].includes(t.status)
    ).length ?? 0;
  const unassigned =
    counts?.filter(
      (t) => !t.assignee_id && !["resolved", "closed"].includes(t.status)
    ).length ?? 0;

  return (
    <ToastProvider>
      <div className="flex h-screen bg-surface">
        <Sidebar me={me} counts={{ open, mine, unassigned }} />
        <main className="scrollbar-slim flex-1 overflow-y-auto">{children}</main>
      </div>
    </ToastProvider>
  );
}
