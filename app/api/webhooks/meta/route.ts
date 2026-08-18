import { NextResponse, type NextRequest } from "next/server";
import { verifyMetaSignature } from "@/lib/meta/signature";
import { normalizeWebhook } from "@/lib/meta/events";
import { processMetaEvents } from "@/lib/meta/inbound";

// ------------------------------------------------------------
// One endpoint for both Instagram DMs and Facebook Messenger.
//
// GET  — Meta's subscription handshake.
// POST — events, signed with the app secret.
// ------------------------------------------------------------

export const dynamic = "force-dynamic";

/**
 * The handshake.
 *
 * Meta calls this once when the subscription is saved and expects the
 * challenge echoed back as PLAIN TEXT. Returning JSON — even the right value
 * wrapped in quotes — fails verification with no useful error, which is a
 * genuinely annoying twenty minutes if you don't know.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    console.error("[meta] META_VERIFY_TOKEN is not set — refusing the handshake");
    return new NextResponse("Not configured", { status: 500 });
  }

  if (mode !== "subscribe" || token !== expected || !challenge) {
    console.warn(`[meta] handshake refused (mode=${mode}, token match=${token === expected})`);
    return new NextResponse("Forbidden", { status: 403 });
  }

  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: NextRequest) {
  // RAW body first, and parsed only after the signature checks out.
  //
  // This ordering is the entire security of the endpoint. Parsing first and
  // re-serialising to verify produces different bytes — key order, spacing,
  // unicode escaping — so every check fails, and the natural conclusion is
  // that signature verification "doesn't work" and gets removed. At which
  // point anyone who learns the URL can post tickets into the inbox.
  let raw: string;
  try {
    raw = await request.text();
  } catch (e) {
    console.error("[meta] could not read the request body:", e);
    return new NextResponse("Bad Request", { status: 400 });
  }

  const signature = verifyMetaSignature(
    raw,
    request.headers.get("x-hub-signature-256"),
    process.env.META_APP_SECRET
  );

  if (!signature.ok) {
    // 403, not 200. Meta's retry behaviour is a reason to acknowledge events
    // we understand and cannot process — it is not a reason to accept
    // unsigned ones, and a caller who cannot sign is not Meta.
    console.warn(`[meta] rejected an event: signature ${signature.reason}`);
    return new NextResponse("Forbidden", { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Signed but unparseable. Acknowledged, because retrying will not help.
    console.error("[meta] signed body was not JSON");
    return NextResponse.json({ ok: true, skipped: "unparseable" });
  }

  const events = normalizeWebhook(payload);

  // Processed inline, then acknowledged. Meta's own guidance is to answer
  // fast, and the work here is a handful of small queries — but nothing in
  // it is allowed to throw, so the 200 is never at risk.
  let result;
  try {
    result = await processMetaEvents(events);
  } catch (e) {
    // processMetaEvents already swallows per-event failures; this is the
    // belt for anything outside the loop. A non-200 would earn a retry storm
    // and, if it persists, a disabled subscription.
    console.error("[meta] processing failed wholesale:", e);
    return NextResponse.json({ ok: true, error: "processing failed" });
  }

  console.info(
    `[meta] ${result.received} event(s) — created ${result.created}, appended ${result.appended}` +
      (Object.keys(result.skipped).length
        ? `, skipped ${JSON.stringify(result.skipped)}`
        : "")
  );

  return NextResponse.json({ ok: true, ...result });
}
