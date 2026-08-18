import { decodeEntities } from "@/lib/html";
import type { GmailMessage, GmailPart } from "@/lib/google/gmail";

// Turns a Gmail API message into the fields a ticket needs.
// Pure functions over the payload tree — no network, no database.

export interface ParsedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * True ONLY when the HTML body actually references this part by `cid:`.
   *
   * Not "the sender said inline". Apple Mail and iOS Mail stamp BOTH
   * Content-Disposition: inline AND a Content-ID on ordinary photo
   * attachments, because they show them inline while composing. Trusting
   * either header meant every photo emailed from an iPhone was classified as
   * a signature logo and silently dropped.
   */
  inline: boolean;
  /** Raw Content-ID, kept so inline-ness can be resolved once the HTML is known. */
  contentId: string | null;
}

export interface ParsedEmail {
  gmailMessageId: string;
  gmailThreadId: string;
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string | null;
  fromName: string | null;
  toEmails: string[];
  subject: string;
  date: Date;
  bodyText: string;
  bodyHtml: string | null;
  ccEmails: string[];
  /** Delivered-To / X-Forwarded-To / X-Original-To, lowercased addresses. */
  deliveredTo: string[];
  /** Raw List-Id value, if the message carries one. */
  listId: string | null;
  attachments: ParsedAttachment[];
  /** Set when the message is machine-generated. Always a drop. */
  autoReplyReason: string | null;
  /** Set when the message carries mailing-list headers. Drop UNLESS it
   *  arrived via a trusted forwarder. */
  listReason: string | null;
}

function headerValues(part: GmailPart | undefined, name: string): string[] {
  const target = name.toLowerCase();
  return (part?.headers ?? [])
    .filter((h) => h.name.toLowerCase() === target)
    .map((h) => h.value);
}

function headerValue(part: GmailPart | undefined, name: string): string | null {
  const target = name.toLowerCase();
  const found = part?.headers?.find((h) => h.name.toLowerCase() === target);
  return found?.value ?? null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/** Walks the MIME tree depth-first. */
function* walkParts(part: GmailPart | undefined): Generator<GmailPart> {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) yield* walkParts(child);
}

/**
 * `"Jane Doe" <jane@example.com>` → name + address.
 * Handles RFC 2047 encoded display names well enough to be useful.
 */
export function parseAddress(value: string | null): {
  name: string | null;
  email: string | null;
} {
  if (!value) return { name: null, email: null };

  const angled = /<([^>]+)>/.exec(value);
  const email = (angled ? angled[1] : value).trim().toLowerCase() || null;

  let name: string | null = null;
  if (angled) {
    name = value.slice(0, angled.index).trim().replace(/^"|"$/g, "").trim() || null;
    if (name) name = decodeEncodedWords(name);
  }

  return {
    name,
    email: email && /^[^@\s]+@[^@\s]+$/.test(email) ? email : null,
  };
}

/** Decodes RFC 2047 `=?UTF-8?B?…?=` / `=?UTF-8?Q?…?=` words. */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, text: string) => {
      try {
        if (encoding.toUpperCase() === "B") {
          return Buffer.from(text, "base64").toString("utf8");
        }
        // Quoted-printable: _ is a space, =XX is a byte.
        const bytes = text
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
            String.fromCharCode(parseInt(hex, 16))
          );
        return Buffer.from(bytes, "binary").toString("utf8");
      } catch {
        return whole;
      }
    }
  );
}

/** Splits `References:` into individual message ids. */
function parseReferences(value: string | null): string[] {
  if (!value) return [];
  return value.match(/<[^>\s]+>/g) ?? [];
}

/** Crude but effective HTML → text, for messages with no text/plain part. */
function htmlPartToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      // Blocks get a blank line, matching htmlToPlainText; rows and list
      // items get a single break so lists don't come out double-spaced.
      .replace(/<\/(p|div|blockquote|h[1-6])>/gi, "\n\n")
      .replace(/<\/(tr|li)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Headers that mark a message as MACHINE-GENERATED — an out-of-office, a
 * bounce, an autoresponder. Replying to one of these is how a support inbox
 * and a vacation responder loop forever, so this always drops, no exceptions.
 */
function detectAutoReply(payload: GmailPart | undefined): string | null {
  const autoSubmitted = headerValue(payload, "Auto-Submitted");
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
    return `Auto-Submitted: ${autoSubmitted}`;
  }
  if (headerValue(payload, "X-Autoreply")) return "X-Autoreply";
  if (headerValue(payload, "X-Autorespond")) return "X-Autorespond";
  if (headerValue(payload, "X-Blanks-Notification")) return "X-Blanks-Notification";

  const failedRecipients = headerValue(payload, "X-Failed-Recipients");
  if (failedRecipients) return "X-Failed-Recipients (bounce)";

  const precedence = headerValue(payload, "Precedence")?.toLowerCase();
  if (precedence === "auto_reply") return "Precedence: auto_reply";

  return null;
}

/**
 * Headers that mark a message as BULK — a newsletter, a mailing list.
 *
 * Kept separate from auto-reply detection because a Google Group stamps all
 * of these on ordinary customer mail it forwards. Treating them as automation
 * meant every message reaching hello@ through the support@ group was silently
 * discarded as if it were a newsletter. A trusted forwarder suppresses this
 * rule; it never suppresses the automation rule above.
 */
function detectBulkMail(payload: GmailPart | undefined): string | null {
  if (headerValue(payload, "List-Unsubscribe")) return "List-Unsubscribe";

  const listId = headerValue(payload, "List-Id");
  if (listId) return `List-Id: ${listId.trim()}`;

  if (headerValue(payload, "Mailing-list")) return "Mailing-list";

  const precedence = headerValue(payload, "Precedence")?.toLowerCase();
  if (precedence && ["bulk", "list", "junk"].includes(precedence)) {
    return `Precedence: ${precedence}`;
  }

  return null;
}

/**
 * Everything indicating how the message reached this mailbox. Used to decide
 * whether a bulk-looking message actually arrived through a group we trust.
 */
function deliveryPaths(payload: GmailPart | undefined): string[] {
  const raw = [
    ...headerValues(payload, "Delivered-To"),
    ...headerValues(payload, "X-Forwarded-To"),
    ...headerValues(payload, "X-Original-To"),
  ];
  return raw
    .flatMap((value) => value.split(","))
    .map((entry) => parseAddress(entry).email)
    .filter((email): email is string => Boolean(email));
}

/**
 * Is this part actually embedded in the message body?
 *
 * The only honest test: something in the HTML has to reference its Content-ID
 * with a `cid:` URL. A logo in a signature does; a photo of a damaged tub does
 * not, however the sending client chose to label it.
 *
 * Exported so the behaviour is testable directly — it is the decision that
 * silently threw away every emailed photo.
 */
export function isReferencedByBody(
  attachment: Pick<ParsedAttachment, "contentId">,
  bodyHtml: string | null,
  explicitlyAttachment = false
): boolean {
  if (explicitlyAttachment) return false;
  if (!attachment.contentId || !bodyHtml) return false;

  // cid references appear as src="cid:x", url(cid:x), and unquoted. Matching
  // the id after `cid:` covers all of them without parsing the HTML.
  const id = attachment.contentId.toLowerCase();
  const html = bodyHtml.toLowerCase();
  const at = html.indexOf(`cid:${id}`);
  if (at === -1) return false;

  // Guard against a prefix match: cid:logo must not match a part whose id is
  // `logo2`, which would drop a real attachment again for a subtler reason.
  const nextChar = html[at + 4 + id.length];
  return nextChar === undefined || !/[a-z0-9._%+-]/.test(nextChar);
}

export function parseGmailMessage(message: GmailMessage): ParsedEmail {
  const payload = message.payload;

  let bodyText = "";
  let bodyHtml: string | null = null;
  const attachments: ParsedAttachment[] = [];

  // Two passes, because inline-ness cannot be decided while walking: it
  // depends on the HTML body, and MIME order does not guarantee the HTML has
  // been seen by the time an attachment part is.
  const forcedAttachment = new Set<string>();

  for (const part of walkParts(payload)) {
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = part.filename ?? "";

    // A part with a filename is an attachment even when its type is text/*.
    if (filename && part.body?.attachmentId) {
      const contentId = headerValue(part, "Content-ID");
      const disposition = (headerValue(part, "Content-Disposition") ?? "").toLowerCase();
      // An explicit `attachment` disposition settles it — nothing referenced
      // by the body is ever labelled that.
      if (disposition.startsWith("attachment")) {
        forcedAttachment.add(part.body.attachmentId);
      }
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename,
        mimeType: mime || "application/octet-stream",
        sizeBytes: part.body.size ?? 0,
        // Resolved below, once the HTML is known.
        inline: false,
        contentId: contentId ? contentId.replace(/[<>]/g, "").trim() : null,
      });
      continue;
    }

    if (!part.body?.data) continue;
    // Prefer the first text/plain part; keep the first text/html as a fallback
    // and for future rendering.
    if (mime === "text/plain" && !bodyText) {
      bodyText = decodeBase64Url(part.body.data);
    } else if (mime === "text/html" && !bodyHtml) {
      bodyHtml = decodeBase64Url(part.body.data);
    }
  }

  // Pass two: a part is inline only if the body actually points at it.
  //
  // This is the whole fix for "emailed photos never arrive". The old test was
  // "does it have a Content-ID, or does the sender call it inline" — and every
  // mail client that previews images while composing says yes to both for a
  // perfectly ordinary attachment.
  for (const attachment of attachments) {
    attachment.inline = isReferencedByBody(
      attachment,
      bodyHtml,
      forcedAttachment.has(attachment.attachmentId)
    );
  }

  if (!bodyText && bodyHtml) bodyText = htmlPartToText(bodyHtml);
  if (!bodyText) bodyText = message.snippet ?? "";

  const from = parseAddress(headerValue(payload, "From"));
  const addresses = (header: string) =>
    (headerValue(payload, header) ?? "")
      .split(",")
      .map((entry) => parseAddress(entry).email)
      .filter((email): email is string => Boolean(email));

  const to = addresses("To");
  const cc = addresses("Cc");

  const internal = Number(message.internalDate);

  return {
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    rfc822MessageId: headerValue(payload, "Message-ID"),
    inReplyTo: parseReferences(headerValue(payload, "In-Reply-To"))[0] ?? null,
    references: parseReferences(headerValue(payload, "References")),
    fromEmail: from.email,
    fromName: from.name,
    toEmails: to,
    subject: decodeEncodedWords(headerValue(payload, "Subject") ?? "").trim(),
    date: Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(),
    bodyText: bodyText.replace(/\r\n/g, "\n").trim(),
    bodyHtml,
    ccEmails: cc,
    deliveredTo: deliveryPaths(payload),
    listId: headerValue(payload, "List-Id")?.trim() ?? null,
    attachments,
    autoReplyReason: detectAutoReply(payload),
    listReason: detectBulkMail(payload),
  };
}

/**
 * Splits a reply into what the person actually wrote and the history their
 * client quoted underneath. Storage keeps the whole thing; the thread view
 * collapses the quoted half.
 */
export function splitQuotedText(text: string): {
  visible: string;
  quoted: string | null;
} {
  const lines = text.split("\n");

  const markers: RegExp[] = [
    // "On Tue, 12 Aug 2026 at 10:04, Jane <j@x.com> wrote:" — may wrap, so
    // also match a line ending in "wrote:" on its own.
    /^\s*On .*(wrote|schrieb|a écrit)\s*:\s*$/i,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
    /^\s*_{10,}\s*$/,
    /^\s*-{3,}\s*Forwarded message\s*-{3,}\s*$/i,
    /^\s*From:\s*.+$/i,
    /^\s*Sent from my \w+/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (markers.some((marker) => marker.test(line))) {
      // A marker on the very first line means there's nothing above it to
      // keep — treat the whole message as visible rather than emptying it.
      if (i === 0) break;
      return {
        visible: lines.slice(0, i).join("\n").trim(),
        quoted: lines.slice(i).join("\n").trim() || null,
      };
    }

    // A run of ">" quoted lines that continues to the end of the message.
    if (/^\s*>/.test(line) && i > 0) {
      const rest = lines.slice(i);
      const quotedRatio =
        rest.filter((l) => /^\s*>/.test(l) || !l.trim()).length / rest.length;
      if (quotedRatio > 0.8) {
        return {
          visible: lines.slice(0, i).join("\n").trim(),
          quoted: rest.join("\n").trim() || null,
        };
      }
    }
  }

  return { visible: text.trim(), quoted: null };
}

/** Pulls the ticket number out of `… [BLK-1001]`. */
export function extractTicketToken(subject: string): number | null {
  const match = /\[BLK-(\d+)\]/i.exec(subject);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
