import { readInboundHealth } from "@/lib/monitoring";
import { AlertTriangleIcon } from "@/components/ui/icons";

/**
 * The visible half of the inbound heartbeat. The cron emails the owner, but
 * an alert sitting in one inbox is easy to miss — this puts the same warning
 * in front of whoever is actually working the queue.
 *
 * Deliberately not dismissible: inbound email being down is not a
 * notification, it's a broken product.
 */
export default async function HealthBanner() {
  const health = await readInboundHealth();
  if (health.status !== "degraded" || !health.reasons.length) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 border-b border-danger-border bg-danger-bg px-5 py-2.5"
    >
      <span className="mt-0.5 flex-none text-danger-text">
        <AlertTriangleIcon size={15} />
      </span>
      <div className="min-w-0 flex-1 text-caption text-danger-text">
        <span className="font-semibold">Inbound email may be down.</span>{" "}
        {health.reasons.join(" ")}{" "}
        <span className="opacity-80">
          Check Settings → Support mailbox, then the Pub/Sub subscription.
        </span>
      </div>
      {health.checkedAt && (
        <span className="flex-none text-caption text-danger-text opacity-70">
          checked {new Date(health.checkedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      )}
    </div>
  );
}
