import { readOpenAlerts } from "@/lib/alerts";
import { readInboundHealth } from "@/lib/monitoring";
import AcknowledgeAlert from "@/components/AcknowledgeAlert";
import { AlertTriangleIcon } from "@/components/ui/icons";

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
 */
export default async function SystemAlertBanner() {
  const { alerts, error } = await readOpenAlerts();

  if (error) {
    // A failed read of the alert table is itself an alert-shaped event. It is
    // NOT rendered as "no alerts" — that is exactly the silence this feature
    // exists to end.
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

  const health = await readInboundHealth();

  return (
    <div className="border-b border-danger-border bg-danger-bg">
      {alerts.map((alert) => (
        <div key={alert.id} role="alert" className="flex items-start gap-2.5 px-5 py-3">
          <span className="mt-0.5 flex-none text-danger-text">
            <AlertTriangleIcon size={16} />
          </span>
          <div className="min-w-0 flex-1 text-caption text-danger-text">
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
          </div>
          <AcknowledgeAlert alertId={alert.id} />
        </div>
      ))}
    </div>
  );
}
