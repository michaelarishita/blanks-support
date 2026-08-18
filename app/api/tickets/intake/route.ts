import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { corsHeaders, isOriginAllowed } from "@/lib/cors";
import { runRulesSafely } from "@/lib/rules/engine";
import { createRateLimiter } from "@/lib/rate-limit";
import { claimUploads, discardTempUploads } from "@/lib/uploads/claim";
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
      attachments: storedAttachments,
    },
  });

  // Routing runs inline, after the ticket is safely stored. It is deliberately
  // not fire-and-forget: on serverless, work started after the response is
  // killed with the invocation, so "assign Harvey and email him immediately"
  // would become "sometimes". runRulesSafely never throws, so a broken rule
  // cannot turn a received message into a 500 for the customer.
  await runRulesSafely(ticket.id, "ticket_created");

  return NextResponse.json(
    { ok: true, ticket_number: ticket.number, attachments: storedAttachments },
    { headers: CORS_HEADERS }
  );
}

/**
 * Uploads the already-validated bytes and records them.
 *
 * Runs AFTER the ticket exists, because the storage path is scoped by ticket
 * and message. A failure here is logged and counted but does not fail the
 * request: the customer's message is already saved, and losing the whole
 * ticket because one photo didn't upload is the worse outcome.
 */
async function storeAttachments(
  ticketId: string,
  messageId: string,
  files: AcceptedFile[]
): Promise<number> {
  if (!files.length) return 0;
  const supabase = createAdminClient();
  let stored = 0;

  for (const [index, file] of files.entries()) {
    // Index-prefixed so two photos named IMG_0001.jpg don't overwrite each
    // other — `upsert` is off, but a collision would fail the second one.
    const path = `${ticketId}/${messageId}/${index}-${file.filename}`;

    const { error: uploadError } = await supabase.storage
      .from("attachments")
      .upload(path, file.bytes, { contentType: file.kind, upsert: false });
    if (uploadError) {
      console.error(`[intake] attachment upload failed (${path}):`, uploadError);
      continue;
    }

    const { error: rowError } = await supabase.from("attachments").insert({
      message_id: messageId,
      filename: file.filename,
      mime_type: file.kind,
      size_bytes: file.bytes.length,
      storage_path: path,
    });
    if (rowError) {
      console.error(`[intake] attachment row failed (${path}):`, rowError);
      continue;
    }

    stored++;
  }

  return stored;
}
