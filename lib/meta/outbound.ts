import { createAdminClient } from "@/lib/supabase/admin";
import { isInlineSafe } from "@/lib/attachments";
import { htmlToPlainText } from "@/lib/html";
import type { MetaChannel } from "./events";
import { sendMetaMessage, type OutboundAttachment } from "./send";
import { replyWindow, unknownWindow, type ReplyWindow } from "./window";

/**
 * Delivering an agent's reply to Instagram or Messenger.
 *
 * Mirrors lib/google/outbound.ts in shape — same DeliveryResult, same "every
 * failure path marks the row" discipline — because a social reply that shows
 * "Sending" forever is the same bug as an email one.
 *
 * THE SENDER IS THE BRAND, not the agent. Unlike email there is no per-person
 * identity on Meta: everything leaves as Blanks. Which agent wrote it is
 * recorded on the message and shown in the thread, so the team can still see
 * who said what, but the customer sees one voice.
 *
 * Server-only.
 */

export type DeliveryResult =
  | { ok: true; skipped?: string }
  | { ok: false; error: string };

export function isMetaChannel(channel: string): channel is MetaChannel {
  return channel === "instagram" || channel === "messenger";
}

/** The customer's platform id for this ticket's channel. */
function recipientFor(
  channel: MetaChannel,
  customer: { ig_user_id: string | null; fb_psid: string | null } | null
): string | null {
  if (!customer) return null;
  return channel === "instagram" ? customer.ig_user_id : customer.fb_psid;
}

/**
 * The reply window for a ticket, from its most recent INBOUND message.
 *
 * Read fresh at send time rather than trusted from the page that rendered the
 * composer: a ticket left open on screen for an hour has a stale countdown,
 * and the send is where being wrong actually costs something.
 */
export async function currentReplyWindow(ticketId: string): Promise<ReplyWindow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .select("created_at")
    .eq("ticket_id", ticketId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  /**
   * A failed read is NOT "this customer never messaged us".
   *
   * Both produce a null timestamp, and the difference decides whether a reply
   * is free-form, needs the HUMAN_AGENT tag, or is blocked outright. Passing
   * the failure through as `never_opened` would block a legitimate reply on a
   * transient database error and tell the agent the customer must message
   * first — which would be untrue and unfixable from their side.
   */
  if (error) {
    console.error(`[meta] could not read the reply window for ${ticketId}:`, error.message);
    return unknownWindow();
  }

  return replyWindow((data?.created_at as string | undefined) ?? null);
}

async function fail(
  messageId: string,
  ticketId: string | null,
  agentId: string | null,
  error: string
): Promise<DeliveryResult> {
  const admin = createAdminClient();
  await admin
    .from("messages")
    .update({ delivery_status: "failed" })
    .eq("id", messageId);

  if (ticketId) {
    await admin.from("ticket_events").insert({
      ticket_id: ticketId,
      agent_id: agentId,
      event_type: "reply_send_failed",
      detail: { message_id: messageId, error, channel: "meta" },
    });
  }
  return { ok: false, error };
}

export async function deliverMetaMessage(messageId: string): Promise<DeliveryResult> {
  const admin = createAdminClient();

  const { data: message, error: loadError } = await admin
    .from("messages")
    .select("id, ticket_id, direction, type, agent_id, body_text, body_html, delivery_status")
    .eq("id", messageId)
    .single();

  if (loadError || !message) {
    return {
      ok: false,
      error: loadError ? `Could not load the message: ${loadError.message}` : "Message not found",
    };
  }
  if (message.direction !== "outbound" || message.type !== "public") {
    return { ok: true, skipped: "not a public reply" };
  }
  if (message.delivery_status === "sent") {
    return { ok: true, skipped: "already sent" };
  }

  const { data: ticket, error: ticketError } = await admin
    .from("tickets")
    .select("id, channel, customer:customers(ig_user_id, fb_psid)")
    .eq("id", message.ticket_id)
    .single();

  if (ticketError || !ticket) {
    return fail(
      message.id,
      message.ticket_id,
      message.agent_id,
      ticketError ? `Could not load the ticket: ${ticketError.message}` : "Ticket not found"
    );
  }
  if (!isMetaChannel(ticket.channel)) {
    return { ok: true, skipped: "not a social ticket" };
  }

  const customer = (Array.isArray(ticket.customer) ? ticket.customer[0] : ticket.customer) as
    | { ig_user_id: string | null; fb_psid: string | null }
    | null;
  const recipient = recipientFor(ticket.channel, customer);
  if (!recipient) {
    return fail(
      message.id,
      ticket.id,
      message.agent_id,
      "This customer has no Instagram or Messenger id on record."
    );
  }

  /**
   * Attachments, as URLs Meta's servers can fetch.
   *
   * Signed and short-lived rather than our own storage paths: the bucket is
   * private, and making it public to send one photo would expose every
   * customer's photographs to anyone who guessed a path.
   *
   * A file we cannot sign is NOT silently dropped — that is the exact defect
   * this drop keeps finding. It fails the send with the filename in it, so
   * the agent knows which one and can try again.
   */
  const attachments = await outboundAttachments(message.id);
  if ("error" in attachments) {
    return fail(message.id, ticket.id, message.agent_id, attachments.error);
  }

  // Re-checked here, not trusted from the composer. The window is a clock,
  // and the only reading that matters is the one at the moment of sending.
  const window = await currentReplyWindow(ticket.id);
  if (!window.canSend) {
    return fail(
      message.id,
      ticket.id,
      message.agent_id,
      "Meta's reply window closed before this could send. The customer needs to message again."
    );
  }

  // Meta takes plain text. The composer stores HTML, so the same conversion
  // the email path uses for its text/plain part applies here.
  const text = (message.body_html
    ? htmlToPlainText(message.body_html)
    : message.body_text
  ).trim();

  // Text OR an attachment is enough; an attachment-only reply is legitimate.
  if (!text && !attachments.files.length) {
    return fail(message.id, ticket.id, message.agent_id, "Nothing to send.");
  }

  const sent = await sendMetaMessage({
    recipientId: recipient,
    text,
    windowState: window.state,
    channel: ticket.channel,
    attachments: attachments.files,
  });

  if (!sent.ok) {
    return fail(message.id, ticket.id, message.agent_id, sent.error);
  }

  await admin
    .from("messages")
    .update({
      delivery_status: "sent",
      // Recorded so the echo Meta sends back for this same message is
      // recognised as a duplicate rather than appended a second time.
      meta_message_id: sent.messageId,
    })
    .eq("id", message.id);

  if (window.requiresTag) {
    // Worth an audit row: HUMAN_AGENT is a policy-bearing tag, and "why did
    // we send outside the window" should be answerable later.
    await admin.from("ticket_events").insert({
      ticket_id: ticket.id,
      agent_id: message.agent_id,
      event_type: "human_agent_reply",
      detail: { message_id: message.id, hours_since_inbound: Math.round((Date.now() - new Date(window.lastInboundAt!).getTime()) / 3_600_000) },
    });
  }

  return { ok: true };
}


/** How long Meta gets to fetch an attachment before the URL dies. */
const ATTACHMENT_URL_TTL_SECONDS = 10 * 60;

/**
 * Signed URLs for a message's attachments, or the reason there are none.
 *
 * Meta fetches the bytes from a URL rather than accepting an upload, so each
 * file needs a link its servers can reach. The bucket is private and stays
 * that way: these are short-lived signed URLs, not a public path.
 *
 * Returns `{ error }` rather than an empty list when signing fails. Dropping
 * an attachment silently is the defect this codebase keeps rediscovering —
 * the customer would receive the words without the photo, and the agent would
 * be told it sent.
 */
async function outboundAttachments(
  messageId: string
): Promise<{ files: OutboundAttachment[] } | { error: string }> {
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("attachments")
    .select("id, filename, mime_type, storage_path")
    .eq("message_id", messageId)
    .order("created_at", { ascending: true });

  // A failed lookup is not "no attachments". Sending the text alone would
  // deliver half a reply and call it whole.
  if (error) {
    return { error: `Could not read this reply's attachments: ${error.message}` };
  }
  if (!rows?.length) return { files: [] };

  const files: OutboundAttachment[] = [];
  for (const row of rows) {
    const { data, error: signError } = await admin.storage
      .from("attachments")
      .createSignedUrl(row.storage_path as string, ATTACHMENT_URL_TTL_SECONDS);

    if (signError || !data?.signedUrl) {
      return {
        error: `Could not prepare ${row.filename} for sending: ${signError?.message ?? "no signed URL"}`,
      };
    }

    files.push({
      url: data.signedUrl,
      // Meta renders `image` inline and offers `file` as a download. The
      // mime type decides, not the extension — the same rule the inline
      // serving allowlist uses.
      kind: isInlineSafe(row.mime_type as string | null) ? "image" : "file",
      filename: (row.filename as string) ?? "attachment",
    });
  }

  return { files };
}
