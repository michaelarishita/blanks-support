import { createAdminClient } from "@/lib/supabase/admin";
import {
  GmailApiError,
  getGmailAttachment,
  getGmailMessage,
  getGmailProfile,
  listGmailHistory,
  listGmailMessages,
} from "./gmail";
import { getAccessToken, getSupportInboxConnection, setLastHistoryId } from "./tokens";
import { getSettingsBlob, patchSettingsBlob } from "@/lib/settings";
import {
  extractTicketToken,
  parseGmailMessage,
  type ParsedEmail,
} from "@/lib/email/parse";
import { runRulesSafely } from "@/lib/rules/engine";
import { loadIgnoreList } from "@/lib/senders/ignored";
import { notifyNewTicketSafely } from "@/lib/notifications/new-ticket";
import { assessTicketRisk } from "@/lib/risk/assess";
import { MAX_FILE_BYTES } from "@/lib/uploads/limits";
import { sniffFileType } from "@/lib/uploads/sniff";
import { stripMetadata } from "@/lib/uploads/strip";
import { storageContentType } from "@/lib/attachments";
import {
  alertOnQuarantine,
  loadQuarantinedIds,
  quarantineMessage,
  recordAttempt,
  shouldQuarantine,
  type FailurePhase,
} from "@/lib/inbound/quarantine";

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
  /** Rule name → how many messages in this run it fired on. */
  ruleHits: Record<string, number>;
  /**
   * Messages we FAILED to store, as opposed to deliberately dropped.
   *
   * Kept separate from `skipped` on purpose. A guard dropping a mailing-list
   * digest is the system working; an insert failing because a column is
   * missing is the system broken, and collapsing the two into one counter is
   * how a schema error reads as "nothing new today".
   */
  failures: string[];
  /**
   * The same failures, structured, because the quarantine decision needs the
   * message id and the phase and a prose line cannot be asked for either.
   */
  failedMessages: { id: string; phase: FailurePhase; error: string }[];
  /** Messages given up on this run, so the cursor could move past them. */
  quarantined: string[];
  /**
   * Message rows actually written this run.
   *
   * Deliberately NOT `created + appended`: those count TICKETS, and the ticket
   * insert happens before the message insert. A run where every message insert
   * failed still had a non-zero `created`, which told the quarantine guard the
   * database was healthy at the exact moment it was not.
   */
  storedMessages: number;
  error?: string;
}

/** Last-resort matching only looks this far back. */
const SENDER_MATCH_WINDOW_DAYS = 7;
/** Cap per run so one sync can't hang on a huge backlog. */
const DEFAULT_MAX_MESSAGES = 25;

function emptyResult(): SyncResult {
  return {
    checked: 0,
    created: 0,
    appended: 0,
    skipped: {},
    ruleHits: {},
    failures: [],
    failedMessages: [],
    quarantined: [],
    storedMessages: 0,
  };
}

function countSkip(result: SyncResult, reason: string) {
  result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
}

/**
 * A message id Gmail's history stream reported that Gmail will never serve.
 *
 * The overwhelming source is our OWN outbound: sending through the API
 * creates a draft, the draft gets an id, `messagesAdded` records it, and the
 * draft is destroyed the instant it becomes a sent message. The id stays in
 * the history page forever, and `messages.get` answers 404 for it forever.
 * Customer mail that was deleted before we read it lands here too.
 *
 * This is TERMINAL, and telling it apart from a transient failure is the
 * whole point: a 404 held the cursor back, so every message behind it — 25 to
 * a run, the same 25 every run — was never read. Retrying cannot make a
 * message that does not exist appear, so retrying forever costs the channel.
 */
function isGoneFromMailbox(e: unknown): boolean {
  return e instanceof GmailApiError && e.status === 404;
}

/** Shape of a PostgREST error, which carries far more than `.message`. */
interface PostgresErrorish {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Everything known about why one message could not be taken in.
 *
 * The old form was the bare `e.message`, which is how "3 failed to store"
 * reached the alert banner describing three Gmail *fetch* 404s. A failure
 * report has to name the phase (we did not even reach the database), the
 * message (so it can be looked at), and the real cause (a Postgres code, not
 * a prose summary of one).
 */
function describeFailure(phase: "fetch" | "store", id: string, e: unknown): string {
  if (e instanceof GmailApiError) {
    return `[${phase} ${id}] Gmail ${e.status}${e.reason ? ` (${e.reason})` : ""}: ${e.message}`;
  }
  const pg = e as Partial<PostgresErrorish>;
  if (pg && typeof pg === "object" && typeof pg.message === "string" && pg.code) {
    return describePostgresFailure(phase, id, pg as PostgresErrorish);
  }
  return `[${phase} ${id}] ${e instanceof Error ? e.message : String(e)}`;
}

/**
 * A Postgres failure, with the parts that identify it.
 *
 * `code` is the one field worth acting on — 42703 is a missing column and
 * means a migration was not run, 23505 is a duplicate, 42501 is RLS. Reading
 * only `.message` throws away the difference between "run migration 0016" and
 * "this is fine, we already have it".
 */
function describePostgresFailure(
  phase: "fetch" | "store",
  id: string,
  e: PostgresErrorish
): string {
  const parts = [`[${phase} ${id}] Postgres ${e.code}: ${e.message}`];
  if (e.details) parts.push(`details: ${e.details}`);
  if (e.hint) parts.push(`hint: ${e.hint}`);
  return parts.join(" — ");
}

/** Records a failure in the result AND in the log, with its full cause. */
function countFailure(
  result: SyncResult,
  phase: FailurePhase,
  id: string,
  e: unknown
) {
  const described = describeFailure(phase, id, e);
  result.failures.push(described);
  result.failedMessages.push({ id, phase, error: described });
  console.error(`[inbound] ${described}`);
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
 * Addresses we forward through and therefore trust, from
 * TRUSTED_FORWARD_ADDRESSES.
 *
 * support@ is a Google Group with hello@ as a member, so customer mail sent
 * to support@ reaches us stamped with List-Id, List-Unsubscribe,
 * Mailing-list and Precedence: list. Those are the newsletter markers, and
 * the guard was discarding real customers as bulk mail.
 */
export const parseTrustedForwarders = parseIgnoredSenders;

/** List-Id for a group address: support@example.com → support.example.com */
function listIdForms(address: string): string[] {
  return [address, address.replace("@", ".")];
}

/**
 * Did this message reach us through an address we forward from?
 *
 * Checked across every header that records the delivery path, because
 * different forwarders populate different ones: Google Groups sets List-Id
 * and Delivered-To, plain forwarding sets X-Forwarded-To, some MTAs set
 * X-Original-To, and the group address is usually still visible in To/Cc.
 */
export function viaTrustedForwarder(
  // fromEmail is optional: it is one signal among several, and the existing
  // callers that test the delivery headers alone are still valid.
  parsed: Pick<ParsedEmail, "deliveredTo" | "toEmails" | "ccEmails" | "listId"> &
    Partial<Pick<ParsedEmail, "fromEmail">>,
  trusted: Set<string>
): string | null {
  if (!trusted.size) return null;

  // The strongest evidence of all: the list rewrote From to its own address,
  // which only the list itself can do. Checked first because the delivery
  // headers vary — Groups sets To and Delivered-To, plain forwarding sets
  // neither — and a message that reached us THROUGH a declared forwarder
  // should not then be judged as bulk mail from a stranger.
  const from = parsed.fromEmail?.toLowerCase();
  if (from && trusted.has(from)) return from;

  for (const address of [
    ...parsed.deliveredTo,
    ...parsed.toEmails,
    ...parsed.ccEmails,
  ]) {
    if (trusted.has(address.toLowerCase())) return address.toLowerCase();
  }

  if (parsed.listId) {
    const listId = parsed.listId.replace(/[<>]/g, "").trim().toLowerCase();
    for (const address of trusted) {
      if (listIdForms(address).includes(listId)) return address;
    }
  }

  return null;
}

export interface InboundDrop {
  /** Stable identifier for the rule, used in logs and skip counts. */
  rule:
    | "no-sender"
    | "automated"
    | "own-address"
    | "ignored-sender"
    | "bulk-mail";
  detail: string;
}

export interface GuardContext {
  ourAddresses: Set<string>;
  ignoredSenders: Set<string>;
  trustedForwarders: Set<string>;
  /**
   * Domains nobody should ever get a ticket for, WITHOUT the leading @.
   *
   * Separate from ignoredSenders because cold outreach rotates the local part
   * — six addresses from one sending platform in a fortnight — while the
   * sending domain stays put. Matching subdomains too, for the same reason.
   */
  ignoredDomains?: Set<string>;
}

/**
 * Decides whether an inbound message should be discarded, and why.
 *
 * Pure, so the rules can be tested without a mailbox. Order matters: the
 * automation and internal-sender rules protect against genuine mail loops and
 * are never suppressed. Only the bulk-mail rule yields to a trusted
 * forwarder, because only that rule misfires on forwarded customer mail.
 *
 * Every sender comparison uses the parsed From address alone. Sender and
 * Return-Path are deliberately NOT consulted: a Google Group rewrites both to
 * the group address, and support@ is in IGNORED_SENDER_EMAILS, so matching
 * them would discard group mail a second way.
 */
export function effectiveSender(
  parsed: Pick<ParsedEmail, "fromEmail" | "originalSender">,
  trustedForwarders: Set<string>
): string | null {
  const from = parsed.fromEmail?.toLowerCase() ?? null;
  if (!from) return null;

  /**
   * A GROUP REWRITE IS NOT AN INTERNAL SENDER.
   *
   * Google Groups replaces From with the group address, so a customer writing
   * to support@ arrives as if support@ had written it. support@ is both in
   * our own-addresses set and in IGNORED_SENDER_EMAILS, so every one of those
   * messages was being discarded as our own mail — which is exactly what
   * happened in production, silently, for as long as the group has existed.
   *
   * The substitution is deliberately narrow: only when From is an address we
   * already declared a trusted forwarder, and only using the author the list
   * software itself recorded. Anything else and this would become a way to
   * bypass loop protection by setting one header.
   */
  if (trustedForwarders.has(from) && parsed.originalSender) {
    return parsed.originalSender.toLowerCase();
  }
  return from;
}

/**
 * The message as it should be FILED, with a group rewrite undone.
 *
 * The guards decide whether to keep it; this decides who it is from. Without
 * it every customer who wrote via the group would be upserted as the single
 * customer "support@blankssportsnutrition.com", and their tickets would all
 * thread together into one conversation.
 *
 * Groups also rewrites the display name to "'Jane Doe' via support"; the
 * author's real name is recovered from it so the ticket reads as a person.
 */
export function resolveAuthor(
  parsed: ParsedEmail,
  trustedForwarders: Set<string>
): ParsedEmail {
  const resolved = effectiveSender(parsed, trustedForwarders);
  if (!resolved || resolved === parsed.fromEmail?.toLowerCase()) return parsed;

  const viaName = /^'?(.+?)'? via .+$/.exec(parsed.fromName ?? "");
  return {
    ...parsed,
    fromEmail: resolved,
    fromName: viaName ? viaName[1] : (parsed.fromName ?? null),
  };
}

export function evaluateInboundGuards(
  parsed: ParsedEmail,
  ctx: GuardContext
): InboundDrop | null {
  if (!parsed.fromEmail) {
    return { rule: "no-sender", detail: "no parseable From address" };
  }

  // Checked BEFORE any sender logic: our own notifications carry these, and
  // they must be dropped whatever their headers claim about authorship.
  if (parsed.autoReplyReason) {
    return { rule: "automated", detail: parsed.autoReplyReason };
  }

  const from = effectiveSender(parsed, ctx.trustedForwarders) ?? "";
  if (ctx.ourAddresses.has(from)) {
    return { rule: "own-address", detail: from };
  }
  if (ctx.ignoredSenders.has(from)) {
    return { rule: "ignored-sender", detail: from };
  }
  const fromDomain = from.slice(from.lastIndexOf("@") + 1);
  for (const domain of ctx.ignoredDomains ?? []) {
    if (fromDomain === domain || fromDomain.endsWith(`.${domain}`)) {
      return { rule: "ignored-sender", detail: `@${domain} (${from})` };
    }
  }

  if (parsed.listReason) {
    const forwarder = viaTrustedForwarder(parsed, ctx.trustedForwarders);
    if (!forwarder) {
      return { rule: "bulk-mail", detail: parsed.listReason };
    }
  }

  return null;
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

/**
 * Anything larger is left in Gmail rather than copied into storage.
 *
 * The same cap the widget enforces, from the same constant — an emailed photo
 * and an uploaded one are the same photo, and two limits that mean the same
 * thing eventually disagree.
 */
const MAX_ATTACHMENT_BYTES = MAX_FILE_BYTES;

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
export async function storeInboundAttachments(
  accessToken: string,
  parsed: ParsedEmail,
  ticketId: string,
  messageId: string,
  result: SyncResult
): Promise<void> {
  const admin = createAdminClient();

  for (const attachment of parsed.attachments) {
    // Only genuinely embedded parts are skipped — ones the HTML body points at
    // with cid:. See isReferencedByBody: trusting the sender's own "inline"
    // label is what dropped every photo emailed from an iPhone.
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
      let bytes = Buffer.from(data.data, "base64url");
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        // Gmail's declared part size is a claim; this is the real one.
        countSkip(result, "attachment too large");
        continue;
      }

      // Content decides the type, not the sender's Content-Type header —
      // same rule as the widget. A recognised image is also stripped of its
      // metadata: a photo emailed in carries the same GPS as one uploaded.
      const sniffed = sniffFileType(new Uint8Array(bytes));
      let mimeType = attachment.mimeType;

      if (sniffed) {
        mimeType = sniffed.kind;
        const stripped = stripMetadata(sniffed.kind, new Uint8Array(bytes));
        if (!stripped.ok) {
          // Fail closed on THIS attachment only. The message and every other
          // attachment still land — losing one photo is bad, losing the
          // customer's whole email because of it is worse.
          countSkip(result, `attachment metadata unreadable (${stripped.reason})`);
          continue;
        }
        bytes = Buffer.from(stripped.bytes);
      }
      // An unrecognised type is still stored. Email legitimately carries a
      // wholesale order CSV or a signed PDF form, and the bucket is private,
      // size-capped and only ever read through a signed URL by an agent.

      const path = `${ticketId}/${messageId}/${safeFilename(attachment.filename)}`;
      const { error: uploadError } = await admin.storage
        .from("attachments")
        .upload(path, bytes, {
          // Stored NEUTRAL when we could not identify the bytes, so a
          // direct fetch of a signed URL has nothing to render even if the
          // sender labelled it text/html. The row keeps the declared type
          // for display; the bucket does not.
          contentType: storageContentType(sniffed ? sniffed.kind : null),
          upsert: true,
        });
      if (uploadError) {
        countSkip(result, `attachment upload failed (${uploadError.message})`);
        continue;
      }

      await admin.from("attachments").insert({
        message_id: messageId,
        filename: attachment.filename.slice(0, 200),
        mime_type: mimeType,
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
      // The same swallow as the message insert below, one level up: a failed
      // ticket INSERT is the system broken, not a guard doing its job. It was
      // counted as a skip, so a missing column here read as "nothing new".
      countFailure(
        result,
        "store",
        parsed.gmailMessageId ?? "?",
        error ?? new Error("ticket insert returned no row")
      );
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
      reply_to_email: parsed.replyToEmail,
      // Kept because it is evidence the vendor classifier needs later: a bulk
      // header that survived the guard means this arrived through the group.
      bulk_marker: parsed.listReason,
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
    // NOT a skip. This is the swallow that let a schema error read as an
    // empty mailbox: counted quietly alongside deliberate drops, cursor
    // advanced, message gone for good.
    countFailure(result, "store", parsed.gmailMessageId ?? "?", insertError);
    return null;
  }

  if (!ticketId || !inserted) {
    countSkip(result, "could not resolve ticket");
    return null;
  }

  // The evidence the quarantine guard reads: a row went in, so the database
  // accepts writes and the schema is right.
  result.storedMessages++;

  if (parsed.attachments.length) {
    await storeInboundAttachments(accessToken, parsed, ticketId, inserted.id, result);
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

  // Routing. A new ticket fires ticket_created; anything appended to an
  // existing one is a customer reply. Runs after the message is stored, so a
  // body condition sees the mail that just arrived.
  const rules = await runRulesSafely(
    ticketId,
    path === "new" ? "ticket_created" : "message_received"
  );

  // Only for a genuinely new ticket. A reply on an existing thread is not
  // news to the watchers, and mailing them about every customer response
  // would be the fastest possible way to get this feature turned off.
  if (path === "new") await notifyNewTicketSafely(ticketId);

  // Advisory only, and last: it reads the attachments and the customer
  // history, so it has to run after both exist. Nothing downstream acts on
  // the result — it puts a sentence in front of a human.
  await assessTicketRisk(ticketId);
  for (const rule of rules.fired) {
    // Surfaced in the same skip/count summary "Check mail now" already shows,
    // so a rule firing on inbound mail isn't invisible until someone opens the
    // ticket.
    result.ruleHits[rule.name] = (result.ruleHits[rule.name] ?? 0) + 1;
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
      // Collected per RECORD, not flattened, because the cursor may only ever
      // be moved to a record boundary.
      //
      // The old code flattened, sliced to `max`, and advanced the cursor to
      // `page.historyId` — which is the MAILBOX's current history id, not the
      // end of what was read. A backlog bigger than one run therefore lost
      // everything past the first 25 ids: the cursor jumped to the head, and
      // the next sync correctly reported nothing new. Silent, total, and
      // invisible in the tickets table.
      const records: { historyId: string | null; ids: string[] }[] = [];
      let pageToken: string | undefined;
      let mailboxHead: string | null = null;
      let collected = 0;

      do {
        const page = await listGmailHistory(accessToken, lastHistoryId, pageToken);
        for (const entry of page.history ?? []) {
          const ids = (entry.messagesAdded ?? []).map((added) => added.message.id);
          if (!ids.length) continue;
          records.push({ historyId: entry.id ?? null, ids });
          collected += ids.length;
        }
        mailboxHead = page.historyId ?? mailboxHead;
        pageToken = page.nextPageToken;
      } while (pageToken && collected < max);

      const ids: string[] = [];
      let lastConsumed: string | null = null;
      let truncated = Boolean(pageToken);

      for (const record of records) {
        // Whole records only. Splitting one would leave no id to resume from,
        // and `max` is a soft cap on work per run — not a correctness bound.
        if (ids.length >= max) {
          truncated = true;
          break;
        }
        ids.push(...record.ids);
        lastConsumed = record.historyId ?? lastConsumed;
      }

      return {
        ids,
        // Only claim the mailbox head when the whole feed was consumed. A
        // truncated run resumes from the last record it actually read, and a
        // record with no id at all leaves the cursor where it was — standing
        // still is recoverable, skipping ahead is not.
        historyId: truncated ? lastConsumed : mailboxHead ?? lastConsumed,
        usedFallback: false,
      };
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

/**
 * Decides which of this run's failures we stop retrying, and removes them from
 * `failures` so they no longer hold the cursor.
 *
 * Runs BEFORE the cursor decision, which is the whole ordering that matters:
 * a message quarantined here is one the cursor is now allowed to move past.
 */
async function applyQuarantine(
  result: SyncResult,
  evidence: { fetched: number; stored: number }
): Promise<void> {
  if (!result.failedMessages.length) return;

  const givenUp: { id: string; error: string }[] = [];

  for (const failure of result.failedMessages) {
    if (failure.id === "?") continue; // no id to key on; retried as normal
    const attempts = await recordAttempt(failure.id, failure.phase, failure.error);
    // A quarantine bookkeeping failure must never quarantine anything. The
    // message keeps holding the cursor, which is the conservative outcome.
    if (attempts === null) continue;

    const verdict = shouldQuarantine({ attempts, phase: failure.phase, evidence });
    if (!verdict.quarantine) {
      console.info(`[inbound] ${failure.id} still retrying — ${verdict.reason}`);
      continue;
    }
    if (await quarantineMessage(failure.id, verdict.reason)) {
      givenUp.push({ id: failure.id, error: failure.error });
    }
  }

  if (!givenUp.length) return;

  const abandoned = new Set(givenUp.map((g) => g.id));
  result.quarantined = [...abandoned];
  // Dropped from `failures` so the cursor may advance past them; kept as a
  // named skip so the run still reports that mail was discarded rather than
  // absent.
  result.failures = result.failedMessages
    .filter((f) => !abandoned.has(f.id))
    .map((f) => f.error);
  result.skipped.quarantined = (result.skipped.quarantined ?? 0) + abandoned.size;

  await alertOnQuarantine(givenUp);
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
  const trustedForwarders = parseTrustedForwarders(
    process.env.TRUSTED_FORWARD_ADDRESSES
  );
  // Env ∪ the ignored_senders table. A failed read of the table falls back to
  // the env entries and says so — letting vendor noise through is visible and
  // recoverable, whereas failing the other way would discard customers.
  const { list: ignoreList, error: ignoreError } = await loadIgnoreList();
  if (ignoreError) {
    // Reported, but NOT a message-level failure: holding the cursor back for
    // this would stall customer mail over a list that only suppresses vendor
    // noise. The env entries still apply, so nothing gets worse than it was
    // before the table existed.
    console.error("[inbound] ignore list unavailable:", ignoreError);
    result.error = `The sender ignore list could not be read (${ignoreError}) — vendor mail may create tickets until it is.`;
  }

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

  // Messages we have already given up on. A failed lookup returns null and is
  // treated as "assume everything is quarantined" for this run rather than
  // "nothing is" — putting every poisoned id back in front of the cursor on
  // the one run where the database is already unhappy is how the channel
  // re-blocks itself.
  const quarantined = await loadQuarantinedIds(pending);
  if (quarantined === null) {
    result.error =
      "The quarantine list could not be read, so this run was skipped rather than risk re-blocking on messages already given up on.";
    return result;
  }

  // Evidence for the quarantine guard: what this run proved about the SYSTEM,
  // as opposed to about any one message.
  let fetched = 0;

  for (const id of pending) {
    if (quarantined.has(id)) {
      countSkip(result, "quarantined");
      continue;
    }
    result.checked++;

    // Fetch and store are separate phases with separate failure meanings, and
    // one try around both is what let a Gmail 404 be reported as a store
    // failure. Splitting them is not tidiness: the two need opposite cursor
    // behaviour.
    let raw;
    try {
      raw = await getGmailMessage(accessToken, id);
    } catch (e) {
      if (isGoneFromMailbox(e)) {
        // Counted as a skip, because that is what it is: the message was
        // considered and cannot be read. It must NOT hold the cursor.
        countSkip(result, "no longer in the mailbox");
        console.info(`[inbound] ${id} is gone from the mailbox (Gmail 404) — skipped permanently`);
        continue;
      }
      countFailure(result, "fetch", id, e);
      continue;
    }
    fetched++;

    try {
      const parsed = parseGmailMessage(raw);

      const drop = evaluateInboundGuards(parsed, {
        ourAddresses,
        ignoredSenders: ignoreList.addresses,
        ignoredDomains: ignoreList.domains,
        trustedForwarders,
      });
      if (drop) {
        // Named rule plus the specific reason, so a wrongly-dropped message
        // can be traced to the rule that dropped it rather than guessed at.
        countSkip(result, `${drop.rule} (${drop.detail})`);
        console.info(
          `[inbound] dropped ${id} by rule=${drop.rule} detail="${drop.detail}" from=${parsed.fromEmail ?? "?"}`
        );
        continue;
      }

      // Filed under the real author, not the mailing list that relayed it.
      await ingestMessage(
        accessToken,
        resolveAuthor(parsed, trustedForwarders),
        result
      );
    } catch (e) {
      countFailure(result, "store", id, e);
    }
  }

  await applyQuarantine(result, { fetched, stored: result.storedMessages });

  // Advance the cursor only after the batch is processed, so a crash mid-run
  // re-reads those messages rather than losing them. Re-reading is safe — the
  // gmail_message_id unique index dedupes.
  //
  // AND ONLY IF NOTHING FAILED TO STORE. Advancing past a message we could not
  // write is what turns a transient error into permanent loss: the next sync
  // starts after it, Gmail reports nothing new, and the mailbox looks empty
  // forever. A deliberate guard drop is different — that message was
  // considered and rejected, so the cursor should move past it.
  if (collected.historyId && !result.failures.length) {
    await setLastHistoryId(connection.id, collected.historyId);
  }

  if (result.failures.length) {
    result.error = `${result.failures.length} message(s) failed and are RETRYABLE — the sync cursor was held back so they are tried again, which also holds every message behind them. First: ${result.failures[0]}`;
  }

  return result;
}


/** One mailbox message, as the guards and the author resolver judge it. */
export interface BackfillCandidate {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  /** null when it would be ingested; otherwise the rule that drops it. */
  droppedBy: string | null;
  alreadyStored: boolean;
}

export interface BackfillReport {
  candidates: BackfillCandidate[];
  ingested: number;
  result: SyncResult;
}

/**
 * Re-reads the mailbox and re-judges old messages against the CURRENT guard.
 *
 * Needed because the sync is cursor-driven: mail the broken guard discarded
 * is behind `last_history_id` forever, so fixing the guard does not bring it
 * back. Deliberately does NOT touch the cursor — a backfill is a repair of
 * the past and must not move where the live sync resumes.
 *
 * Dry by default. `apply` requires an explicit `ids` allowlist, so a run can
 * never sweep in more than was reviewed: the dry run IS the review, and the
 * ids are how its verdict is carried to the write.
 *
 * Everything below the fetch is the live path — the same
 * `evaluateInboundGuards`, `resolveAuthor` and `ingestMessage` the sync uses
 * — so a dry run that says "keep" and an apply that stores something else
 * cannot disagree.
 */
export async function backfillFromMailbox(options: {
  query?: string;
  max?: number;
  apply?: boolean;
  ids?: string[];
}): Promise<BackfillReport> {
  const result = emptyResult();
  const apply = options.apply === true;
  const allowlist = options.ids?.length ? new Set(options.ids) : null;
  if (apply && !allowlist) {
    throw new Error("backfillFromMailbox: apply requires an explicit ids allowlist");
  }

  const connection = await getSupportInboxConnection();
  if (!connection) {
    return { candidates: [], ingested: 0, result: { ...result, error: "No support mailbox connected." } };
  }
  const accessToken = await getAccessToken(connection.id);

  const listed = await listGmailMessages(
    accessToken,
    options.query ?? "in:anywhere -in:sent -in:chats",
    options.max ?? 200
  );
  const ids = [...new Set((listed.messages ?? []).map((m) => m.id))];

  const admin = createAdminClient();
  const { data: known } = await admin
    .from("messages")
    .select("gmail_message_id")
    .in("gmail_message_id", ids);
  const stored = new Set((known ?? []).map((m) => m.gmail_message_id));

  const ourAddresses = await ourOwnAddresses(connection.account_ref);
  const trustedForwarders = parseTrustedForwarders(process.env.TRUSTED_FORWARD_ADDRESSES);
  const { list: ignoreList } = await loadIgnoreList();

  const candidates: BackfillCandidate[] = [];
  let ingested = 0;

  for (const id of ids) {
    if (allowlist && !allowlist.has(id)) continue;

    // Already-stored ids are reported without a fetch. Re-reading them would
    // triple the API calls to re-derive a verdict the unique index already
    // enforces, and a backfill that takes minutes is one nobody runs.
    if (stored.has(id)) {
      candidates.push({
        id,
        fromEmail: null,
        fromName: null,
        subject: "",
        droppedBy: null,
        alreadyStored: true,
      });
      continue;
    }

    // Unguarded, this threw out of the whole backfill on the first message
    // that had been deleted since — and a backfill re-reads OLD mail, which is
    // where deleted messages live. One 404 abandoned every id after it.
    let raw;
    try {
      raw = await getGmailMessage(accessToken, id);
    } catch (e) {
      if (isGoneFromMailbox(e)) {
        countSkip(result, "no longer in the mailbox");
        continue;
      }
      countFailure(result, "fetch", id, e);
      continue;
    }

    const parsed = parseGmailMessage(raw);
    const drop = evaluateInboundGuards(parsed, {
      ourAddresses,
      ignoredSenders: ignoreList.addresses,
      ignoredDomains: ignoreList.domains,
      trustedForwarders,
    });
    const author = drop ? parsed : resolveAuthor(parsed, trustedForwarders);

    candidates.push({
      id,
      fromEmail: author.fromEmail,
      fromName: author.fromName,
      subject: author.subject,
      droppedBy: drop ? `${drop.rule} (${drop.detail})` : null,
      alreadyStored: false,
    });

    if (!apply || drop) continue;

    result.checked++;
    try {
      await ingestMessage(accessToken, author, result);
      ingested++;
    } catch (e) {
      countFailure(result, "store", id, e);
    }
  }

  return { candidates, ingested, result };
}

/** Floor between automatic syncs. Manual "Check mail now" ignores it. */
export const SYNC_MIN_INTERVAL_MS = 60_000;

const LAST_SYNC_KEY = "inbound_last_sync_at";

/**
 * Sync unless one ran very recently.
 *
 * The throttle is GLOBAL rather than per-user, which is a deliberate
 * deviation from the spec: the mailbox is one shared resource, so N agents
 * opening the dashboard should not mean N syncs a minute against Gmail's
 * quota. The stamp lives in the settings row so it is shared across serverless
 * instances, which an in-memory guard would not be.
 *
 * Since Pub/Sub push went live this is a safety net, not the mechanism — it is
 * what covers a lapsed watch or a dropped notification.
 */
export async function syncSupportMailboxThrottled(
  minIntervalMs = SYNC_MIN_INTERVAL_MS
): Promise<SyncResult & { throttled?: boolean }> {
  let lastSyncAt: number | null = null;
  try {
    const blob = await getSettingsBlob();
    const stored = blob[LAST_SYNC_KEY];
    if (typeof stored === "string") lastSyncAt = new Date(stored).getTime();
  } catch (e) {
    // A missing settings table is reported by the schema banner; don't let it
    // stop the sync, which doesn't otherwise need that row.
    console.error("[inbound] could not read the sync stamp:", e);
  }

  if (lastSyncAt && Date.now() - lastSyncAt < minIntervalMs) {
    return { ...emptyResult(), throttled: true };
  }

  const result = await syncSupportMailbox();

  // Stamped even on failure, so a persistently broken sync can't be retried
  // on every dashboard load by every agent.
  //
  // The skip and failure counts ride along so the hourly heartbeat can tell
  // "the mailbox was quiet" from "mail arrived and we discarded all of it".
  // Those look identical from the tickets table, and the second one is what
  // silently ate every message forwarded through the support@ group.
  try {
    await patchSettingsBlob({
      [LAST_SYNC_KEY]: new Date().toISOString(),
      inbound_last_sync_skipped: result.skipped,
      inbound_last_sync_failures: result.failures,
    });
  } catch (e) {
    console.error("[inbound] could not write the sync stamp:", e);
  }

  return result;
}
