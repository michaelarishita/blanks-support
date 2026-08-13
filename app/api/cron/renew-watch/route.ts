import type { NextRequest } from "next/server";
import { cronUnauthorized, isCronAuthorized } from "@/lib/cron-auth";
import { watchGmailMailbox } from "@/lib/google/gmail";
import {
  getAccessToken,
  getSupportInboxConnection,
  setLastHistoryId,
  setWatchExpiry,
} from "@/lib/google/tokens";

// Daily. The Gmail watch expires after 7 days; renewing daily means six
// consecutive failures are needed before inbound actually stops, rather than
// one badly-timed outage.

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isCronAuthorized(request)) return cronUnauthorized();

  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) {
    return Response.json(
      { error: "GMAIL_PUBSUB_TOPIC is not set — see the deploy checklist." },
      { status: 400 }
    );
  }

  const connection = await getSupportInboxConnection();
  if (!connection) {
    return Response.json({ error: "No support mailbox connected." }, { status: 400 });
  }

  try {
    const accessToken = await getAccessToken(connection.id);
    const watch = await watchGmailMailbox(accessToken, topic);

    // expiration comes back as epoch milliseconds in a string.
    const expiresAt = new Date(Number(watch.expiration)).toISOString();
    await setWatchExpiry(connection.id, expiresAt);

    // Only move the cursor forward if we don't have one yet. Overwriting a
    // live cursor with the watch's historyId would skip anything that
    // arrived between the last sync and this renewal.
    if (!connection.last_history_id) {
      await setLastHistoryId(connection.id, watch.historyId);
    }

    return Response.json({
      ok: true,
      mailbox: connection.account_ref,
      expiresAt,
      historyId: watch.historyId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cron renew-watch]", message);
    return Response.json(
      {
        error:
          message === "GMAIL_RECONNECT_REQUIRED"
            ? "Support mailbox access expired — reconnect it in Settings."
            : message,
      },
      { status: 500 }
    );
  }
}
