import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { corsHeaders, isOriginAllowed } from "@/lib/cors";
import { runRulesSafely } from "@/lib/rules/engine";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  validateUploads,
  type AcceptedFile,
} from "@/lib/uploads/validate";

// ------------------------------------------------------------
// Public intake endpoint for the website support widget.
//
// Accepts JSON, or multipart/form-data when the customer attaches files:
//   { name, email, topic, subject?, message, order_number?, website? }
// `website` is a honeypot field — real users never fill it.
// ------------------------------------------------------------

/** Submissions per address per minute. Unchanged. */
const submissionLimiter = createRateLimiter(5, 60_000);

/**
 * A second, much tighter budget for submissions that CARRY FILES.
 *
 * An unauthenticated endpoint that accepts bytes and stores them is the most
 * abusable thing we run, and it is abusable at a different scale from the text
 * form: five text posts a minute is noise, five 10MB posts a minute is 50MB of
 * someone else's storage bill per minute per address.
 */
const uploadLimiter = createRateLimiter(3, 10 * 60_000);

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

interface ParsedSubmission {
  fields: Record<string, string>;
  files: { name: string; bytes: Uint8Array }[];
}

/** Reads either shape into one. */
async function parseSubmission(request: Request): Promise<ParsedSubmission | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(body ?? {})) {
        if (typeof value === "string") fields[key] = value;
      }
      return { fields, files: [] };
    } catch {
      return null;
    }
  }

  try {
    const form = await request.formData();
    const fields: Record<string, string> = {};
    const files: { name: string; bytes: Uint8Array }[] = [];

    for (const [key, value] of form.entries()) {
      if (typeof value === "string") {
        fields[key] = value;
        continue;
      }
      // Read the file eagerly but bail on anything oversized before doing so,
      // rather than pulling 500MB into memory to then reject it.
      if (value.size > MAX_FILE_BYTES) {
        files.push({ name: value.name, bytes: new Uint8Array(MAX_FILE_BYTES + 1) });
        continue;
      }
      files.push({
        name: value.name,
        bytes: new Uint8Array(await value.arrayBuffer()),
      });
      // Hard stop so a caller can't make us read a hundred files before the
      // count check runs.
      if (files.length > MAX_FILES) break;
    }

    return { fields, files };
  } catch {
    return null;
  }
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

  const submission = await parseSubmission(request);
  if (!submission) {
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers: CORS_HEADERS }
    );
  }
  const body = submission.fields;

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
  // Validated and stripped BEFORE anything is written. A rejected file must
  // not leave a ticket behind, or a customer who fixes their photo and
  // resubmits ends up with two tickets and an agent has to merge them.
  let attachments: AcceptedFile[] = [];
  if (submission.files.length) {
    if (!uploadLimiter.check(ip)) {
      console.warn(`[intake] upload rate limit hit from ${ip}`);
      return NextResponse.json(
        { error: "Too many uploads from this connection. Please try again shortly." },
        { status: 429, headers: CORS_HEADERS }
      );
    }

    const validated = validateUploads(submission.files);
    if (!validated.ok) {
      // Logged with the real reasons; the customer gets the actionable
      // sentence. A public endpoint should not narrate which parser rejected
      // what to whoever is probing it.
      console.warn(
        `[intake] rejected upload from ${ip}:`,
        validated.rejections.map((r) => `${r.name}: ${r.reason}`).join("; ")
      );
      return NextResponse.json(
        { error: validated.message },
        { status: 400, headers: CORS_HEADERS }
      );
    }
    attachments = validated.files;
  }

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

  const storedAttachments = await storeAttachments(
    ticket.id,
    firstMessage.id,
    attachments
  );

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
