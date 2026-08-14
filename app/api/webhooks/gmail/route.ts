import { NextResponse, type NextRequest } from "next/server";
import { syncSupportMailbox } from "@/lib/google/inbound";

// Pub/Sub push endpoint (production) and manual poll trigger (development).
//
// Gmail's notification carries only "something changed in this mailbox" — no
// message content — so both triggers do the same thing: run an incremental
// sync from the stored history cursor.

export const dynamic = "force-dynamic";

/**
 * Pub/Sub retries on any non-2xx, and a retry storm against a broken sync is
 * worse than a dropped notification: the next notification (or the poll)
 * picks up anything missed, because the cursor only advances on success.
 * So failures are logged and acknowledged.
 */
function acknowledge(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

function authorized(request: NextRequest): boolean {
  const expected = process.env.GMAIL_WEBHOOK_TOKEN;
  // Unset in local development, where the endpoint is only reachable on
  // localhost. It must be set in production — see the deploy checklist.
  if (!expected) return true;

  const token =
    request.nextUrl.searchParams.get("token") ??
    request.headers.get("x-webhook-token");
  return token === expected;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The Pub/Sub envelope is read only for logging — the sync is driven by our
  // own stored cursor, not by anything in the notification.
  let emailAddress: string | null = null;
  try {
    const body = await request.json();
    const encoded = body?.message?.data;
    if (typeof encoded === "string") {
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      emailAddress = decoded?.emailAddress ?? null;
    }
  } catch {
    // Manual triggers post no body at all; that's fine.
  }

  try {
    const result = await syncSupportMailbox();
    if (result.error) {
      console.error("[gmail webhook] sync error:", result.error);
    } else {
      console.log(
        `[gmail webhook] ${emailAddress ?? "manual"} — checked ${result.checked}, created ${result.created}, appended ${result.appended}`
      );
    }
    return acknowledge({ ok: true, ...result });
  } catch (e) {
    console.error("[gmail webhook] unhandled:", e);
    // Still a 200 so Pub/Sub doesn't retry-storm, but the body carries the
    // real reason — this endpoint is also the manual dev trigger, and
    // "sync failed" told whoever hit it nothing.
    return acknowledge({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Convenience trigger for local development: visit the URL to poll. */
export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await syncSupportMailbox();
  return NextResponse.json(result, { status: result.error ? 400 : 200 });
}
