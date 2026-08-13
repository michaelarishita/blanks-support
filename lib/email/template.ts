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

export const DEFAULT_COMPANY: CompanySettings = {
  company_name: "Blank's Sports Nutrition",
  website: "https://blankssportsnutrition.com",
  website_label: "blankssportsnutrition.com",
  brand_color: "#f5c518",
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

  rows.push(
    `<tr><td style="padding:0;background-color:#ffffff;color:${MUTED};font-size:14px;line-height:1.5;">${escapeHtml(
      company.company_name
    )}</td></tr>`
  );

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
      `<tr><td style="padding:16px 0 0 0;background-color:#ffffff;"><img src="${escapeAttribute(
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
        <td style="padding:24px 0 0 0;background-color:#ffffff;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
            <tr><td style="padding:0 0 16px 0;background-color:#ffffff;border-top:1px solid ${RULE};font-size:0;line-height:0;">&nbsp;</td></tr>
            ${rows.join("\n            ")}
          </table>
        </td>
      </tr>`;
}

/**
 * Full HTML email. `bodyHtml` must already be sanitized — this function
 * escapes the signature fields but treats the reply body as trusted markup.
 */
export function renderEmailHtml({
  bodyHtml,
  agent,
  company,
}: {
  bodyHtml: string;
  /** Null to send without a signature. */
  agent: SignatureAgent | null;
  company: CompanySettings;
}): string {
  const signature = agent ? renderSignature(agent, company) : "";

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
              </tr>${signature}
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
}: {
  bodyHtml: string;
  agent: SignatureAgent | null;
  company: CompanySettings;
}): string {
  const lines = [htmlToPlainText(bodyHtml)];

  if (agent) {
    const block = [agent.name];
    if (agent.title) block.push(agent.title);
    block.push(company.company_name);
    if (agent.phone) block.push(agent.phone);
    if (company.website) {
      block.push(company.website_label || company.website);
    }
    lines.push("--", block.join("\n"));
  }

  return lines.join("\n\n").trim();
}
