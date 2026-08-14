import { createAdminClient } from "@/lib/supabase/admin";
import {
  getGmailAttachment,
  getGmailMessage,
  getGmailProfile,
  listGmailHistory,
  listGmailMessages,
} from "./gmail";
import { getAccessToken, getSupportInboxConnection, setLastHistoryId } from "./tokens";
import {
  extractTicketToken,
  parseGmailMessage,
  type ParsedEmail,
} from "@/lib/email/parse";

// Pulls new mail from the shared support mailbox and turns it into tickets.
// Driven by two triggers that share this one implementation: the Pub/Sub
// webhook in production, and polling / the manual button in development.
// Server-only.

/** How the incoming message was matched to an existing ticket. */
export type MatchPath = "token" | "references" | "thread" | "sender" | "new";

export interface SyncResult {
  checked: number;
  created: number;
  appended: number;
  skipped: Record<string, number>;
  error?: string;
}

/** Last-resort matching only looks this far back. */
const SENDER_MATCH_WINDOW_DAYS = 7;
/** Cap per run so one sync can't hang on a huge backlog. */
const DEFAULT_MAX_MESSAGES = 25;

function emptyResult(): SyncResult {
  return { checked: 0, created: 0, appended: 0, skipped: {} };
}

function countSkip(result: SyncResult, reason: string) {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}

/** Subject with the routing token and reply prefixes removed. */
function normalizeSubject(subject: string): string {
  return subject
    .replace(/\s*\[BLK-\d+\]\s*/gi, " ")
    .replace(/^((re|fwd?|aw|antwort)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Addresses whose mail must never become an inbound customer message: our own
 * agents, and the support mailbox itself. Outbound sends echo into the
 * mailbox's own thread, so without this every reply we send would come back
 * as a customer message.
 */
async function ourOwnAddresses(supportAddress: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data: agents } = await admin.from("agents").select("email");

  const addresses = new Set<string>([supportAddress.toLowerCase()]);
  if (process.env.SUPPORT_EMAIL) {
    addresses.add(process.env.SUPPORT_EMAIL.toLowerCase());
  }
  for (const agent of agents ?? []) {
    if (agent.email) addresses.add(agent.email.toLowerCase());
  }
  return addresses;
}

/**
 * Additional senders to ignore, from IGNORED_SENDER_EMAILS.
 *
 * Exists for the Gorgias parallel run: support@ still routes to the old
 * help desk, and a reply an agent sends from there can land in the watched
 * mailbox. Without this it would be read as a customer message and open a
 * ticket answering ourselves.
 *
 * Exported and pure so the parsing is testable without a mailbox.
 */
export function parseIgnoredSenders(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Finds the ticket an incoming message belongs to.
 *
 * Precedence matters: the [BLK-n] token is checked first because it survives
 * clients that rewrite Message-ID, which is the failure mode header-based
 * threading actually hits in the wild.
 */
async function routeToTicket(
  parsed: ParsedEmail
): Promise<{ ticketId: string; path: MatchPath } | null> {
  const admin = createAdminClient();

  // 1. Routing token in the subject.
  const ticketNumber = extractTicketToken(parsed.subject);
  if (ticketNumber !== null) {
    const { data } = await admin
      .from("tickets")
      .select("id")
      .eq("number", ticketNumber)
      .maybeSingle();
    if (data) return { ticketId: data.id, path: "token" };
  }

  // 2. In-Reply-To / References against Message-IDs we've stored.
  const candidateIds = [parsed.inReplyTo, ...parsed.references].filter(
    (id): id is string => Boolean(id)
  );
  if (candidateIds.length) {
    const { data, error } = await admin
      .from("messages")
      .select("ticket_id")
      .in("rfc822_message_id", candidateIds)
      .limit(1);
    // A failed routing lookup would fall through to "create a new ticket",
    // silently splitting a conversation in two. Fail loudly instead.
    if (error) throw new Error(`Routing lookup failed: ${error.message}`);
    if (data?.length) return { ticketId: data[0].ticket_id, path: "references" };
  }

  // 3. Gmail's own thread id.
  const { data: byThread, error: threadError } = await admin
    .from("tickets")
    .select("id")
    .eq("gmail_thread_id", parsed.gmailThreadId)
    .maybeSingle();
  if (threadError) throw new Error(`Thread lookup failed: ${threadError.message}`);
  if (byThread) return { ticketId: byThread.id, path: "thread" };

  // 4. Same sender, recent, still open, and the same subject once prefixes
  //    are stripped. The subject condition is deliberately stricter than a
  //    pure recency heuristic: silently merging two unrelated conversations
  //    is worse than opening a second ticket.
  if (parsed.fromEmail) {
    const since = new Date(
      Date.now() - SENDER_MATCH_WINDOW_DAYS * 86_400_000
    ).toISOString();
    const { data: customer } = await admin
      .from("customers")
      .select("id")
      .eq("email", parsed.fromEmail)
      .maybeSingle();

    if (customer) {
      const { data: recent } = await admin
        .from("tickets")
        .select("id, subject")
        .eq("customer_id", customer.id)
        .not("status", "in", "(closed)")
        .gte("last_message_at", since)
        .order("last_message_at", { ascending: false })
        .limit(10);

      const incoming = normalizeSubject(parsed.subject);
      const match = (recent ?? []).find(
        (ticket) => incoming && normalizeSubject(ticket.subject) === incoming
      );
      if (match) return { ticketId: match.id, path: "sender" };
    }
  }

  return null;
}

async function upsertCustomer(parsed: ParsedEmail): Promise<string | null> {
  if (!parsed.fromEmail) return null;
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("customers")
    .select("id, name")
    .eq("email", parsed.fromEmail)
    .maybeSingle();

  if (existing) {
    // Fill in a name we didn't have, but never overwrite one already set.
    if (!existing.name && parsed.fromName) {
      await admin.from("customers").update({ name: parsed.fromName }).eq("id", existing.id);
    }
    return existing.id;
  }

  const { data: created } = await admin
    .from("customers")
    .insert({ email: parsed.fromEmail, name: parsed.fromName })
    .select("id")
    .single();
  return created?.id ?? null;
}

/** Anything larger is left in Gmail rather than copied into storage. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Strips path separators so a crafted filename can't escape its folder. */
function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "file";
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
}

/**
 * Copies attachments into private storage and records them.
 *
 * Inline images (referenced by cid: in the HTML body) are skipped for now —
 * they're signature logos and tracking artefacts far more often than content,
 * and we render inbound mail as text anyway, so nothing would reference them.
 */
async function storeAttachments(
  accessToken: string,
  parsed: ParsedEmail,
  ticketId: string,
  messageId: string,
  result: SyncResult
): Promise<void> {
  const admin = createAdminClient();

  for (const attachment of parsed.attachments) {
    if (attachment.inline) {
      countSkip(result, "inline image");
      continue;
    }
    if (attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
      countSkip(result, "attachment too large");
      continue;
    }

    try {
      const data = await getGmailAttachment(
        accessToken,
        parsed.gmailMessageId,
        attachment.attachmentId
      );
      const bytes = Buffer.from(data.data, "base64url");
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        countSkip(result, "attachment too large");
        continue;
      }

      const path = `${ticketId}/${messageId}/${safeFilename(attachment.filename)}`;
      const { error: uploadError } = await admin.storage
        .from("attachments")
        .upload(path, bytes, {
          contentType: attachment.mimeType,
          upsert: true,
        });
      if (uploadError) {
        countSkip(result, `attachment upload failed (${uploadError.message})`);
        continue;
      }

      await admin.from("attachments").insert({
        message_id: messageId,
        filename: attachment.filename.slice(0, 200),
        mime_type: attachment.mimeType,
        size_bytes: bytes.byteLength,
        storage_path: path,
      });
    } catch (e) {
      countSkip(
        result,
        `attachment failed (${e instanceof Error ? e.message : "unknown"})`
      );
    }
  }
}

/** Stores one parsed email, creating or appending to a ticket. */
async function ingestMessage(
  accessToken: string,
  parsed: ParsedEmail,
  result: SyncResult
): Promise<{ ticketId: string; path: MatchPath } | null> {
  const admin = createAdminClient();

  const routed = await routeToTicket(parsed);
  let ticketId = routed?.ticketId ?? null;
  const path: MatchPath = routed?.path ?? "new";

  if (!ticketId) {
    const customerId = await upsertCustomer(parsed);
    if (!customerId) {
      countSkip(result, "no sender address");
      return null;
    }

    const subject =
      parsed.subject.replace(/\s*\[BLK-\d+\]\s*/gi, " ").trim() || "(no subject)";

    const { data: ticket, error } = await admin
      .from("tickets")
      .insert({
        customer_id: customerId,
        channel: "email",
        subject,
        status: "new",
        gmail_thread_id: parsed.gmailThreadId,
      })
      .select("id")
      .single();
    if (error || !ticket) {
      countSkip(result, "could not create ticket");
      return null;
    }

    ticketId = ticket.id;
    result.created++;

    await admin.from("ticket_events").insert({
      ticket_id: ticketId,
      event_type: "created",
      detail: { via: "email", from: parsed.fromEmail },
    });
  } else {
    result.appended++;
    // Remember the thread if we learned it from a token/reference match, so
    // later replies route by thread id too.
    await admin
      .from("tickets")
      .update({ gmail_thread_id: parsed.gmailThreadId })
      .eq("id", ticketId)
      .is("gmail_thread_id", null);
  }

  const { data: inserted, error: insertError } = await admin
    .from("messages")
    .insert({
      ticket_id: ticketId,
      direction: "inbound",
      type: "public",
      // Stored whole; the thread view collapses quoted history at render time.
      body_text: parsed.bodyText,
      gmail_message_id: parsed.gmailMessageId,
      rfc822_message_id: parsed.rfc822MessageId,
      delivery_status: "stored",
      created_at: parsed.date.toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    // A unique violation means Pub/Sub redelivered a message we already have.
    if (insertError.code === "23505") {
      countSkip(result, "duplicate");
      return null;
    }
    countSkip(result, "could not store message");
    return null;
  }

  if (!ticketId || !inserted) {
    countSkip(result, "could not resolve ticket");
    return null;
  }

  if (parsed.attachments.length) {
    await storeAttachments(accessToken, parsed, ticketId, inserted.id, result);
  }

  // Recorded so we can see whether the [BLK-n] token is actually doing the
  // routing work, or whether header threading is carrying it.
  if (path !== "new") {
    await admin.from("ticket_events").insert({
      ticket_id: ticketId,
      event_type: "email_received",
      detail: { match_path: path, from: parsed.fromEmail },
    });
  }

  return { ticketId, path };
}

/** Collects new message ids, preferring the incremental history feed. */
async function collectNewMessageIds(
  accessToken: string,
  lastHistoryId: string | null,
  max: number
): Promise<{ ids: string[]; historyId: string | null; usedFallback: boolean }> {
  if (lastHistoryId) {
    try {
      const ids: string[] = [];
      let pageToken: string | undefined;
      let historyId: string | null = null;

      do {
        const page = await listGmailHistory(accessToken, lastHistoryId, pageToken);
        for (const entry of page.history ?? []) {
          for (const added of entry.messagesAdded ?? []) {
            ids.push(added.message.id);
          }
        }
        historyId = page.historyId ?? historyId;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);

      return { ids: ids.slice(0, max), historyId, usedFallback: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A cursor older than Gmail's history window (roughly a week) 404s.
      // That's "resync", not "fail".
      const expired =
        message.includes("404") ||
        message.toLowerCase().includes("not found") ||
        message.toLowerCase().includes("invalid");
      if (!expired) throw e;
    }
  }

  // Fallback scan. Bounded by date as well as count so a first-ever sync on
  // an old mailbox can't import the archive.
  const listed = await listGmailMessages(accessToken, "in:inbox newer_than:2d", max);
  const profile = await getGmailProfile(accessToken);
  return {
    ids: (listed.messages ?? []).map((m) => m.id),
    historyId: profile.historyId,
    usedFallback: true,
  };
}

export async function syncSupportMailbox(
  options: { max?: number } = {}
): Promise<SyncResult> {
  const result = emptyResult();
  const max = options.max ?? DEFAULT_MAX_MESSAGES;

  const connection = await getSupportInboxConnection();
  if (!connection) {
    return { ...result, error: "No support mailbox connected." };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(connection.id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ...result,
      error:
        message === "GMAIL_RECONNECT_REQUIRED"
          ? "Support mailbox access expired — reconnect it in Settings."
          : message,
    };
  }

  let collected;
  try {
    collected = await collectNewMessageIds(accessToken, connection.last_history_id, max);
  } catch (e) {
    return { ...result, error: e instanceof Error ? e.message : String(e) };
  }

  const admin = createAdminClient();
  const ourAddresses = await ourOwnAddresses(connection.account_ref);
  const ignoredSenders = parseIgnoredSenders(process.env.IGNORED_SENDER_EMAILS);

  // Drop ids we've already stored before spending a fetch on each one.
  const uniqueIds = [...new Set(collected.ids)];
  let pending = uniqueIds;
  if (uniqueIds.length) {
    const { data: known } = await admin
      .from("messages")
      .select("gmail_message_id")
      .in("gmail_message_id", uniqueIds);
    const seen = new Set((known ?? []).map((m) => m.gmail_message_id));
    pending = uniqueIds.filter((id) => !seen.has(id));
    const duplicates = uniqueIds.length - pending.length;
    if (duplicates > 0) result.skipped.duplicate = duplicates;
  }

  for (const id of pending) {
    result.checked++;
    try {
      const parsed = parseGmailMessage(await getGmailMessage(accessToken, id));

      if (parsed.autoReplyReason) {
        countSkip(result, `automated (${parsed.autoReplyReason})`);
        continue;
      }
      if (!parsed.fromEmail) {
        countSkip(result, "no sender address");
        continue;
      }
      if (ourAddresses.has(parsed.fromEmail)) {
        countSkip(result, "our own address");
        continue;
      }
      // parsed.fromEmail is already lowercased by parseAddress, and the
      // configured list is lowercased on parse, so this match is
      // case-insensitive on both sides.
      if (ignoredSenders.has(parsed.fromEmail)) {
        countSkip(result, `ignored sender (${parsed.fromEmail})`);
        continue;
      }

      await ingestMessage(accessToken, parsed, result);
    } catch (e) {
      countSkip(result, e instanceof Error ? e.message : "fetch failed");
    }
  }

  // Advance the cursor only after the batch is processed, so a crash
  // mid-run re-reads those messages rather than losing them. Re-reading is
  // safe — the gmail_message_id unique index dedupes.
  if (collected.historyId) {
    await setLastHistoryId(connection.id, collected.historyId);
  }

  return result;
}
