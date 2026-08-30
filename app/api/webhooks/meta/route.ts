import { NextResponse, after, type NextRequest } from "next/server";
import { verifyMetaSignature } from "@/lib/meta/signature";
import { drainWebhookEvents, recordWebhookEvent } from "@/lib/meta/queue";

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
    /**
     * THE EMOJI GOTCHA — read this before assuming the secret is wrong.
     *
     * Meta documents the signature as computed over the payload in its
     * ESCAPED-UNICODE form (`\uXXXX`) with lowercase hex digits. Hashing the
     * raw UTF-8 bytes, which is what we do and what every sane library does,
     * agrees with that for any pure-ASCII payload — and disagrees for anything
     * carrying an emoji or non-Latin text.
     *
     * DM traffic is mostly emoji. So the signature that will start failing is
     * not a random one: it is every message with a 👍 in it, while the plain
     * ones keep working. That pattern looks exactly like an intermittent key
     * problem and is not one.
     *
     * `ascii` below is the field that turns that into a one-line diagnosis. If
     * failures are ALL ascii=false, this is the quirk, and the fix is to hash
     * the escaped form — not to rotate the secret and not to weaken the check.
     */
    const ascii = /^[\x00-\x7F]*$/.test(raw);
    console.warn(
      `[meta] rejected an event: signature ${signature.reason} ` +
        `(ascii=${ascii}, bytes=${Buffer.byteLength(raw, "utf8")})` +
        (ascii ? "" : " — NON-ASCII BODY: see the emoji gotcha in this file")
    );

    // Recorded even though it was refused. A run of these is either somebody
    // probing the endpoint or our own secret being wrong, and those need
    // opposite responses — a count nobody kept cannot tell them apart.
    await recordWebhookEvent({ raw, signatureOk: false }).catch(() => {});

    // 403, not 200. Meta's retry behaviour is a reason to acknowledge events
    // we understand and cannot process — it is not a reason to accept
    // unsigned ones, and a caller who cannot sign is not Meta.
    return new NextResponse("Forbidden", { status: 403 });
  }

  /**
   * ACKNOWLEDGE FIRST, PROCESS AFTER.
   *
   * Meta wants a 200 within five seconds, retries immediately on failure,
   * and unsubscribes the app after an hour of them — a silent inbound outage
   * with no signal of its own. Profile fetches and media downloads are Graph
   * API calls whose latency is not ours to control, so none of them may sit
   * between the request and the response.
   *
   * The write below is the only thing that must succeed before we answer.
   */
  const recorded = await recordWebhookEvent({ raw, signatureOk: true });

  if (recorded.error) {
    // The ONE case worth a non-200: we have not stored the event, so a retry
    // is genuinely useful and losing it silently is the worse outcome. Meta
    // will resend, and the unique index on meta_message_id makes that safe.
    console.error("[meta] refusing to acknowledge an event we did not store");
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // Runs once the response has gone. Nothing in here can delay the 200 or
  // turn it into a 500 — and if the function is killed before it finishes,
  // the row is still on the queue and the heartbeat's drain picks it up.
  after(async () => {
    try {
      const result = await drainWebhookEvents();
      console.info(
        `[meta] drained ${result.drained} event(s) — created ${result.created}, ` +
          `appended ${result.appended}, failed ${result.failed}` +
          (Object.keys(result.skipped).length
            ? `, skipped ${JSON.stringify(result.skipped)}`
            : "")
      );
    } catch (e) {
      // Belt and braces. `after` swallows throws, but a silent one here would
      // leave the queue growing with nothing said about it.
      console.error("[meta] drain failed after acknowledging:", e);
    }
  });

  return NextResponse.json({ ok: true, queued: recorded.id });
}
