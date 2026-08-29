import { readOpenAlerts, agentFacingNotice, alertResponderNames } from "@/lib/alerts";
import { readInboundHealth } from "@/lib/monitoring";
import AcknowledgeAlert from "@/components/AcknowledgeAlert";
import SystemAlertDetail from "@/components/SystemAlertDetail";
import { InfoIcon } from "@/components/ui/icons";

/**
 * The second channel, and the cheapest one that is genuinely reliable.
 *
 * Email was already being delivered; the problem was that it was buried. A
 * banner backed by a ROW fixes the specific thing email cannot do: it stays
 * until a person acts on it. There is no read state to be cleared by
 * accident, no thread to be swallowed into, and no filter to fall foul of.
 *
 * Not dismissible — only ACKNOWLEDGEABLE, which is recorded with who and
 * when. "I saw this" and "make it go away" have to be the same action, or the
 * banner becomes a thing people close reflexively.
 *
 * ADMINS ONLY, for the detail. Every alert here names something only an admin
 * can do — a Pub/Sub subscription, a migration, a mailbox reconnect — and an
 * agent shown a red block about Pub/Sub learns that banners in this app are
 * not addressed to them. That is the expensive lesson, because it is what
 * makes the NEXT banner ignorable. Agents get one calm sentence about the only
 * part that changes their work, and nothing about the mechanism.
 */
export default async function SystemAlertBanner({ isAdmin }: { isAdmin: boolean }) {
  const { alerts, error } = await readOpenAlerts();

  if (error) {
    // A failed read of the alert table is itself an alert-shaped event, and is
    // NOT rendered as "no alerts" — that is exactly the silence this feature
    // exists to end. Still admin-only: it names a migration.
    if (!isAdmin) return null;
    return (
      <div
        role="alert"
        className="border-b border-danger-border bg-danger-bg px-5 py-2.5 text-caption text-danger-text"
      >
        <span className="font-semibold">Couldn&apos;t read system alerts.</span>{" "}
        {error}{" "}
        <span className="opacity-80">
          If this mentions `system_alerts`, migration 0016 hasn&apos;t been run.
        </span>
      </div>
    );
  }

  if (!alerts.length) return null;

  if (!isAdmin) return <AgentNotice kinds={alerts.map((a) => a.kind)} />;

  const health = await readInboundHealth();

  return (
    <div className="border-b border-danger-border bg-danger-bg">
      {alerts.map((alert) => (
        <div key={alert.id} role="alert" className="flex items-start gap-2.5 px-5 py-2.5">
          <SystemAlertDetail
            summary={
              <p className="font-semibold">
                {alert.severity === "critical" && "STILL BROKEN — "}
                {alert.title}
                {alert.occurrence_count > 1 && (
                  <span className="ml-1.5 font-normal opacity-80">
                    seen {alert.occurrence_count}× since{" "}
                    {new Date(alert.first_seen_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </p>
            }
          >
            {alert.reasons.length > 0 && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 opacity-90">
                {alert.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            )}
            {alert.kind === "inbound_email_down" && (
              <p className="mt-1.5 opacity-80">
                Check Settings → Support mailbox, then the Pub/Sub subscription.
                {health.checkedAt &&
                  ` Last checked ${new Date(health.checkedAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}.`}
              </p>
            )}
          </SystemAlertDetail>
          <AcknowledgeAlert alertId={alert.id} />
        </div>
      ))}
    </div>
  );
}

/**
 * What an agent sees instead: one calm line, in plain language, about the only
 * consequence they can act on — and who is already dealing with it.
 *
 * Deliberately NOT red and not `role="alert"`. It is information, not an
 * alarm: there is nothing for the reader to do, and dressing it as an
 * emergency is how the real emergencies stop being read.
 */
async function AgentNotice({ kinds }: { kinds: string[] }) {
  const notice = agentFacingNotice(kinds);
  // Nothing here changes an agent's work — so nothing is shown. A banner with
  // no consequence for its reader is the thing being removed, not re-added in
  // a quieter colour.
  if (!notice) return null;

  const responders = await alertResponderNames();

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-subtle bg-info-bg px-5 py-1.5 text-caption text-info-text"
    >
      <span className="flex-none opacity-80">
        <InfoIcon size={14} />
      </span>
      <p className="min-w-0">
        {notice} <span className="opacity-80">{responders}.</span>
      </p>
    </div>
  );
}
