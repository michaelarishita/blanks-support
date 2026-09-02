import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { corsHeaders, isOriginAllowed } from "@/lib/cors";
import { runRulesSafely } from "@/lib/rules/engine";
import { notifyNewTicketSafely } from "@/lib/notifications/new-ticket";
import { assessTicketRisk } from "@/lib/risk/assess";
import { createRateLimiter } from "@/lib/rate-limit";
import { claimUploads, discardTempUploads } from "@/lib/uploads/claim";
import { linkGrantToAttachment, resolveGrant } from "@/lib/uploads/ledger";
import type { AcceptedFile } from "@/lib/uploads/validate";

// ------------------------------------------------------------
// Public intake endpoint for the website support widget.
//
//   { name, email, topic, subject?, message, order_number?, website?,
//     attachments?: string[] }
// `website` is a honeypot field — real users never fill it.
//
// JSON ONLY, and deliberately so. This used to accept multipart/form-data
// with the files inline, which could never work in production: a Vercel
// serverless function rejects request bodies over 4.5MB at the platform
// level, before any of this executes. Three iPhone photos exceed that, so the
// upload was refused by infrastructure and we mapped the resulting 413 to our
// own "too large" copy — blaming the customer for a limit they had no way to
// see and we had no way to raise.
//
// Files now go from the browser straight to Supabase Storage. `attachments`
// carries signed grants naming what was uploaded; the bytes never come near
// this function. See /api/tickets/intake/upload-url and lib/uploads/claim.ts.
// ------------------------------------------------------------

/** Submissions per address per minute. Unchanged. */
const submissionLimiter = createRateLimiter(5, 60_000);

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const CORS_HEADERS = corsHeaders(origin);

  if (!isOriginAllowed(origin)) {
    return NextResponse.json(
      { error: "Origin not allowed" },
      { status: 403, headers: CORS_HEADERS }
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
  if (!submissionLimiter.check(ip)) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: CORS_HEADERS }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") body[key] = value;
  }

  // honeypot: silently accept and drop
  if (body.website) {
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  }

  const name = (body.name ?? "").trim().slice(0, 200);
  const email = (body.email ?? "").trim().toLowerCase().slice(0, 320);
  const topic = (body.topic ?? "Other").trim().slice(0, 100);
  const message = (body.message ?? "").trim().slice(0, 10_000);
  const orderNumber = (body.order_number ?? "").trim().slice(0, 50) || null;
  const subject =
    (body.subject ?? "").trim().slice(0, 200) ||
    `${topic} — ${name || email}`;

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  if (!message) {
    return NextResponse.json(
      { error: "Message is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // ---- Attachments -------------------------------------------------------
  //
  // The bytes were uploaded straight to storage; what arrives here is a list
  // of signed grants. Claiming them downloads what was actually stored and
  // puts it through exactly the checks the inline path used to run — size,
  // content sniffing, EXIF stripping, fail-closed — plus two the old path
  // never needed: the grant proves we minted that path, and the object's
  // presence proves the grant is unspent.
  //
  // All of it happens BEFORE anything is written. A rejected file must not
  // leave a ticket behind, or a customer who fixes their photo and resubmits
  // ends up with two tickets and an agent has to merge them.
  const { result: claimed, paths: tempPaths } = await claimUploads(
    payload.attachments
  );

  if (!claimed.ok) {
    // The temp objects go regardless: the customer is re-picking, and a
    // public endpoint that keeps rejected uploads is free storage.
    await discardTempUploads(tempPaths);
    // Logged with the real reasons; the customer gets the actionable
    // sentence. A public endpoint should not narrate which parser rejected
    // what to whoever is probing it.
    console.warn(
      `[intake] rejected upload from ${ip}:`,
      claimed.rejections.map((r) => `${r.name}: ${r.reason}`).join("; ")
    );
    return NextResponse.json(
      { error: claimed.message },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const attachments: AcceptedFile[] = claimed.files;

  const supabase = createAdminClient();

  // upsert customer by email
  const { data: existing } = await supabase
    .from("customers")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  let customerId = existing?.id;
  if (!customerId) {
    const { data: created, error: custErr } = await supabase
      .from("customers")
      .insert({ email, name: name || null })
      .select("id")
      .single();
    if (custErr) {
      // Public endpoint: the caller gets a generic message (never leak schema
      // detail to the internet), but the real cause is logged so a failure
      // here is diagnosable without reproducing it.
      console.error("[intake] customer insert failed:", custErr);
      return NextResponse.json(
        { error: "Could not create customer" },
        { status: 500, headers: CORS_HEADERS }
      );
    }
    customerId = created.id;
  } else if (name) {
    await supabase.from("customers").update({ name }).eq("id", customerId);
  }

  // create ticket
  const { data: ticket, error: ticketErr } = await supabase
    .from("tickets")
    .insert({
      customer_id: customerId,
      channel: "web_form",
      topic,
      subject,
      order_number: orderNumber,
      status: "new",
    })
    .select("id, number")
    .single();

  if (ticketErr || !ticket) {
    console.error("[intake] ticket insert failed:", ticketErr);
    return NextResponse.json(
      { error: "Could not create ticket" },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  // first message
  const { data: firstMessage, error: messageErr } = await supabase
    .from("messages")
    .insert({
      ticket_id: ticket.id,
      direction: "inbound",
      type: "public",
      body_text: message,
    })
    .select("id")
    .single();

  if (messageErr || !firstMessage) {
    console.error("[intake] message insert failed:", messageErr);
    return NextResponse.json(
      { error: "Could not create ticket" },
      { status: 500, headers: CORS_HEADERS }
    );
  }

  // Written to their final home under the ticket, as the STRIPPED bytes —
  // the object the customer uploaded still has its EXIF, which is why the
  // temp copy is deleted rather than moved.
  const storedAttachments = await storeAttachments(
    ticket.id,
    firstMessage.id,
    attachments
  );
  await discardTempUploads(tempPaths);

  /**
   * A file we verified and then failed to store is OUR failure, and the
   * customer has already been told their message was received.
   *
   * So the ticket says so. Appended to the body rather than left in a log,
   * for the same reason the widget appends its own note: an agent answering
   * "the tub arrived smashed" needs to know a photo of it was meant to be
   * here. A log line nobody reads is indistinguishable from silence.
   */
  if (storedAttachments.failed.length) {
    const names = storedAttachments.failed.join(", ");
    console.error(`[intake] ${storedAttachments.failed.length} attachment(s) lost after ticket creation: ${names}`);
    await supabase
      .from("messages")
      .update({
        body_text:
          `${message}\n\n---\n[${storedAttachments.failed.length} ` +
          `${storedAttachments.failed.length === 1 ? "attachment" : "attachments"} (${names}) ` +
          `could not be saved — a fault on our side. Ask the customer to resend.]`,
      })
      .eq("id", firstMessage.id);
  }

  // auto-apply the topic tag
  const { data: tag } = await supabase
    .from("tags")
    .select("id")
    .eq("name", topic)
    .maybeSingle();
  if (tag) {
    await supabase
      .from("ticket_tags")
      .insert({ ticket_id: ticket.id, tag_id: tag.id });
  }

  await supabase.from("ticket_events").insert({
    ticket_id: ticket.id,
    event_type: "created",
    detail: {
      via: "web_form",
      ip,
      attachments: storedAttachments.stored,
      attachments_lost: storedAttachments.failed.length || undefined,
    },
  });

  // Routing runs inline, after the ticket is safely stored. It is deliberately
  // not fire-and-forget: on serverless, work started after the response is
  // killed with the invocation, so "assign Harvey and email him immediately"
  // would become "sometimes". runRulesSafely never throws, so a broken rule
  // cannot turn a received message into a 500 for the customer.
  await runRulesSafely(ticket.id, "ticket_created");

  // AFTER the rules, always. If a rule assigned this ticket, that agent is
  // already recorded in `notifications` and gets excluded — otherwise they
  // receive two emails about one ticket in the same minute, which is how
  // people learn to ignore both.
  await notifyNewTicketSafely(ticket.id);

  // Advisory only, and last: it reads the attachments and the customer
  // history, so it has to run after both exist. Nothing downstream acts on
  // the result — it puts a sentence in front of a human.
  await assessTicketRisk(ticket.id);

  return NextResponse.json(
    { ok: true, ticket_number: ticket.number, attachments: storedAttachments.stored },
    { headers: CORS_HEADERS }
  );
}

/**
 * Uploads the already-validated bytes and records them.
 *
 * Runs AFTER the ticket exists, because the storage path is scoped by ticket
 * and message. A failure here still does not fail the request — the
 * customer's message is saved, and losing the whole ticket because one photo
 * did not upload is the worse outcome.
 *
 * But it is no longer SILENT, which it was: it logged, continued, and let the
 * response report success. That is the same shape as the widget dropping a
 * failed upload — a photo the customer believes they sent, a ticket that does
 * not mention it, and an agent with no idea to ask. The bytes are already
 * verified by this point, so a failure here is ours, not theirs.
 *
 * Returns what was stored AND what was lost, so the caller can say so in the
 * ticket rather than only in a log nobody reads.
 */
async function storeAttachments(
  ticketId: string,
  messageId: string,
  files: AcceptedFile[]
): Promise<{ stored: number; failed: string[] }> {
  if (!files.length) return { stored: 0, failed: [] };
  const supabase = createAdminClient();
  let stored = 0;
  const failed: string[] = [];

  for (const [index, file] of files.entries()) {
    // Index-prefixed so two photos named IMG_0001.jpg don't overwrite each
    // other — `upsert` is off, but a collision would fail the second one.
    const path = `${ticketId}/${messageId}/${index}-${file.filename}`;

    const { error: uploadError } = await supabase.storage
      .from("attachments")
      .upload(path, file.bytes, { contentType: file.kind, upsert: false });
    if (uploadError) {
      console.error(`[intake] attachment upload failed (${path}):`, uploadError);
      failed.push(file.filename);
      await resolveGrant(file.sourcePath ?? path, "rejected", `storage upload failed: ${uploadError.message}`);
      continue;
    }

    const { data: inserted, error: rowError } = await supabase.from("attachments").insert({
      message_id: messageId,
      filename: file.filename,
      mime_type: file.kind,
      size_bytes: file.bytes.length,
      storage_path: path,
    }).select("id").single();
    if (rowError) {
      console.error(`[intake] attachment row failed (${path}):`, rowError);
      failed.push(file.filename);
      // The object is now unreferenced. Removed rather than left for the
      // folder sweep, which only collects folders whose TICKET is gone — this
      // ticket exists, so nothing would ever have tidied this up.
      await supabase.storage.from("attachments").remove([path]);
      await resolveGrant(file.sourcePath ?? path, "rejected", `row insert failed: ${rowError.message}`);
      continue;
    }

    if (file.sourcePath) {
      await resolveGrant(file.sourcePath, "stored");
      if (inserted?.id) await linkGrantToAttachment(file.sourcePath, inserted.id as string);
    }
    stored++;
  }

  return { stored, failed };
}
