import { createAdminClient } from "@/lib/supabase/admin";
import { getGmailMessage } from "./gmail";
import { getAccessToken, getSupportInboxConnection } from "./tokens";
import { looksLikeHtml, parseGmailMessage } from "@/lib/email/parse";
import { storeInboundAttachments } from "./inbound";
import type { SyncResult } from "./inbound";

/**
 * Re-fetches attachments for mail that already became a ticket.
 *
 * Every photo emailed before the inline fix was parsed correctly and then
 * discarded — the ticket has the body and nothing else. Gmail still holds the
 * originals, and the message rows still carry gmail_message_id, so the whole
 * thing is recoverable.
 *
 * Deliberately re-parses from Gmail rather than trusting anything we stored:
 * the bug WAS in our interpretation, so re-reading our own record of it would
 * reproduce the mistake.
 */

export interface BackfillCandidate {
  ticketNumber: number;
  messageId: string;
  gmailMessageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface BackfillResult {
  dryRun: boolean;
  /** Messages whose stored body still holds raw markup. */
  bodiesToRepair: { ticketNumber: number; messageId: string }[];
  bodiesRepaired: number;
  /** Messages inspected. */
  scanned: number;
  /** Attachments that would be (or were) pulled. */
  candidates: BackfillCandidate[];
  totalBytes: number;
  /** Only populated on a real run. */
  stored: number;
  skipped: Record<string, number>;
  errors: string[];
}

/**
 * Finds and optionally restores missing attachments.
 *
 * @param ticketNumbers restrict to these tickets; omit for every email ticket
 * @param dryRun        when true, nothing is downloaded and nothing is written
 */
export async function backfillAttachments({
  ticketNumbers,
  dryRun = true,
}: {
  ticketNumbers?: number[];
  dryRun?: boolean;
} = {}): Promise<BackfillResult> {
  const result: BackfillResult = {
    dryRun,
    bodiesToRepair: [],
    bodiesRepaired: 0,
    scanned: 0,
    candidates: [],
    totalBytes: 0,
    stored: 0,
    skipped: {},
    errors: [],
  };

  const admin = createAdminClient();
  const connection = await getSupportInboxConnection();
  if (!connection) {
    result.errors.push("No support mailbox connected.");
    return result;
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(connection.id);
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    return result;
  }

  let query = admin
    .from("tickets")
    .select("id, number")
    .eq("channel", "email")
    .order("number", { ascending: true });
  if (ticketNumbers?.length) query = query.in("number", ticketNumbers);

  const { data: tickets, error } = await query;
  if (error) {
    result.errors.push(error.message);
    return result;
  }

  for (const ticket of tickets ?? []) {
    const { data: messages } = await admin
      .from("messages")
      .select("id, gmail_message_id, body_text")
      .eq("ticket_id", ticket.id)
      .eq("direction", "inbound")
      .not("gmail_message_id", "is", null);

    for (const message of messages ?? []) {
      result.scanned++;

      // Bodies stored before the HTML fix still hold raw markup — a mailer
      // that labelled an HTML part text/plain meant the conversion never ran,
      // so the customer's words are sitting in the thread as <p> and
      // <a href=...>. Re-parsing is the same operation as re-fetching the
      // attachments, on the same message, so it happens here.
      const storedBody = (message.body_text as string | null) ?? "";
      const needsBodyRepair = looksLikeHtml(storedBody);

      // Already restored, or never had any — either way there is nothing to
      // do, and re-uploading would duplicate the row.
      const { data: existing } = await admin
        .from("attachments")
        .select("id")
        .eq("message_id", message.id)
        .limit(1);
      if (existing?.length && !needsBodyRepair) {
        result.skipped["already has attachments"] =
          (result.skipped["already has attachments"] ?? 0) + 1;
        continue;
      }

      let parsed;
      try {
        parsed = parseGmailMessage(
          await getGmailMessage(accessToken, message.gmail_message_id as string)
        );
      } catch (e) {
        // Mail deleted from the mailbox since, most likely. Counted, not fatal.
        const reason = e instanceof Error ? e.message : String(e);
        result.skipped[`gmail fetch failed (${reason})`] =
          (result.skipped[`gmail fetch failed (${reason})`] ?? 0) + 1;
        continue;
      }

      if (needsBodyRepair && parsed.bodyText && parsed.bodyText !== storedBody) {
        result.bodiesToRepair.push({
          ticketNumber: ticket.number as number,
          messageId: message.id as string,
        });
        if (!dryRun) {
          const { error: bodyError } = await admin
            .from("messages")
            .update({ body_text: parsed.bodyText })
            .eq("id", message.id);
          if (bodyError) result.errors.push(bodyError.message);
          else result.bodiesRepaired++;
        }
      }

      // The fixed classification: inline means the body references it.
      const wanted = parsed.attachments.filter((a) => !a.inline);
      if (existing?.length) continue;
      if (!wanted.length) continue;

      for (const attachment of wanted) {
        result.candidates.push({
          ticketNumber: ticket.number as number,
          messageId: message.id as string,
          gmailMessageId: message.gmail_message_id as string,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        });
        result.totalBytes += attachment.sizeBytes;
      }

      // THE DRY-RUN BOUNDARY. Everything above reads metadata; everything
      // below downloads bytes and writes rows.
      if (dryRun) continue;

      const storeResult: SyncResult = {
        checked: 0,
        created: 0,
        appended: 0,
        skipped: {},
        ruleHits: {},
        failures: [],
      };
      const before = await countAttachments(message.id as string);
      await storeInboundAttachments(
        accessToken,
        { ...parsed, attachments: wanted },
        ticket.id as string,
        message.id as string,
        storeResult
      );
      const after = await countAttachments(message.id as string);
      result.stored += after - before;

      for (const [reason, count] of Object.entries(storeResult.skipped)) {
        result.skipped[reason] = (result.skipped[reason] ?? 0) + count;
      }
    }
  }

  return result;
}

async function countAttachments(messageId: string): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("attachments")
    .select("id", { count: "exact", head: true })
    .eq("message_id", messageId);
  return count ?? 0;
}
