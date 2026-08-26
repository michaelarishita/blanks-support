/** What every server action in app/actions.ts resolves to. */
export interface ActionResult {
  ok?: boolean;
  error?: string;
  /** Succeeded, but with something the agent needs to know (e.g. send failed). */
  warning?: string;
  /** A reply auto-assigned the ticket to its author. */
  claimed?: boolean;
}

export type TicketStatus = "new" | "open" | "pending" | "resolved" | "closed";
export type TicketChannel = "web_form" | "email" | "instagram" | "messenger";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface Agent {
  id: string;
  email: string;
  /** Customer-facing signature name. NOT the dashboard label. */
  name: string;
  /** Internal, team-facing label. Falls back to `name`. */
  display_name?: string | null;
  role: "admin" | "agent";
  avatar_url: string | null;
  gmail_connected: boolean;
  is_active: boolean;
}

export interface Customer {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  ig_user_id: string | null;
  fb_psid: string | null;
  notes: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  is_topic: boolean;
}

export interface Ticket {
  id: string;
  number: number;
  customer_id: string;
  channel: TicketChannel;
  topic: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee_id: string | null;
  order_number: string | null;
  /** Advisory only — nothing in the product acts on these. */
  risk_score?: number;
  risk_reasons?: { code: string; label: string; weight: number }[];
  risk_dismissed_at?: string | null;
  /**
   * Low-confidence vendor classification. Separate from risk_score on
   * purpose: risk decides nothing, this decides the starting priority.
   */
  vendor_outreach?: boolean;
  vendor_reasons?: { code: string; label: string; weight: number }[];
  first_response_at: string | null;
  resolved_at: string | null;
  last_message_at: string;
  created_at: string;
  customer?: Customer;
  assignee?: Agent | null;
  ticket_tags?: { tag: Tag }[];
}

export interface Attachment {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
}

export interface Message {
  id: string;
  ticket_id: string;
  direction: "inbound" | "outbound";
  type: "public" | "internal_note";
  agent_id: string | null;
  body_text: string;
  body_html: string | null;
  delivery_status: string;
  /** Sent by a rule, not a person. Excluded from first_response_at. */
  is_automated?: boolean;
  created_at: string;
  agent?: Agent | null;
  attachments?: Attachment[];
}

export interface TicketEvent {
  id: string;
  ticket_id: string;
  agent_id: string | null;
  event_type: string;
  detail: Record<string, unknown>;
  created_at: string;
  agent?: Agent | null;
}

/**
 * The customer-facing topic picker, and the source of truth for topic names.
 *
 * Every entry must exist as a row in `tags` — the intake endpoint looks the
 * topic up BY NAME to apply the topic tag, so a topic here with no matching
 * tag row silently creates untagged tickets. tests/topics.test.ts holds this
 * list against the tag rows the migrations produce.
 *
 * Rules match on these strings too, so removing or renaming one can leave a
 * rule condition pointing at a topic nothing can produce. That is also
 * asserted rather than remembered.
 *
 * DEPRECATED TOPICS ARE REMOVED FROM HERE BUT NOT FROM `tags`: dropping the
 * row would take the tag off every historical ticket that carries it. See
 * 0012 for "Ambassador / athlete", which is retired from this picker and
 * still on the tickets that used it.
 */
export const TOPICS = [
  "Order questions",
  "Product questions",
  "Shipping & returns",
  "Subscription Help",
  "Wholesale / retailer",
  "Sponsorship inquiry",
  "Event questions",
  "Feedback",
  "Other",
] as const;

// Tones map onto the semantic tokens in globals.css via <Badge>. Status
// chips must never hand-roll their own colours.
export const STATUS_META: Record<
  TicketStatus,
  { label: string; tone: "neutral" | "brand" | "success" | "warning" | "info" }
> = {
  new: { label: "New", tone: "info" },
  open: { label: "Open", tone: "brand" },
  pending: { label: "Pending", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

// Icons live in components/ui/ChannelIcon so this stays a types-only module
// that server components can import freely.
export const CHANNEL_META: Record<TicketChannel, { label: string }> = {
  web_form: { label: "Website" },
  email: { label: "Email" },
  instagram: { label: "Instagram" },
  messenger: { label: "Messenger" },
};

export const PRIORITY_META: Record<
  TicketPriority,
  { label: string; tone: "neutral" | "warning" | "danger" }
> = {
  low: { label: "Low", tone: "neutral" },
  normal: { label: "Normal", tone: "neutral" },
  high: { label: "High", tone: "warning" },
  urgent: { label: "Urgent", tone: "danger" },
};
