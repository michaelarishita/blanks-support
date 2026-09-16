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
 * `Re: <subject> [BLK-1001]`, or `<subject> [BLK-1001]` when this send opens
 * a brand-new email thread.
 *
 * The [BLK-n] token is what routes a customer's reply back to its ticket, so
 * it must survive round-trips: strip any existing copy before re-appending,
 * and don't stack up `Re: Re: Re:`.
 *
 * `Re:` on a message that replies to nothing is wrong and looks it — a
 * website-form ticket's first email is the start of the conversation, not a
 * reply to one.
 */
export function buildReplySubject(
  subject: string,
  ticketNumber: number,
  { newThread = false }: { newThread?: boolean } = {}
): string {
  let base = subject.replace(/\s*\[BLK-\d+\]\s*/gi, " ").trim();
  base = base.replace(/^((re|fwd?)\s*:\s*)+/i, "").trim();
  if (!base) base = "Your support request";
  return newThread ? `${base} [BLK-${ticketNumber}]` : `Re: ${base} [BLK-${ticketNumber}]`;
}

/**
 * A binary part: an inline image (referenced by the HTML via `cid:`) or a
 * downloadable attachment. The bytes are already EXIF-stripped and content-
 * sniffed upstream — this module only frames them.
 */
export interface EmailFilePart {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /**
   * Set for inline images: the Content-ID the HTML references as `cid:<id>`.
   * MUST be globally unique and namespaced (a uuid @ our domain) so that when a
   * customer quotes our message back, our `cid:` references can never collide
   * with a Content-ID on THEIR photo — which is how the inbound parser would
   * misfile it. Without brackets here; brackets are added in the header.
   */
  contentId?: string;
}

export interface EmailParts {
  fromEmail: string;
  fromName?: string | null;
  to: string;
  replyTo?: string | null;
  subject: string;
  bodyText: string;
  /** When set, the message is sent multipart/alternative (text + HTML). */
  bodyHtml?: string | null;
  /** Images embedded in the body via `cid:` → wrapped in multipart/related. */
  inlineImages?: EmailFilePart[];
  /** Files attached for download → wrapped in multipart/mixed. */
  attachments?: EmailFilePart[];
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Extra headers, e.g. the loop-protection stamps on notifications. */
  extraHeaders?: Record<string, string>;
}

/** Base64 with the 76-character line wrapping RFC 2045 requires. */
function base64Body(content: string): string {
  return (
    Buffer.from(content, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join(CRLF) ?? ""
  );
}

/** Same wrapping for raw bytes (attachments), not UTF-8 text. */
function base64Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").match(/.{1,76}/g)?.join(CRLF) ?? "";
}

/** A MIME node: its part headers and its already-encoded body. */
interface MimeNode {
  headers: string[];
  body: string;
}

function textNode(mime: string, content: string): MimeNode {
  return {
    headers: [`Content-Type: ${mime}; charset="UTF-8"`, "Content-Transfer-Encoding: base64"],
    body: base64Body(content),
  };
}

function fileNode(part: EmailFilePart, disposition: "inline" | "attachment"): MimeNode {
  const name = sanitizeHeader(part.filename).replace(/"/g, "'");
  const headers = [
    `Content-Type: ${sanitizeHeader(part.mimeType)}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: ${disposition}; filename="${name}"`,
  ];
  if (part.contentId) headers.push(`Content-ID: <${part.contentId}>`);
  return { headers, body: base64Bytes(part.bytes) };
}

/** Wraps children in a multipart/<subtype> with a collision-proof boundary. */
function multipartNode(subtype: string, children: MimeNode[]): MimeNode {
  const boundary = `=_blk_${crypto.randomBytes(16).toString("hex")}`;
  const body =
    children
      .map((c) => `--${boundary}${CRLF}${c.headers.join(CRLF)}${CRLF}${CRLF}${c.body}`)
      .join(CRLF) +
    CRLF +
    `--${boundary}--`;
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`], body };
}

/** Builds the message and base64url-encodes it for the Gmail API's `raw` field. */
export function buildRawEmail(parts: EmailParts): string {
  const headers: string[] = [
    `From: ${formatAddress(parts.fromEmail, parts.fromName && sanitizeHeader(parts.fromName))}`,
    `To: ${sanitizeHeader(parts.to)}`,
    `Subject: ${encodeHeader(sanitizeHeader(parts.subject))}`,
    `Message-ID: ${parts.messageId}`,
    "MIME-Version: 1.0",
  ];

  if (parts.replyTo) headers.splice(1, 0, `Reply-To: ${sanitizeHeader(parts.replyTo)}`);
  if (parts.inReplyTo) headers.push(`In-Reply-To: ${parts.inReplyTo}`);
  if (parts.references?.length) {
    // Fold the References chain — it grows with the conversation and a single
    // long header line is non-compliant.
    headers.push(`References: ${parts.references.join(CRLF + " ")}`);
  }
  for (const [name, value] of Object.entries(parts.extraHeaders ?? {})) {
    // Sanitized like every other header: a newline here would let a value
    // inject headers of its own.
    headers.push(`${sanitizeHeader(name)}: ${sanitizeHeader(value)}`);
  }

  const inlineImages = parts.inlineImages ?? [];
  const attachments = parts.attachments ?? [];

  // Build from the inside out:
  //   text/plain  ── the only part, when there is no HTML and nothing attached
  //   multipart/alternative[text, html]           ── when there is HTML
  //   multipart/related[alternative, inline…]      ── when images embed in the body
  //   multipart/mixed[related-or-alternative, attachment…] ── when files attach
  //
  // With neither inline images nor attachments this collapses to exactly the
  // previous output (single text/plain, or multipart/alternative), so existing
  // notification and reply mail is byte-for-byte unchanged.
  let root: MimeNode;
  if (parts.bodyHtml) {
    root = multipartNode("alternative", [
      // Least-capable part first: clients render the last they understand.
      textNode("text/plain", parts.bodyText),
      textNode("text/html", parts.bodyHtml),
    ]);
    if (inlineImages.length) {
      root = multipartNode("related", [root, ...inlineImages.map((i) => fileNode(i, "inline"))]);
    }
  } else {
    root = textNode("text/plain", parts.bodyText);
  }
  if (attachments.length) {
    root = multipartNode("mixed", [root, ...attachments.map((a) => fileNode(a, "attachment"))]);
  }

  const message = [...headers, ...root.headers].join(CRLF) + CRLF + CRLF + root.body;
  return Buffer.from(message, "utf8").toString("base64url");
}
