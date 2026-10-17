import {
  checkInstagramAccount,
  lastEventFor,
  type MetaHealth,
} from "@/lib/meta/health";
import { Diagnosis, Row } from "@/components/MessengerStatus";

/**
 * Is Instagram connected, and is anything arriving?
 *
 * Mirrors the Messenger panel — same rows, same vocabulary — because Instagram
 * DMs ride the same Page, token and webhook endpoint; only three things differ
 * and they are exactly what this surfaces:
 *
 *   - the `messages` field has to be subscribed on the Page (shared with
 *     Messenger, but Instagram has no separate message_echoes — echoes come
 *     through `messages` — so the Instagram verdict looks for `messages` alone
 *     rather than the combined Messenger requirement);
 *   - a professional Instagram account must be connected to the Page;
 *   - "last message" counts only Instagram events, not Messenger's.
 *
 * `health` is the shared snapshot the Settings page already read for Messenger;
 * this panel only adds the two Instagram-specific lookups.
 */
export default async function InstagramStatus({ health }: { health: MetaHealth }) {
  const [account, lastEvent] = await Promise.all([
    checkInstagramAccount(),
    lastEventFor("instagram"),
  ]);

  // Instagram needs the `messages` field; message_echoes is Messenger-only, so
  // the combined subscription verdict can read "broken" for a reason that does
  // not affect Instagram. Judge Instagram on its own field.
  const sub = health.subscription;
  const messagesSubscribed = sub.fields.includes("messages");
  const subState =
    sub.state === "unknown" ? "unknown" : messagesSubscribed ? "ok" : "broken";
  const subDetail =
    sub.state === "unknown"
      ? sub.detail
      : messagesSubscribed
        ? "the Page is subscribed to `messages`"
        : "the Page is not subscribed to `messages` — inbound Instagram is off";

  // Instagram is "live" for the purpose of the waiting copy only when both the
  // subscription and the connected account are good.
  const wired = subState === "ok" && account.state === "ok";

  return (
    <div className="text-sm text-gray-600">
      <Row label="Instagram account" state={account.state} detail={account.detail} />
      <Row label="Page subscription" state={subState} detail={subDetail} />

      {account.diagnosis && <Diagnosis d={account.diagnosis} />}

      {lastEvent.error ? (
        <p className="mt-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-caption text-warning-text">
          <span className="font-semibold">Couldn&apos;t read the webhook log.</span>{" "}
          {lastEvent.error}
        </p>
      ) : (
        <Row
          label="Last Instagram message"
          state={lastEvent.at ? "ok" : "unknown"}
          detail={
            lastEvent.at
              ? new Date(lastEvent.at).toLocaleString()
              : wired
                ? "waiting for the first message"
                : "nothing yet — normal until Instagram is connected and the Page subscribed"
          }
        />
      )}
    </div>
  );
}
