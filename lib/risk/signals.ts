/**
 * Advisory risk signals on an inbound ticket.
 *
 * WHAT THIS IS NOT. It is not a fraud detector, it decides nothing, and
 * nothing downstream acts on it. No auto-reply, no auto-assign, no
 * auto-resolve, no blocking. It puts a sentence in front of an agent and
 * stops there.
 *
 * The wording is "Review carefully" everywhere, never "fraud". Legitimate
 * customers trip these constantly — someone whose video is too big to email
 * really does send a Drive link — and an agent who accuses a person on the
 * strength of a heuristic has done more damage than the heuristic could
 * prevent.
 *
 * Pure, so the weights can be reasoned about and so precision can be measured
 * later against the stored reasons rather than re-derived from memory.
 */

export interface RiskFacts {
  subject: string;
  bodyText: string;
  fromEmail: string | null;
  /** Reply-To, when the message carried one. */
  replyToEmail: string | null;
  /** Whether the customer actually attached anything. */
  hasAttachments: boolean;
  /**
   * Did Shopify know this email address?
   *
   * `null` means the lookup could not run — unconfigured, throttled, down —
   * and no order-match signal fires on a lookup that never happened. Treating
   * "we could not check" as "no such customer" would flag every ticket the
   * moment Shopify had a bad afternoon.
   */
  shopifyCustomerFound: boolean | null;
  /** Earlier tickets from this address, excluding this one. */
  priorTicketCount: number;
  /** Tickets from this address inside the recent window, excluding this one. */
  recentTicketCount: number;
}

export interface RiskReason {
  code: string;
  /** Shown to the agent verbatim. Descriptive, never accusatory. */
  label: string;
  weight: number;
}

export interface RiskAssessment {
  score: number;
  reasons: RiskReason[];
  flagged: boolean;
}

/** At or above this, the ticket carries a badge. */
export const REVIEW_THRESHOLD = 3;

/** Tickets from one address inside this window count as a burst. */
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Hosts used to share a file instead of attaching one.
 *
 * Matched on the HOST of an actual URL, so the word appearing in prose is not
 * a signal, and a link whose visible text says "drive.google.com" while
 * pointing somewhere else is judged on where it really goes.
 */
const FILE_SHARING_HOSTS = [
  "drive.google.com",
  "docs.google.com",
  "dropbox.com",
  "db.tt",
  "wetransfer.com",
  "we.tl",
  "mega.nz",
  "mega.io",
  "icloud.com",
  "onedrive.live.com",
  "1drv.ms",
  "sendspace.com",
  "mediafire.com",
  "box.com",
  "pcloud.com",
  "smash.com",
  "filemail.com",
  "terabox.com",
];

const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

const DAMAGE_WORDS = [
  "damaged",
  "damage",
  "broken",
  "smashed",
  "crushed",
  "leaking",
  "spilled",
  "defective",
  "faulty",
  "not as described",
  "wrong item",
];

const MONEY_WORDS = [
  "refund",
  "money back",
  "chargeback",
  "charge back",
  "dispute",
  "reimburse",
  "compensation",
];

const ORDER_WORDS = [
  "my order",
  "order number",
  "order #",
  "i ordered",
  "i purchased",
  "my purchase",
  "the package",
  "my parcel",
  "my delivery",
  "tracking",
];

const PRIOR_CONTACT_WORDS = [
  "reached out",
  "contacted you",
  "contacted support",
  "no reply",
  "no response",
  "haven't heard",
  "have not heard",
  "still waiting",
  "following up again",
  "second time",
  "third time",
  "chasing this",
  "my previous email",
  "days ago",
];

const WHOLESALE_WORDS = [
  "wholesale",
  "bulk order",
  "bulk purchase",
  "reseller",
  "distributor",
  "trade account",
  "stock your",
  "pallet",
  "case pack",
  "purchase order",
];

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function emailDomain(address: string | null | undefined): string {
  const at = (address ?? "").lastIndexOf("@");
  return at === -1 ? "" : (address ?? "").slice(at + 1).trim().toLowerCase();
}

export function fileSharingLinks(text: string): string[] {
  const found: string[] = [];
  // The path is captured too, so the caller gets the WHOLE url — the thread
  // highlights these by splitting the body on them, and a bare origin would
  // mark the wrong span.
  for (const match of text.matchAll(/https?:\/\/([^\s/<>")\]]+)(?:\/[^\s<>"\]]*)?/gi)) {
    const host = match[1].toLowerCase().replace(/^www\./, "");
    if (FILE_SHARING_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))) {
      found.push(match[0]);
    }
  }
  return found;
}

export function isFreemail(address: string | null | undefined): boolean {
  return FREEMAIL_DOMAINS.has(emailDomain(address));
}

export function assessRisk(facts: RiskFacts): RiskAssessment {
  const raw = `${facts.subject}\n${facts.bodyText}`;
  const text = raw.toLowerCase();
  const reasons: RiskReason[] = [];

  const shares = fileSharingLinks(raw);
  const claimsOrder = includesAny(text, ORDER_WORDS);
  const claimsDamage = includesAny(text, DAMAGE_WORDS);
  const claimsMoney = includesAny(text, MONEY_WORDS);
  const noOrderMatch = facts.shopifyCustomerFound === false;

  /**
   * The strongest single signal, per the brief. Evidence held somewhere we
   * cannot see, offered instead of an attachment, is the shape nearly every
   * damage/refund scam takes — and also exactly what an honest customer with
   * a 90MB video does, which is why this informs rather than decides.
   */
  if (shares.length && !facts.hasAttachments) {
    reasons.push({
      code: "file_share_instead_of_attachment",
      label: `Evidence linked from a file-sharing site (${
        shares.length === 1 ? "1 link" : `${shares.length} links`
      }) rather than attached`,
      weight: 3,
    });
  } else if (shares.length) {
    // Attached AND linked is far weaker: the attachment is the evidence.
    reasons.push({
      code: "file_share_link",
      label: "Message contains a file-sharing link",
      weight: 1,
    });
  }

  if (claimsOrder && noOrderMatch) {
    reasons.push({
      code: "order_claim_no_shopify_match",
      label: "Refers to an order, but no Shopify customer has this email address",
      weight: 2,
    });
  }

  if ((claimsDamage || claimsMoney) && noOrderMatch) {
    reasons.push({
      code: "damage_or_refund_no_order_match",
      label: "Damage or refund language with no matching Shopify customer",
      weight: 2,
    });
  }

  /**
   * "I emailed three days ago and heard nothing", when nothing ever arrived.
   * Worth surfacing because it manufactures urgency and puts an agent on an
   * apologetic footing before anybody has checked.
   */
  if (includesAny(text, PRIOR_CONTACT_WORDS) && facts.priorTicketCount === 0) {
    reasons.push({
      code: "claims_prior_contact_none_found",
      label: "Mentions earlier contact, but this is the first ticket from this address",
      weight: 2,
    });
  }

  if (facts.recentTicketCount >= 2) {
    reasons.push({
      code: "repeat_tickets_short_window",
      label: `${facts.recentTicketCount + 1} tickets from this address in 24 hours`,
      weight: 1,
    });
  }

  const fromDomain = emailDomain(facts.fromEmail);
  const replyDomain = emailDomain(facts.replyToEmail);
  if (fromDomain && replyDomain && fromDomain !== replyDomain) {
    reasons.push({
      code: "reply_to_domain_mismatch",
      label: `Replies would go to ${replyDomain}, not ${fromDomain}`,
      weight: 2,
    });
  }

  if (isFreemail(facts.fromEmail) && includesAny(text, WHOLESALE_WORDS)) {
    reasons.push({
      code: "freemail_wholesale_claim",
      label: "Wholesale or bulk enquiry from a personal email address",
      weight: 1,
    });
  }

  const score = reasons.reduce((total, reason) => total + reason.weight, 0);
  return { score, reasons, flagged: score >= REVIEW_THRESHOLD };
}

/** The only phrasing this feature ever uses. */
export const REVIEW_LABEL = "Review carefully";
