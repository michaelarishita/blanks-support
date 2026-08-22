import { createAdminClient } from "@/lib/supabase/admin";
import { runRulesSafely } from "@/lib/rules/engine";
import { notifyNewTicketSafely } from "@/lib/notifications/new-ticket";
import { assessTicketRisk } from "@/lib/risk/assess";
import { sniffFileType, safeStoredName } from "@/lib/uploads/sniff";
import { stripMetadata } from "@/lib/uploads/strip";
import {
  conversationId,
  type MetaChannel,
  type MetaEvent,
  type MetaMessageEvent,
} from "./events";
import { downloadMedia, fetchProfile, getPageAccessToken } from "./graph";

/**
 * Turning Meta events into tickets.
 *
 * Mirrors lib/google/inbound.ts deliberately — same shape of result, same
 * named-skip counting, same "the unique index is the dedupe" discipline. Two
 * inbound paths that behave differently is two things to remember.
 *
 * Server-only.
 */

export interface MetaSyncResult {
  received: number;
  created: number;
  appended: number;
  skipped: Record<string, number>;
  ruleHits: Record<string, number>;
}

export function emptyMetaResult(): MetaSyncResult {
  return { received: 0, created: 0, appended: 0, skipped: {}, ruleHits: {} };
}

function countSkip(result: MetaSyncResult, reason: string) {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}

/** The tag that keeps a story reply from being treated as a support request. */
const STORY_TAG = "Story reply";

/**
 * Finds or creates the customer behind a PSID/IGSID.
 *
 * Email is null here and the schema has always allowed it — a DM gives us an
 * id and, if the profile call works, a name. Nothing else.
 */
async function upsertCustomer(
  customerId: string,
  channel: MetaChannel,
  token: string | null
): Promise<string | null> {
  const admin = createAdminClient();
  const column = channel === "instagram" ? "ig_user_id" : "fb_psid";

  const { data: existing } = await admin
    .from("customers")
    .select("id, name")
    .eq(column, customerId)
    .maybeSingle();

  // The profile is only fetched for someone we have not seen: it costs a
  // Graph call, and a name does not change often enough to re-check per
  // message.
  if (existing) {
    if (!existing.name && token) {
      const profile = await fetchProfile(customerId, channel, token);
      if (profile.name || profile.username) {
        await admin
          .from("customers")
          .update({ name: profile.name ?? `@${profile.username}` })
          .eq("id", existing.id);
      }
    }
    return existing.id;
  }

  const profile = token
    ? await fetchProfile(customerId, channel, token)
    : { name: null, username: null, avatarUrl: null };

  const { data: created, error } = await admin
    .from("customers")
    .insert({
      [column]: customerId,
      // Instagram's handle is more recognisable than the display name, so it
      // is the fallback before the raw id.
      name: profile.name ?? (profile.username ? `@${profile.username}` : null),
      notes: profile.username ? `Instagram: @${profile.username}` : null,
    })
    .select("id")
    .single();

  if (error) {
    // A concurrent delivery of the same first message can lose this race; the
    // unique index on the id column is what makes that safe to retry.
    const { data: raced } = await admin
      .from("customers")
      .select("id")
      .eq(column, customerId)
      .maybeSingle();
    if (raced) return raced.id;
    console.error("[meta] customer insert failed:", error);
    return null;
  }
  return created.id;
}

/** Finds the ticket for this conversation, or opens one. */
async function resolveTicket(
  event: MetaMessageEvent,
  customerRowId: string
): Promise<{ id: string; created: boolean } | null> {
  const admin = createAdminClient();
  const key = conversationId(event.channel, event.pageId, event.customerId);

  const { data: existing } = await admin
    .from("tickets")
    .select("id")
    .eq("meta_conversation_id", key)
    // A resolved DM thread that gets a new message should reopen rather than
    // fork, and the messages trigger already handles the reopen.
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { id: existing.id, created: false };

  const subject = event.isStoryReply
    ? "Story reply"
    : event.text
      ? event.text.slice(0, 120)
      : `${event.channel === "instagram" ? "Instagram" : "Messenger"} message`;

  const { data: ticket, error } = await admin
    .from("tickets")
    .insert({
      customer_id: customerRowId,
      channel: event.channel,
      subject,
      status: "new",
      meta_conversation_id: key,
      // A story reply is usually "nice tub!", not a support request. Opening
      // it at Normal and letting a rule raise it is right; opening every one
      // at the default and paging Harvey is not.
      topic: event.isStoryReply ? "Feedback" : null,
    })
    .select("id")
    .single();

  if (error || !ticket) {
    console.error("[meta] ticket insert failed:", error);
    return null;
  }

  await admin.from("ticket_events").insert({
    ticket_id: ticket.id,
    event_type: "created",
    detail: {
      via: event.channel,
      conversation: key,
      story_reply: event.isStoryReply,
    },
  });

  return { id: ticket.id, created: true };
}

/**
 * Stores media, stripped.
 *
 * Same treatment as a widget upload: sniffed by content, EXIF removed, refused
 * if it cannot be parsed. A DM photo is a customer photo — it carries the same
 * GPS.
 */
async function storeMedia(
  event: MetaMessageEvent,
  ticketId: string,
  messageId: string,
  result: MetaSyncResult
): Promise<void> {
  const admin = createAdminClient();

  for (const [index, attachment] of event.attachments.entries()) {
    if (!attachment.url) {
      countSkip(result, `attachment without a url (${attachment.type})`);
      continue;
    }

    const bytes = await downloadMedia(attachment.url);
    if (!bytes) {
      countSkip(result, "media download failed");
      continue;
    }

    const sniffed = sniffFileType(bytes);
    if (!sniffed) {
      countSkip(result, `media type not allowed (${attachment.type})`);
      continue;
    }

    const stripped = stripMetadata(sniffed.kind, bytes);
    if (!stripped.ok) {
      countSkip(result, `media metadata unreadable (${stripped.reason})`);
      continue;
    }

    const filename = safeStoredName(
      `${attachment.type}-${index + 1}`,
      sniffed.extension
    );
    const path = `${ticketId}/${messageId}/${index}-${filename}`;

    const { error: uploadError } = await admin.storage
      .from("attachments")
      .upload(path, stripped.bytes, { contentType: sniffed.kind, upsert: false });
    if (uploadError) {
      countSkip(result, `media upload failed (${uploadError.message})`);
      continue;
    }

    await admin.from("attachments").insert({
      message_id: messageId,
      filename,
      mime_type: sniffed.kind,
      size_bytes: stripped.bytes.length,
      storage_path: path,
    });
  }
}

async function ingestMessage(
  event: MetaMessageEvent,
  result: MetaSyncResult
): Promise<void> {
  const admin = createAdminClient();
  const token = await getPageAccessToken();

  const customerRowId = await upsertCustomer(event.customerId, event.channel, token);
  if (!customerRowId) {
    countSkip(result, "could not resolve the customer");
    return;
  }

  const ticket = await resolveTicket(event, customerRowId);
  if (!ticket) {
    countSkip(result, "could not resolve the ticket");
    return;
  }
  if (ticket.created) result.created++;
  else result.appended++;

  const isEcho = event.kind === "echo";
  const body =
    event.text ||
    (event.attachments.length
      ? `[${event.attachments.map((a) => a.type).join(", ")}]`
      : "");

  const { data: inserted, error } = await admin
    .from("messages")
    .insert({
      ticket_id: ticket.id,
      // An ECHO is something we sent — from the Instagram app on someone's
      // phone, most likely. Filing it as inbound would make the thread claim
      // the customer said it.
      direction: isEcho ? "outbound" : "inbound",
      type: "public",
      agent_id: null,
      body_text: body,
      meta_message_id: event.mid,
      delivery_status: isEcho ? "sent" : "stored",
      // An echo is a reply we did not compose here, so it must not stamp
      // first_response_at as if an agent had answered in the dashboard.
      is_automated: isEcho,
      created_at: new Date(event.timestamp).toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    // 23505 is the unique index doing its job on a redelivery — the same
    // discipline as the Gmail path, and the reason the ingest does not need
    // to be transactional to be correct.
    if (error.code === "23505") {
      countSkip(result, "duplicate");
      // Undo the count: nothing was actually appended.
      if (ticket.created) result.created--;
      else result.appended--;
      return;
    }
    countSkip(result, `could not store message (${error.message})`);
    return;
  }

  if (event.attachments.length) {
    await storeMedia(event, ticket.id, inserted.id, result);
  }

  if (event.isStoryReply) {
    await applyTag(ticket.id, STORY_TAG);
  }

  // Only a real inbound message routes. An echo is our own reply, and running
  // rules on it could reassign a ticket because of something we said.
  if (!isEcho) {
    const rules = await runRulesSafely(
      ticket.id,
      ticket.created ? "ticket_created" : "message_received"
    );
    for (const rule of rules.fired) {
      result.ruleHits[rule.name] = (result.ruleHits[rule.name] ?? 0) + 1;
    }

    // New conversations only — an echo is ours, and a reply on an existing
    // DM thread is not news.
    if (ticket.created) {
      await notifyNewTicketSafely(ticket.id);
      await assessTicketRisk(ticket.id);
    }
  }
}

/** Adds a tag by name, creating it if this is the first story reply. */
async function applyTag(ticketId: string, name: string): Promise<void> {
  const admin = createAdminClient();
  let { data: tag } = await admin
    .from("tags")
    .select("id")
    .eq("name", name)
    .maybeSingle();

  if (!tag) {
    const { data: created } = await admin
      .from("tags")
      .insert({ name, color: "#a78bfa", is_topic: false })
      .select("id")
      .single();
    tag = created ?? null;
  }
  if (!tag) return;

  // Duplicate is fine — the primary key on (ticket_id, tag_id) absorbs it.
  await admin
    .from("ticket_tags")
    .insert({ ticket_id: ticketId, tag_id: tag.id });
}

/** Marks an unsent message rather than deleting it. */
async function markDeleted(mid: string, result: MetaSyncResult): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("messages")
    .update({ deleted_at: new Date().toISOString() })
    .eq("meta_message_id", mid)
    .select("id");

  if (error) {
    countSkip(result, `could not mark deleted (${error.message})`);
    return;
  }
  if (!data?.length) countSkip(result, "delete for an unknown message");
}

/** Reactions live in the audit trail; a heart is not a support request. */
async function recordReaction(
  event: Extract<MetaEvent, { kind: "reaction" }>,
  result: MetaSyncResult
): Promise<void> {
  const admin = createAdminClient();
  const { data: message } = await admin
    .from("messages")
    .select("ticket_id")
    .eq("meta_message_id", event.mid)
    .maybeSingle();

  if (!message) {
    countSkip(result, "reaction to an unknown message");
    return;
  }

  await admin.from("ticket_events").insert({
    ticket_id: message.ticket_id,
    event_type: "reaction",
    detail: { mid: event.mid, action: event.action, emoji: event.emoji },
  });
}

/**
 * Processes a batch of normalised events.
 *
 * Never throws. The route must answer 200 fast — Meta retries hard on
 * anything else and disables a subscription that keeps failing — so an event
 * that goes wrong is counted and stepped over rather than allowed to fail the
 * whole delivery.
 */
export async function processMetaEvents(
  events: MetaEvent[]
): Promise<MetaSyncResult> {
  const result = emptyMetaResult();

  for (const event of events) {
    result.received++;
    try {
      switch (event.kind) {
        case "message":
        case "echo":
          await ingestMessage(event, result);
          break;
        case "delete":
          await markDeleted(event.mid, result);
          break;
        case "reaction":
          await recordReaction(event, result);
          break;
        case "ignored":
          countSkip(result, event.reason);
          break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[meta] event failed:", message);
      countSkip(result, `threw (${message})`);
    }
  }

  return result;
}
