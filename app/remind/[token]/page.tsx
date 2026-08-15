import { createAdminClient } from "@/lib/supabase/admin";
import {
  describeDelay,
  verifyReminderToken,
} from "@/lib/notifications/reminder-token";
import ReminderConfirm from "@/components/ReminderConfirm";

export const dynamic = "force-dynamic";

/**
 * Confirmation page for a "remind me later" link.
 *
 * No session required — the signature is the authorisation, because the
 * recipient may be reading the email on a device that isn't signed in. That
 * is also why this page shows the ticket NUMBER and nothing else: a link that
 * leaks out must not leak the conversation with it.
 *
 * Rendering this page has NO side effects. Scanners and mail clients prefetch
 * links on delivery, so the scheduling lives behind an explicit POST.
 */
export default async function RemindPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = verifyReminderToken(token);

  if (!result.ok) {
    return (
      <Shell>
        <h1 className="text-title font-semibold text-primary">
          This link has expired
        </h1>
        <p className="mt-2 text-body text-secondary">
          {result.reason === "expired"
            ? "Reminder links are valid for 24 hours. Open the ticket to set a new one."
            : "That reminder link isn't valid."}
        </p>
      </Shell>
    );
  }

  // Number only. Never the subject, the customer, or the conversation.
  const admin = createAdminClient();
  const { data: ticket } = await admin
    .from("tickets")
    .select("number")
    .eq("id", result.payload.t)
    .maybeSingle();

  return (
    <Shell>
      <ReminderConfirm
        token={token}
        ticketNumber={(ticket?.number as number | undefined) ?? null}
        delayLabel={describeDelay(result.payload.d)}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-md rounded-lg bg-panel p-6 shadow-sm">
        <div className="mb-4 text-[10px] font-bold uppercase tracking-[0.14em] text-brand-600">
          Blanks Support
        </div>
        {children}
      </div>
    </div>
  );
}
