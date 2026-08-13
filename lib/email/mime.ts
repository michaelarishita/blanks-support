import crypto from "node:crypto";

// Minimal RFC 2822 message builder for outbound support replies.
// Plain text only by design — a support reply has no need for HTML, and
// skipping multipart removes a whole class of rendering bugs.

const CRLF = "\r\n";

/** Encodes a header value as an RFC 2047 encoded-word when it isn't plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Formats `Name <email>`, quoting or encoding the display name as needed. */
function formatAddress(email: string, name?: string | null): string {
  if (!name) return email;
  if (/^[\x20-\x7E]*$/.test(name)) {
    // Escape quotes/backslashes so a name like `O"Brien` can't break the header.
    return `"${name.replace(/([\\"])/g, "\\$1")}" <${email}>`;
  }
  // An encoded-word must not be wrapped in quotes.
  return `${encodeHeader(name)} <${email}>`;
}

/** Strips CR/LF so a crafted subject or name can't inject extra headers. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "blankssportsnutrition.com";
  return `<blk-${crypto.randomBytes(12).toString("hex")}@${domain}>`;
}

/**
 * `Re: <subject> [BLK-1001]`
 * The [BLK-n] token is what routes a customer's reply back to its ticket, so
 * it must survive round-trips: strip any existing copy before re-appending,
 * and don't stack up `Re: Re: Re:`.
 */
export function buildReplySubject(subject: string, ticketNumber: number): string {
  let base = subject.replace(/\s*\[BLK-\d+\]\s*/gi, " ").trim();
  base = base.replace(/^((re|fwd?)\s*:\s*)+/i, "").trim();
  if (!base) base = "Your support request";
  return `Re: ${base} [BLK-${ticketNumber}]`;
}

export interface EmailParts {
  fromEmail: string;
  fromName?: string | null;
  to: string;
  replyTo?: string | null;
  subject: string;
  bodyText: string;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
}

/** Builds the message and base64url-encodes it for the Gmail API's `raw` field. */
export function buildRawEmail(parts: EmailParts): string {
  const headers: string[] = [
    `From: ${formatAddress(parts.fromEmail, parts.fromName && sanitizeHeader(parts.fromName))}`,
    `To: ${sanitizeHeader(parts.to)}`,
    `Subject: ${encodeHeader(sanitizeHeader(parts.subject))}`,
    `Message-ID: ${parts.messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];

  if (parts.replyTo) headers.splice(1, 0, `Reply-To: ${sanitizeHeader(parts.replyTo)}`);
  if (parts.inReplyTo) headers.push(`In-Reply-To: ${parts.inReplyTo}`);
  if (parts.references?.length) {
    // Fold the References chain — it grows with the conversation and a single
    // long header line is non-compliant.
    headers.push(`References: ${parts.references.join(CRLF + " ")}`);
  }

  // Base64 body must be wrapped at 76 chars per line.
  const body =
    Buffer.from(parts.bodyText, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join(CRLF) ?? "";

  const message = headers.join(CRLF) + CRLF + CRLF + body;
  return Buffer.from(message, "utf8").toString("base64url");
}
