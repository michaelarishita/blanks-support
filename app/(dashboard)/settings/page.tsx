import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import GmailConnect from "@/components/GmailConnect";
import QueuedReplies from "@/components/QueuedReplies";
import SignatureEditor from "@/components/SignatureEditor";
import CompanyBrandEditor from "@/components/CompanyBrandEditor";
import CheckMailNow from "@/components/CheckMailNow";
import IgnoredSenderList from "@/components/IgnoredSenderList";
import NotificationToggle from "@/components/NotificationToggle";
import ProfileEditor from "@/components/ProfileEditor";
import { getCompanySettings } from "@/lib/settings";
import { readIgnoredSenders } from "@/lib/senders/ignored";
import {
  getConnectionForAgent,
  getSupportInboxConnection,
} from "@/lib/google/tokens";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    mismatch?: string;
    expected?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("agents")
    .select(
      "id, name, display_name, email, role, gmail_connected, title, phone, signature_enabled, notifications_enabled, watch_new_tickets"
    )
    .eq("id", user.id)
    .single();

  const configured = Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
  // Read from config rather than hardcoded: which mailbox is "the support
  // mailbox" is a deployment decision, and it has already changed once.
  const supportAddress = process.env.SUPPORT_EMAIL ?? "the support mailbox";

  // Token rows are admin-only under RLS, so these go through the service-role
  // client on the server. Only the account address ever reaches the browser.
  const company = await getCompanySettings();
  const connection = await getConnectionForAgent(user.id);
  const supportInbox = me?.role === "admin" ? await getSupportInboxConnection() : null;
  const ignored = await readIgnoredSenders();

  const { count: pendingCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .eq("type", "public")
    .in("delivery_status", ["queued", "failed"]);

  // null distinguishes "the migration hasn't been run" from "no rules are on",
  // which look identical as a zero and mean entirely different things.
  const { count: ruleCount, error: rulesError } = await supabase
    .from("rules")
    .select("id", { count: "exact", head: true })
    .eq("enabled", true);
  const liveRuleCount = rulesError ? null : (ruleCount ?? 0);

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
      {params.mismatch && (
        <div className="mt-6 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
          <p className="font-semibold">
            Not connected — that isn&apos;t the support mailbox.
          </p>
          <p className="mt-1">
            You signed in as{" "}
            <span className="font-mono text-mono">{params.mismatch}</span>, but
            SUPPORT_EMAIL is{" "}
            <span className="font-mono text-mono">{params.expected}</span>.
            Inbound mail is read from SUPPORT_EMAIL, so connecting this account
            would mean customer email is never picked up — silently, with
            nothing erroring.
          </p>
          <p className="mt-2">
            Connect again and choose{" "}
            <span className="font-mono text-mono">{params.expected}</span>, or
            change SUPPORT_EMAIL if this account is genuinely the right one.
          </p>
          <a
            href="/api/google/connect?mode=support&allowMismatch=1"
            className="mt-3 inline-block rounded-md border border-danger-border px-3 py-1.5 text-xs font-semibold hover:bg-danger-bg"
          >
            I know — connect {params.mismatch} anyway
          </a>
        </div>
      )}

      {params.error && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {params.error}
        </div>
      )}

      <section className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
          Your profile
        </h2>
        <p className="mb-4 mt-1 text-sm text-gray-600">
          How your teammates see you inside this dashboard. Customers never see
          this — the name on your outbound email is set under Signature.
        </p>
        {me && (
          <ProfileEditor
            displayName={me.display_name ?? me.name}
            signatureName={me.name}
          />
        )}
      </section>

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
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

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
          Notifications
        </h2>
        <p className="mb-4 mt-1 text-sm text-gray-600">
          Email sent to you when a ticket is assigned, and for the reminders
          and chasers that follow it.
        </p>
        <NotificationToggle
          enabled={me?.notifications_enabled !== false}
          watchNewTickets={me?.watch_new_tickets === true}
        />
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
            Routing rules
          </h2>
          <p className="mb-4 mt-1 text-sm text-gray-600">
            Assign, tag, prioritise or auto-reply automatically as tickets
            arrive. Every rule can be tested against recent tickets before it
            goes live, and every firing is recorded on the ticket.
          </p>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-gray-500">
              {liveRuleCount === null
                ? "Run 0011_rules.sql to enable routing."
                : `${liveRuleCount} rule${liveRuleCount === 1 ? "" : "s"} live`}
            </span>
            <Link
              href="/settings/rules"
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              Manage rules
            </Link>
          </div>
        </section>
      )}

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-bold uppercase tracking-wide text-gray-500">
          Ignored senders
        </h2>
        <p className="mb-4 mt-1 text-sm text-gray-600">
          Mail from these never creates a ticket. Add them from the ticket they
          wrote — &ldquo;Never ticket this sender again&rdquo; under the
          customer. Removing one takes effect on the next sync.
        </p>
        <IgnoredSenderList entries={ignored.entries} error={ignored.error} />
      </section>

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
          <p className="mb-3 mt-1 text-sm text-gray-600">
            The shared inbox that incoming customer email is pulled from.
            Connect it once, as an admin.
          </p>
          <div className="mb-4 rounded-md border border-info-border bg-info-bg px-3 py-2 text-sm text-info-text">
            Sign in as{" "}
            <span className="font-mono text-mono font-semibold">
              {supportAddress}
            </span>{" "}
            — not your own account. This is the address SUPPORT_EMAIL points
            at, and it&apos;s the only mailbox inbound email is read from.
            Connecting a different account is refused unless you confirm it.
          </div>
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
                Connect {supportAddress}
              </a>
            </div>
          )}

          <div className="mt-4 border-t border-gray-200 pt-4">
            <CheckMailNow connected={Boolean(supportInbox)} />
          </div>
        </section>
      )}
    </div>
  );
}
