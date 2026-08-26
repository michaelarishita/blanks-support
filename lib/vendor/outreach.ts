/**
 * "Likely vendor outreach" — a low-confidence, advisory classification.
 *
 * Roughly a third of recent tickets were cold outreach: Shopify app vendors,
 * SEO agencies, packaging suppliers, phishing dressed as a copyright notice.
 * They arrive on the same channel as customers and sit in the same queue at
 * the same priority, which is what makes them expensive — not the reading,
 * the competing.
 *
 * WHY THIS IS NOT PART OF risk_score. The risk feature's defining property is
 * that it decides nothing, and a test asserts nothing outside the risk
 * modules and the UI ever reads risk_score. This signal DOES decide one small
 * thing — the starting priority — so folding it in would quietly destroy that
 * guarantee for the signals that must keep it. Two columns, two promises.
 *
 * WHAT IT NEVER DOES: no auto-delete, no auto-resolve, no auto-reply, no
 * hiding. A misfire has to cost a customer a place in the queue, and nothing
 * more than that. Sponsorship, athlete-partnership and wholesale enquiries
 * are the business, read exactly like cold outreach, and are the reason every
 * weight here is small.
 *
 * Pure, so the phrases can be argued about and the precision measured later
 * against what was stored.
 */

export interface VendorFacts {
  subject: string;
  bodyText: string;
  fromEmail: string | null;
  /** The bulk header the guard saw, if it saw one and let the mail through. */
  bulkMarker: string | null;
  /** Whether the sender is a known Shopify customer. null = couldn't check. */
  shopifyCustomerFound: boolean | null;
  /** Earlier tickets from this address, excluding this one. */
  priorTicketCount: number;
}

export interface VendorReason {
  code: string;
  label: string;
  weight: number;
}

export interface VendorAssessment {
  score: number;
  reasons: VendorReason[];
  likely: boolean;
}

/** At or above this, the ticket is marked and starts at Low. */
export const VENDOR_THRESHOLD = 4;

/**
 * Phrases that belong to a pitch rather than a question about an order.
 *
 * Every one of these was taken from mail that actually arrived, not from an
 * idea of what spam sounds like.
 */
const PITCH_PHRASES = [
  // Openers. Cold outreach almost always announces itself in the first line.
  "i came across your",
  "i was browsing your",
  "stumbled upon your",
  "checked out your website",
  "i was checking your website",
  "visited your website",
  "noticed your store",
  "noticed that your",
  "wanted to reach out",
  "reaching out to see",
  "reaching out from",
  "i'm reaching out",
  "im reaching out",
  "i am reaching out",
  "quick question about",
  "a quick thought",
  "just one quick",
  "hope you are doing well",
  "hope this email finds you",
  "hi there,",
  "hello there",
  // What they want.
  "would you be open to",
  "are you the right person",
  "who handles",
  "may i send you",
  "can i send over",
  "would you like me to send",
  "happy to share",
  "we'd love to hear",
  "we would love to hear",
  "let me know your thoughts",
  "please let me know if",
  "book a call",
  "schedule a call",
  "hop on a call",
  "15 minutes of your time",
  "mind if i",
  // What they are selling.
  "we specialize",
  "we specialise",
  "we help brands",
  "we help e-commerce",
  "we help ecommerce",
  "we help shopify",
  "we can supply",
  "our capabilities",
  "our agency",
  "our team focuses",
  "our team can",
  "increase your sales",
  "boost your sales",
  "grow your revenue",
  "drive more traffic",
  "more targeted visitors",
  "targeted visitors on your website",
  "1st page",
  "search engines",
  "seo audit",
  "seo packages",
  "free audit",
  "free trial",
  "no obligation",
  "no pitch",
  "digital marketing plan",
  "send over the proposal",
  // Follow-up sequences — a second or third touch nobody asked for.
  "wanted to follow up",
  "just following up on my",
  "did you get a chance to",
  "bumping this",
  "no worries if not",
  "if you're not interested",
  "if you are not interested",
  "still open to discussing",
];

/** Sales-shaped nouns. Weak on their own; corroborating in combination. */
const PITCH_NOUNS = [
  "case study",
  "white label",
  "affiliate program",
  "affiliate programme",
  "influencer marketing",
  "lead generation",
  "cold email",
  "backlinks",
  "guest post",
  "conversion rate optimization",
  "conversion rate optimisation",
  "dropshipping",
  "fulfillment partner",
  "fulfilment partner",
  "contact list",
  "database details",
  "outreach approaches",
  "bulk ingredients",
  "ingredient sourcing",
  "manufacturing capabilities",
  "samples or design help",
];

/**
 * Marketing-send machinery in the BODY.
 *
 * Structural rather than stylistic, and much harder to write by accident: a
 * customer asking about a leaking gel does not append an unsubscribe link, a
 * copyright line or a corporate postal address. #1074 and #1056 carry these
 * and almost no pitch VOCABULARY at all, which is why phrasing alone missed
 * them entirely on the real corpus.
 */
const BULK_FOOTER_MARKERS = [
  "unsubscribe",
  "no longer wish to receive",
  "to no longer receive these emails",
  "you are receiving this email because",
  "remove your email address from our mailing list",
  "opt out",
  "all rights reserved",
  "utm_source=email",
  "utm_medium=email",
];

/**
 * The counterweight, and the reason this stays low-confidence.
 *
 * NARROW ON PURPOSE, and narrowed after testing against the real inbox: an
 * earlier version listed topic words like "ingredient", "subscription" and
 * "flavour", which vendors write constantly — a packaging supplier pitching
 * "subscription packs" and an ingredient wholesaler both scored zero because
 * of it. Every phrase here is FIRST-PERSON and about the sender's own
 * transaction with us, which is the thing no cold pitch has.
 */
const CUSTOMER_PHRASES = [
  "my order",
  "order number",
  "order #",
  "i ordered",
  "i bought",
  "i purchased",
  "my purchase",
  "my package",
  "my parcel",
  "my delivery",
  "my subscription",
  "my tracking",
  "tracking number",
  "i received",
  "i'd like a refund",
  "i want a refund",
  "my refund",
  "return it",
  "send it back",
  "arrived damaged",
  "arrived broken",
  "is leaking",
  "was leaking",
  "my discount code",
  "my promo code",
  "when will my",
  "hasn't arrived",
  "has not arrived",
  "never arrived",
];

/**
 * Enquiries that read exactly like cold outreach and ARE the business.
 *
 * An athlete asking for sponsorship opens with "I wanted to reach out", is
 * happy to share their results, and is pitching — structurally identical to
 * an SEO agency. There is a live routing rule sending Sponsorship to Michael,
 * so deprioritising these would be worse than every vendor mail this catches,
 * and it is the failure nobody would notice: the ticket is still there, still
 * open, just never at the top.
 *
 * Same short-circuit as the customer veto: not scored lower, not classified.
 */
const BUSINESS_PHRASES = [
  "sponsorship",
  "sponsor me",
  "sponsored athlete",
  "athlete partnership",
  "brand ambassador",
  "ambassador program",
  "ambassador programme",
  "representing blank",
  "race schedule",
  "my results",
  "race results",
  "wholesale",
  "stock your",
  "trade account",
  "retailer",
  "reseller",
  "team kit",
  "my team",
  "our club",
  "my club",
];

function includesAny(haystack: string, needles: string[]): number {
  return needles.filter((needle) => haystack.includes(needle)).length;
}

export function assessVendorOutreach(facts: VendorFacts): VendorAssessment {
  const text = `${facts.subject}\n${facts.bodyText}`.toLowerCase();
  const reasons: VendorReason[] = [];

  // Checked FIRST and short-circuiting. Anything that sounds like a customer,
  // or like the kind of enquiry this business exists to receive, is not
  // classified at all — not scored lower, not classified.
  if (
    includesAny(text, CUSTOMER_PHRASES) > 0 ||
    includesAny(text, BUSINESS_PHRASES) > 0
  ) {
    return { score: 0, reasons: [], likely: false };
  }

  /**
   * Graded, because the phrase count is the difference between a hint and a
   * certainty.
   *
   * Three or more distinct cold-outreach phrases with no customer language
   * anywhere is about as strong as text evidence gets, and clears the
   * threshold on its own — measured against the real inbox, every message
   * that reached three was a pitch. Two is suggestive and has to be
   * corroborated by something structural — a marketing footer, bulk headers,
   * no order history — before it counts. One is a coincidence; plenty of real
   * people write "quick question about".
   */
  const pitchHits = includesAny(text, PITCH_PHRASES);
  if (pitchHits >= 3) {
    reasons.push({
      code: "cold_outreach_phrasing",
      label: `Reads like a sales pitch (${pitchHits} cold-outreach phrases)`,
      weight: 4,
    });
  } else if (pitchHits >= 2) {
    reasons.push({
      code: "cold_outreach_phrasing",
      label: `Reads like a sales pitch (${pitchHits} cold-outreach phrases)`,
      weight: 3,
    });
  } else if (pitchHits === 1) {
    reasons.push({
      code: "cold_outreach_phrase",
      label: "Contains a cold-outreach phrase",
      weight: 1,
    });
  }

  const footerHits = includesAny(text, BULK_FOOTER_MARKERS);
  if (footerHits > 0) {
    reasons.push({
      code: "marketing_footer",
      label: `Carries marketing-send machinery (${footerHits} of: unsubscribe, opt-out, copyright, tracked links)`,
      weight: 3,
    });
  }

  const nounHits = includesAny(text, PITCH_NOUNS);
  if (nounHits > 0) {
    reasons.push({
      code: "sales_vocabulary",
      label: `Sales vocabulary (${nounHits} term${nounHits === 1 ? "" : "s"})`,
      weight: 1,
    });
  }

  /**
   * A bulk marker that SURVIVED the guard.
   *
   * The guard already drops bulk mail unless it came through a trusted
   * forwarder — support@, the Google Group. So a List-Unsubscribe still
   * attached at this point means either a genuine mailing list that reached
   * us another way, or a vendor blast forwarded by the group. Neither is a
   * customer with a question.
   */
  if (facts.bulkMarker) {
    reasons.push({
      code: "bulk_headers",
      label: `Sent with mailing-list headers (${facts.bulkMarker})`,
      weight: 2,
    });
  }

  // Only ever corroborating, never sufficient. `null` means the lookup could
  // not run and contributes nothing, the same discipline as the risk module.
  if (facts.shopifyCustomerFound === false && facts.priorTicketCount === 0) {
    reasons.push({
      code: "no_order_history",
      label: "No Shopify customer and no previous tickets from this address",
      weight: 1,
    });
  }

  const score = reasons.reduce((total, reason) => total + reason.weight, 0);
  return { score, reasons, likely: score >= VENDOR_THRESHOLD };
}

/** The only phrasing this feature uses. Never "spam". */
export const VENDOR_LABEL = "Likely vendor outreach";
