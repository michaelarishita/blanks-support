import { readMetaHealth, SIGNATURE_FAILURE_THRESHOLD } from "@/lib/meta/health";
import type { GraphDiagnosis } from "@/lib/meta/graph-errors";

/**
 * Is Messenger connected, and is anything stuck?
 *
 * Four facts, because four things fail separately here — and because the one
 * that matters most (Meta silently unsubscribing the app after an hour of
 * failed deliveries) has no other signal anywhere in the product.
 */
export default async function MessengerStatus() {
  const health = await readMetaHealth();

  return (
    <div className="text-sm text-gray-600">
      <Row
        label="Page subscription"
        state={health.subscription.state}
        detail={health.subscription.detail}
      />
      <Row label="Page token" state={health.token.state} detail={health.token.detail} />

      {/* One block, not two. Both rows fail from the same cause whenever the
          cause is the app rather than the Page — printing the same paragraph
          twice would read as two problems. */}
      {(health.subscription.diagnosis ?? health.token.diagnosis) && (
        <Diagnosis
          d={(health.subscription.diagnosis ?? health.token.diagnosis)!}
        />
      )}

      {health.events.error ? (
        // A failed read is not "no events". Saying "0 signature failures"
        // because the query broke is the reassuring reading, and this codebase
        // has been bitten by exactly that.
        <p className="mt-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-caption text-warning-text">
          <span className="font-semibold">
            Couldn&apos;t read the webhook log.
          </span>{" "}
          {health.events.error}
        </p>
      ) : (
        <>
          <Row
            label="Last event received"
            state={health.events.lastReceivedAt ? "ok" : "unknown"}
            detail={
              health.events.lastReceivedAt
                ? new Date(health.events.lastReceivedAt).toLocaleString()
                : "nothing yet — normal until the Page is subscribed"
            }
          />
          <Row
            label="Waiting to process"
            state={health.events.stuck > 0 ? "broken" : "ok"}
            detail={
              health.events.stuck > 0
                ? `${health.events.unprocessed} queued, ${health.events.stuck} given up on`
                : `${health.events.unprocessed} queued`
            }
          />
          <Row
            label="Signature failures (24h)"
            state={
              health.events.signatureFailures24h >= SIGNATURE_FAILURE_THRESHOLD
                ? "broken"
                : "ok"
            }
            detail={
              health.events.signatureFailures24h === 0
                ? "none"
                : `${health.events.signatureFailures24h} — check META_APP_SECRET before assuming an attack`
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * The cause, named, with the codes printed.
 *
 * "API access blocked" is Meta's message and it is a verdict with the
 * evidence thrown away — no code, no subcode, no trace id, and no way to tell
 * an app-level block from an expired token. Every one of those needs a
 * different person to do a different thing.
 */
function Diagnosis({ d }: { d: GraphDiagnosis }) {
  const tone =
    d.kind === "rate_limited" || d.kind === "unreachable"
      ? "border-warning-border bg-warning-bg text-warning-text"
      : "border-danger-border bg-danger-bg text-danger-text";
  return (
    <div className={`mt-2 rounded-md border px-3 py-2 text-caption ${tone}`}>
      <p className="font-semibold">{d.summary}</p>
      {d.action && <p className="mt-1 opacity-90">{d.action}</p>}
      {/* Always shown, even when the summary is confident. The trace id is
          what Meta support asks for, and the code is what a search needs. */}
      <p className="mt-1 font-mono text-mono opacity-70">{d.evidence}</p>
    </div>
  );
}

function Row({
  label,
  state,
  detail,
}: {
  label: string;
  /** `unknown` is its own colour on purpose: it is not a failure. */
  state: "ok" | "broken" | "unknown";
  detail: string;
}) {
  const dot =
    state === "ok" ? "bg-emerald-500" : state === "broken" ? "bg-danger-text" : "bg-gray-300";
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className={`mt-1.5 inline-block h-2 w-2 flex-none rounded-full ${dot}`} />
      <span className="flex-none text-gray-700">{label}</span>
      <span className="min-w-0 flex-1 truncate text-caption text-gray-500" title={detail}>
        {detail}
      </span>
    </div>
  );
}
