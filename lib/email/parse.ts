import { decodeEntities } from "@/lib/html";
import type { GmailMessage, GmailPart } from "@/lib/google/gmail";

// Turns a Gmail API message into the fields a ticket needs.
// Pure functions over the payload tree — no network, no database.

export interface ParsedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** True for images referenced by a cid: URL in the HTML body. */
  inline: boolean;
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
  attachments: ParsedAttachment[];
  /** Set when the message looks automated and must not be replied to. */
  autoReplyReason: string | null;
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
 * Headers that mark a message as machine-generated. Replying to one of these
 * is how a support inbox and an out-of-office responder end up in an infinite
 * loop, so detection is not optional.
 */
function detectAutoReply(payload: GmailPart | undefined): string | null {
  const autoSubmitted = headerValue(payload, "Auto-Submitted");
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
    return `Auto-Submitted: ${autoSubmitted}`;
  }
  if (headerValue(payload, "X-Autoreply")) return "X-Autoreply";
  if (headerValue(payload, "X-Autorespond")) return "X-Autorespond";
  if (headerValue(payload, "List-Unsubscribe")) return "List-Unsubscribe";
  if (headerValue(payload, "List-Id")) return "List-Id";

  const precedence = headerValue(payload, "Precedence")?.toLowerCase();
  if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence)) {
    return `Precedence: ${precedence}`;
  }

  const failedRecipients = headerValue(payload, "X-Failed-Recipients");
  if (failedRecipients) return "X-Failed-Recipients (bounce)";

  return null;
}

export function parseGmailMessage(message: GmailMessage): ParsedEmail {
  const payload = message.payload;

  let bodyText = "";
  let bodyHtml: string | null = null;
  const attachments: ParsedAttachment[] = [];

  for (const part of walkParts(payload)) {
    const mime = (part.mimeType ?? "").toLowerCase();
    const filename = part.filename ?? "";

    // A part with a filename is an attachment even when its type is text/*.
    if (filename && part.body?.attachmentId) {
      const contentId = headerValue(part, "Content-ID");
      const disposition = (headerValue(part, "Content-Disposition") ?? "").toLowerCase();
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename,
        mimeType: mime || "application/octet-stream",
        sizeBytes: part.body.size ?? 0,
        inline: Boolean(contentId) || disposition.startsWith("inline"),
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

  if (!bodyText && bodyHtml) bodyText = htmlPartToText(bodyHtml);
  if (!bodyText) bodyText = message.snippet ?? "";

  const from = parseAddress(headerValue(payload, "From"));
  const to = (headerValue(payload, "To") ?? "")
    .split(",")
    .map((entry) => parseAddress(entry).email)
    .filter((email): email is string => Boolean(email));

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
    attachments,
    autoReplyReason: detectAutoReply(payload),
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
