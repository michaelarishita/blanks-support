import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import GmailConnect from "@/components/GmailConnect";
import QueuedReplies from "@/components/QueuedReplies";
import SignatureEditor from "@/components/SignatureEditor";
import CompanyBrandEditor from "@/components/CompanyBrandEditor";
import { getCompanySettings } from "@/lib/settings";
import {
  getConnectionForAgent,
  getSupportInboxConnection,
} from "@/lib/google/tokens";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("agents")
    .select("id, name, email, role, gmail_connected, title, phone, signature_enabled")
    .eq("id", user.id)
    .single();

  const configured = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );

  // Token rows are admin-only under RLS, so these go through the service-role
  // client on the server. Only the account address ever reaches the browser.
  const company = await getCompanySettings();
  const connection = await getConnectionForAgent(user.id);
  const supportInbox = me?.role === "admin" ? await getSupportInboxConnection() : null;

  const { count: pendingCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .eq("type", "public")
    .in("delivery_status", ["queued", "failed"]);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-2xl font-bold">Settings</h1>
      <p className="mt-1 text-sm text-gray-500">
        Signed in as {me?.name} · {me?.email}
      </p>

      {params.connected && (
        <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Gmail connected as <span className="font-semibold">{params.connected}</span>.
        </div>
      )}
      {params.error && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {params.error}
        </div>
      )}

      <section className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
          Your Gmail
        </h2>
        <p className="mb-4 mt-1 text-sm text-gray-600">
          Connect your work Gmail so your public replies are delivered as real
          email, sent from your own address.
        </p>
        <GmailConnect
          connectedAs={connection?.account_ref ?? null}
          configured={configured}
        />
      </section>

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
          Signature
        </h2>
        <p className="mb-4 mt-1 text-sm text-gray-600">
          Appended to your outbound email when it&apos;s sent, so edits apply to
          future mail without changing what&apos;s already in a thread.
        </p>
        {me && (
          <SignatureEditor
            agent={{
              name: me.name,
              title: me.title ?? null,
              phone: me.phone ?? null,
              signature_enabled: me.signature_enabled ?? true,
            }}
            company={company}
          />
        )}
      </section>

      {me?.role === "admin" && (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
            Company branding
          </h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            Shared across everyone&apos;s signature. Admin-only, so one agent
            can&apos;t break brand consistency for the team.
          </p>
          <CompanyBrandEditor company={company} />
        </section>
      )}

      {me?.role === "admin" && (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
            Pending replies
          </h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            Replies written before Gmail was connected, plus any that failed to
            send. Retrying is safe — anything already sent is skipped.
          </p>
          <QueuedReplies pendingCount={pendingCount ?? 0} />
        </section>
      )}

      {me?.role === "admin" && (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
            Support mailbox
          </h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            The shared inbox that incoming customer email is pulled from. Connect
            it once, as an admin.
          </p>
          {supportInbox ? (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-gray-700">
                  Connected as{" "}
                  <span className="font-semibold">{supportInbox.account_ref}</span>
                </span>
              </div>
              <a
                href="/api/google/connect?mode=support"
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
              >
                Reconnect
              </a>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span className="inline-block h-2 w-2 rounded-full bg-gray-300" />
                Not connected — inbound email won&apos;t create tickets yet.
              </div>
              <a
                href="/api/google/connect?mode=support"
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                  configured
                    ? "bg-gray-900 text-white hover:bg-gray-700"
                    : "pointer-events-none bg-gray-200 text-gray-400"
                }`}
              >
                Connect support@
              </a>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
