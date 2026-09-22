import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { hasPersonalInbox } from "@/lib/personal-triage/gmail";
import { scoreAgainstCorrections } from "@/lib/personal-triage/harness";
import QueryError from "@/components/QueryError";
import PersonalTriage, {
  type TriageRow,
} from "@/components/PersonalTriage";

// The PRIVATE personal-inbox triage view (Phase A, Prompt 33).
//
// "Me only": admin-gated here, and the data is owner-scoped by RLS. Messages
// are read with the AGENT client on purpose — that is what proves the owner-only
// policy is doing the work; the service-role client would bypass it.
export const dynamic = "force-dynamic";

export default async function TriagePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("agents")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/inbox");

  const configured = Boolean(process.env.GOOGLE_CLIENT_ID);

  let connectedAs: string | null = null;
  let connectError: string | null = null;
  try {
    connectedAs = await hasPersonalInbox(user.id);
  } catch (e) {
    connectError = e instanceof Error ? e.message : "Could not read the connection.";
  }

  if (connectError) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <QueryError
          title="Couldn’t check your personal-inbox connection"
          reason={connectError}
        />
      </div>
    );
  }

  if (!connectedAs) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4">
        <header>
          <h1 className="text-lg font-semibold text-gray-900">Personal triage</h1>
          <p className="mt-1 text-sm text-gray-600">
            A private, read-only view over your own Gmail inbox. It lists recent
            mail and flags what likely needs your attention. Nothing is deleted,
            archived, or changed in Gmail — and this space is visible only to you.
          </p>
        </header>
        {configured ? (
          <a
            href="/api/google/connect?mode=personal"
            className="inline-block rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Connect your inbox (read-only)
          </a>
        ) : (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Google OAuth isn’t configured — set <code>GOOGLE_CLIENT_ID</code> and{" "}
            <code>GOOGLE_CLIENT_SECRET</code>.
          </p>
        )}
        <p className="text-xs text-gray-400">
          This grant is separate from your send connection. Connecting or
          disconnecting it never affects your ability to reply to tickets.
        </p>
      </div>
    );
  }

  // Owner-only RLS enforces the privacy: this returns ONLY this agent's rows.
  const { data: rows, error } = await supabase
    .from("personal_messages")
    .select(
      "gmail_message_id, from_email, from_name, subject, message_date, snippet, classification, classifier_reason"
    )
    .order("message_date", { ascending: false });

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-4">
        <QueryError
          title="Couldn’t load your triaged mail"
          reason={error.message}
          note="This is a failed read, not an empty inbox."
        />
      </div>
    );
  }

  const score = await scoreAgainstCorrections(user.id);

  return (
    <PersonalTriage
      connectedAs={connectedAs}
      messages={(rows ?? []) as TriageRow[]}
      score={{
        total: score.total,
        falsePositives: score.falsePositives,
        falseNegatives: score.falseNegatives,
        precision: score.precision,
        recall: score.recall,
        error: score.error,
      }}
    />
  );
}
