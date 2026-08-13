// HTML allowlist sanitizer + plain-text extraction.
//
// Agent replies are composed in a contenteditable, which means the browser
// (and anything pasted into it) decides what markup arrives. Everything that
// gets stored, rendered back into the thread, or sent as email passes through
// sanitizeRichText first.
//
// This is a real tokenizer rather than a set of regex replacements: regex
// stripping of HTML is defeated by malformed markup like `<scr<script>ipt>`
// and by attributes containing `>`. Pure string functions, so it runs on both
// the server (before storing) and the client (before rendering).

/** Tag → attributes that survive. Everything else is unwrapped or dropped. */
const ALLOWED_TAGS = new Map<string, Set<string>>([
  ["b", new Set()],
  ["strong", new Set()],
  ["i", new Set()],
  ["em", new Set()],
  ["u", new Set()],
  ["a", new Set(["href"])],
  ["ul", new Set()],
  ["ol", new Set()],
  ["li", new Set()],
  ["p", new Set()],
  ["div", new Set()],
  ["br", new Set()],
  ["blockquote", new Set()],
]);

const VOID_TAGS = new Set(["br"]);

/** These are dropped along with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "svg",
  "math",
  "head",
  "title",
]);

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * Only http(s) and mailto survive. This is the check that stops
 * `javascript:`, `data:` and vbscript: URLs becoming clickable.
 */
function safeHref(value: string): string | null {
  // Strip control characters and whitespace first — `java\tscript:` and
  // `java\0script:` are both parsed as javascript: by browsers.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x20]+/g, "").toLowerCase();
  if (/^(https?:|mailto:)/.test(cleaned)) return value.trim();
  // Protocol-relative and root-relative links are fine in-app but meaningless
  // in email, so require an absolute URL.
  return null;
}

/** Index of the `>` closing the tag that starts at `start`, quote-aware. */
function findTagEnd(input: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return i;
  }
  return -1;
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

export function sanitizeRichText(input: string): string {
  if (!input) return "";

  let out = "";
  const openTags: string[] = [];
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(input.slice(i));
      break;
    }
    out += escapeText(input.slice(i, lt));

    // Comments and doctypes: skip wholesale.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const tagEnd = findTagEnd(input, lt);
    if (tagEnd === -1) {
      // Unterminated `<` — treat the remainder as text so it can't be
      // reinterpreted as markup downstream.
      out += escapeText(input.slice(lt));
      break;
    }

    const raw = input.slice(lt + 1, tagEnd);
    const isClosing = raw.startsWith("/");
    const body = isClosing ? raw.slice(1) : raw;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body.trim());

    if (!nameMatch) {
      // Not a real tag (e.g. a stray `<` followed by punctuation).
      out += escapeText(input.slice(lt, tagEnd + 1));
      i = tagEnd + 1;
      continue;
    }

    const name = nameMatch[1].toLowerCase();
    i = tagEnd + 1;

    if (DROP_WITH_CONTENT.has(name)) {
      if (!isClosing) {
        // Skip to the matching close tag, or to the end if there isn't one.
        const closePattern = new RegExp(`<\\s*/\\s*${name}\\s*>`, "i");
        const rest = input.slice(i);
        const match = closePattern.exec(rest);
        i = match ? i + match.index + match[0].length : input.length;
      }
      continue;
    }

    const allowedAttributes = ALLOWED_TAGS.get(name);
    if (!allowedAttributes) {
      // Unknown tag: unwrap it. The text inside is still emitted, which
      // matters for markup like <span style="…">text</span>.
      continue;
    }

    if (isClosing) {
      const index = openTags.lastIndexOf(name);
      if (index !== -1) {
        // Close anything left open inside it, innermost first.
        for (let k = openTags.length - 1; k >= index; k--) {
          out += `</${openTags[k]}>`;
        }
        openTags.length = index;
      }
      continue;
    }

    let attributesOut = "";
    let hasHref = false;
    if (allowedAttributes.size) {
      const parsed = parseAttributes(body.slice(nameMatch[1].length));
      for (const attribute of allowedAttributes) {
        const value = parsed.get(attribute);
        if (value === undefined) continue;
        if (attribute === "href") {
          const href = safeHref(value);
          if (!href) continue;
          hasHref = true;
          attributesOut += ` href="${escapeAttribute(href)}"`;
        } else {
          attributesOut += ` ${attribute}="${escapeAttribute(value)}"`;
        }
      }
    }

    // A link whose href was rejected is unwrapped rather than left as an
    // inert <a> shell. The matching </a> then finds nothing on the stack and
    // is skipped, so the label text survives on its own.
    if (name === "a" && !hasHref) continue;

    if (VOID_TAGS.has(name)) {
      out += `<${name}${attributesOut} />`;
      continue;
    }

    // Links always leave with rel/target — a support reply's links open
    // elsewhere, and reverse-tabnabbing is free to prevent.
    if (name === "a") {
      attributesOut += ' target="_blank" rel="noopener noreferrer"';
    }

    out += `<${name}${attributesOut}>`;
    openTags.push(name);
  }

  // Close anything the input left dangling.
  for (let k = openTags.length - 1; k >= 0; k--) out += `</${openTags[k]}>`;

  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/**
 * Plain-text rendering of sanitized HTML, for the text/plain part of a
 * multipart email. Link URLs are kept in parentheses so a text-only client
 * doesn't lose them.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";

  let text = html;

  // Emit link text followed by its URL, unless they're the same string.
  text = text.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]*>/g, "").trim();
      const cleanHref = decodeEntities(href).trim();
      if (!cleanLabel) return cleanHref;
      return decodeEntities(cleanLabel) === cleanHref
        ? cleanLabel
        : `${cleanLabel} (${cleanHref})`;
    }
  );

  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|blockquote|h[1-6])>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<[^>]*>/g, "");

  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when the markup carries no visible content. */
export function isEmptyHtml(html: string): boolean {
  return htmlToPlainText(html).replace(/\s+/g, "") === "";
}
