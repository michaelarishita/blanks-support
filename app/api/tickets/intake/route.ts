import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { corsHeaders, isOriginAllowed } from "@/lib/cors";
import { runRulesSafely } from "@/lib/rules/engine";

// ------------------------------------------------------------
// Public intake endpoint for the website support widget.
// POST { name, email, topic, subject?, message, order_number?, website? }
// `website` is a honeypot field — real users never fill it.
// ------------------------------------------------------------

// naive in-memory rate limit (per serverless instance) — good enough for spam bursts
const hits = new Map<string, { count: number; ts: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.ts > 60_000) {
    hits.set(ip, { count: 1, ts: now });
    return false;
  }
  rec.count += 1;
  return rec.count > 5;
}

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
  if (rateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: CORS_HEADERS }
    );
  }

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON" },
      { status: 400, headers: CORS_HEADERS }
    );
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
  await supabase.from("messages").insert({
    ticket_id: ticket.id,
    direction: "inbound",
    type: "public",
    body_text: message,
  });

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
    detail: { via: "web_form", ip },
  });

  // Routing runs inline, after the ticket is safely stored. It is deliberately
  // not fire-and-forget: on serverless, work started after the response is
  // killed with the invocation, so "assign Harvey and email him immediately"
  // would become "sometimes". runRulesSafely never throws, so a broken rule
  // cannot turn a received message into a 500 for the customer.
  await runRulesSafely(ticket.id, "ticket_created");

  return NextResponse.json(
    { ok: true, ticket_number: ticket.number },
    { headers: CORS_HEADERS }
  );
}
