import { escapeAttribute, escapeHtml, htmlToPlainText } from "@/lib/html";

// Branded outbound email.
//
// Email clients are not browsers: layout is tables, styling is inline, and
// there is no flexbox, no external stylesheet and no webfont. Every cell also
// carries an explicit background and colour, because clients that force dark
// mode will otherwise invert text to something unreadable against a
// hard-coded white background.
//
// No tracking pixel, by design.

export interface CompanySettings {
  company_name: string;
  website: string | null;
  website_label: string | null;
  brand_color: string;
  logo_url: string | null;
  logo_width: number | null;
  logo_height: number | null;
}

export interface SignatureAgent {
  name: string;
  title: string | null;
  phone: string | null;
}

/**
 * How the From display name is composed. The address underneath is always the
 * replying agent's, so the send stays authenticated and lands in their Sent
 * folder — only the name shown alongside it changes.
 *
 * Switching this is a one-line change by design:
 *   "company"          → Blank's Sports Nutrition
 *   "agent-at-company" → Michael at Blank's Sports Nutrition
 *   "agent"            → Michael Arishita        (the pre-6B behaviour)
 */
export type FromNameFormat = "company" | "agent-at-company" | "agent";

export const FROM_NAME_FORMAT: FromNameFormat = "company";

export function formatFromName(
  agentName: string | null | undefined,
  companyName: string,
  format: FromNameFormat = FROM_NAME_FORMAT
): string {
  const name = agentName?.trim();
  switch (format) {
    case "agent":
      return name || companyName;
    case "agent-at-company":
      return name ? `${name} at ${companyName}` : companyName;
    case "company":
    default:
      return companyName;
  }
}

/** The message being replied to, quoted beneath the reply for context. */
export interface QuotedHistory {
  authorName: string;
  authorEmail: string | null;
  date: Date;
  /** Already-sanitized HTML of the quoted message, when it had any. */
  html: string | null;
  /** Plain text of the quoted message. */
  text: string;
}

/** Quoted history is capped so a long thread can't grow without bound. */
const MAX_QUOTED_CHARS = 5000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * `On Thu, 14 Aug 2026 at 10:04, Ike <ike@x.com> wrote:`
 *
 * Two hard constraints, both from our own inbound parser:
 * - it must be ONE line ending in `wrote:`, because splitQuotedText matches
 *   /^\s*On .*wrote\s*:\s*$/ and a wrapped attribution would not be
 *   recognised as the start of quoted history;
 * - it is built from UTC parts rather than toLocaleString so the output is
 *   deterministic across machines and test runs.
 */
export function formatQuoteAttribution(quoted: QuotedHistory): string {
  const d = quoted.date;
  const stamp =
    `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} at ${String(d.getUTCHours()).padStart(2, "0")}:` +
    `${String(d.getUTCMinutes()).padStart(2, "0")}`;

  // Strip CR/LF from the name: it lands in a single-line attribution, and a
  // newline there would break the marker the parser looks for.
  const name = quoted.authorName.replace(/[\r\n]+/g, " ").trim();
  const who = quoted.authorEmail ? `${name} <${quoted.authorEmail}>` : name;
  return `On ${stamp}, ${who} wrote:`;
}

function clampQuoted(text: string): string {
  if (text.length <= MAX_QUOTED_CHARS) return text;
  return `${text.slice(0, MAX_QUOTED_CHARS)}\n[… earlier messages trimmed]`;
}

export const DEFAULT_COMPANY: CompanySettings = {
  company_name: "Blank's Sports Nutrition",
  website: "https://blankssportsnutrition.com",
  website_label: "blankssportsnutrition.com",
  brand_color: "#0061ff",
  logo_url: null,
  logo_width: 240,
  logo_height: null,
};

const TEXT = "#1a1a1a";
const MUTED = "#666666";
const RULE = "#e5e5e5";
const BACKDROP = "#f4f4f5";

/**
 * Brand colour lands inside a style attribute, so it must be a literal hex
 * value — anything else could close the attribute and inject markup.
 */
function safeColor(value: string | null | undefined, fallback: string): string {
  if (value && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

/** Only absolute http(s) URLs — email clients can't resolve a relative src. */
function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(trimmed) ? trimmed : null;
}

function safeDimension(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded > 0 && rounded <= 1000 ? rounded : null;
}

/**
 * The signature block: rule, agent identity, company, website, then the logo
 * (or a text wordmark when no logo has been uploaded).
 *
 * Every interpolated value here is user-controlled — agent name/title/phone
 * are typed in Settings, and the company block is admin-editable — so all of
 * it is escaped.
 */
function renderSignature(agent: SignatureAgent, company: CompanySettings): string {
  const brand = safeColor(company.brand_color, DEFAULT_COMPANY.brand_color);
  const website = safeUrl(company.website);
  const websiteLabel = escapeHtml(
    company.website_label || company.website || ""
  );
  const logo = safeUrl(company.logo_url);
  const logoWidth = safeDimension(company.logo_width) ?? 240;
  const logoHeight = safeDimension(company.logo_height);

  const rows: string[] = [
    `<tr><td style="padding:0 0 4px 0;background-color:#ffffff;color:${TEXT};font-size:15px;line-height:1.4;font-weight:600;">${escapeHtml(
      agent.name
    )}</td></tr>`,
  ];

  if (agent.title) {
    rows.push(
      `<tr><td style="padding:0;background-color:#ffffff;color:${MUTED};font-size:14px;line-height:1.5;">${escapeHtml(
        agent.title
      )}</td></tr>`
    );
  }

  // No standalone company-name row: the logo below carries it, and the
  // wordmark fallback spells it out. Repeating it only lengthens the block
  // that Gmail collapses behind "see more" on later replies in a thread.

  if (agent.phone) {
    rows.push(
      `<tr><td style="padding:0;background-color:#ffffff;color:${MUTED};font-size:14px;line-height:1.5;">${escapeHtml(
        agent.phone
      )}</td></tr>`
    );
  }

  if (website) {
    rows.push(
      `<tr><td style="padding:0;background-color:#ffffff;font-size:14px;line-height:1.5;"><a href="${escapeAttribute(
        website
      )}" style="color:${brand};text-decoration:none;">${websiteLabel}</a></td></tr>`
    );
  }

  if (logo) {
    // Explicit width/height so the layout doesn't jump before images load,
    // and a real alt so it degrades to the company name when images are
    // blocked (Gmail blocks them by default for unknown senders).
    rows.push(
      `<tr><td style="padding:12px 0 0 0;background-color:#ffffff;"><img src="${escapeAttribute(
        logo
      )}" alt="${escapeAttribute(company.company_name)}" width="${logoWidth}"${
        logoHeight ? ` height="${logoHeight}"` : ""
      } style="display:block;border:0;outline:none;text-decoration:none;max-width:${logoWidth}px;width:100%;height:auto;" /></td></tr>`
    );
  } else {
    // No logo uploaded yet — a styled wordmark keeps the signature looking
    // finished rather than leaving a gap.
    rows.push(
      `<tr><td style="padding:14px 0 0 0;background-color:#ffffff;color:${TEXT};font-size:13px;line-height:1.2;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;"><span style="color:${brand};">■</span>&nbsp;${escapeHtml(
        company.company_name
      )}</td></tr>`
    );
  }

  return `
      <tr>
        <td style="padding:18px 0 0 0;background-color:#ffffff;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
            <tr><td style="padding:0 0 12px 0;background-color:#ffffff;border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td></tr>
            ${rows.join("\n            ")}
          </table>
        </td>
      </tr>`;
}

/**
 * Full HTML email. `bodyHtml` must already be sanitized — this function
 * escapes the signature fields but treats the reply body as trusted markup.
 */
function renderQuoted(quoted: QuotedHistory): string {
  const attribution = escapeHtml(formatQuoteAttribution(quoted));
  // Prefer the original markup; fall back to escaped text with line breaks.
  const inner = quoted.html
    ? clampQuoted(quoted.html)
    : escapeHtml(clampQuoted(quoted.text)).replace(/\n/g, "<br />");

  return `
      <tr>
        <td style="padding:20px 0 0 0;background-color:#ffffff;color:${MUTED};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;">
          ${attribution}
          <blockquote style="margin:8px 0 0 0;padding:0 0 0 12px;border-left:2px solid ${RULE};background-color:#ffffff;color:${MUTED};font-size:13px;line-height:1.5;">
${inner}
          </blockquote>
        </td>
      </tr>`;
}

export function renderEmailHtml({
  bodyHtml,
  agent,
  company,
  quoted,
}: {
  bodyHtml: string;
  /** Null to send without a signature. */
  agent: SignatureAgent | null;
  company: CompanySettings;
  /** Prior message quoted beneath the reply; omit on a first contact. */
  quoted?: QuotedHistory | null;
}): string {
  const signature = agent ? renderSignature(agent, company) : "";
  const history = quoted ? renderQuoted(quoted) : "";

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light only" />
<meta name="supported-color-schemes" content="light only" />
<title>${escapeHtml(company.company_name)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BACKDROP};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${BACKDROP};border-collapse:collapse;">
  <tr>
    <td align="center" style="padding:24px 12px;background-color:${BACKDROP};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;background-color:#ffffff;border-collapse:collapse;">
        <tr>
          <td style="padding:24px;background-color:#ffffff;color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
              <tr>
                <td style="padding:0;background-color:#ffffff;color:${TEXT};font-size:15px;line-height:1.6;">
${bodyHtml}
                </td>
              </tr>${signature}${history}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * text/plain alternative. Built from the same inputs rather than by stripping
 * the wrapper markup, so table scaffolding can't leak into it.
 */
export function renderEmailText({
  bodyHtml,
  agent,
  company,
  quoted,
}: {
  bodyHtml: string;
  agent: SignatureAgent | null;
  company: CompanySettings;
  quoted?: QuotedHistory | null;
}): string {
  const lines = [htmlToPlainText(bodyHtml)];

  if (agent) {
    const block = [agent.name];
    if (agent.title) block.push(agent.title);
    // Company name comes from the From display name now; see formatFromName.
    if (agent.phone) block.push(agent.phone);
    block.push(company.company_name);
    if (company.website) {
      block.push(company.website_label || company.website);
    }
    lines.push("--", block.join("\n"));
  }

  if (quoted) {
    const quotedText = clampQuoted(
      quoted.html ? htmlToPlainText(quoted.html) : quoted.text
    );
    // "> " on every line, including blanks, is what mail clients emit and
    // what our own inbound stripping recognises.
    const body = quotedText
      .split("\n")
      .map((line) => (line.trim() ? `> ${line}` : ">"))
      .join("\n");
    lines.push(`${formatQuoteAttribution(quoted)}\n${body}`);
  }

  return lines.join("\n\n").trim();
}
