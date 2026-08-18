/**
 * Normalising Meta's webhook payload.
 *
 * The wire format packs six unrelated things into one `messaging` entry shape,
 * distinguished by which optional key is present. Pulling that apart here —
 * pure, no I/O — means the ingest path deals in a union it can switch on, and
 * every odd shape Meta sends can be tested without a live Page.
 *
 * Deliberately tolerant: an event we do not recognise becomes `ignored` with a
 * reason rather than an exception. Meta adds event types without warning, and
 * a webhook that throws on an unknown one is a webhook Meta disables.
 */

export type MetaChannel = "messenger" | "instagram";

export interface MetaAttachment {
  type: string;
  url: string | null;
  /** Story mentions and replies carry the story rather than a plain image. */
  isStory: boolean;
}

export interface MetaMessageEvent {
  kind: "message" | "echo";
  channel: MetaChannel;
  /** Meta's message id. The dedupe key. */
  mid: string;
  /** PSID (Messenger) or IGSID (Instagram) of the CUSTOMER, either direction. */
  customerId: string;
  pageId: string;
  text: string;
  attachments: MetaAttachment[];
  /** Milliseconds since epoch, from Meta. */
  timestamp: number;
  /** A reply to one of our story posts, or a mention in one. */
  isStoryReply: boolean;
}

export interface MetaReactionEvent {
  kind: "reaction";
  channel: MetaChannel;
  customerId: string;
  pageId: string;
  /** The message being reacted to. */
  mid: string;
  action: "react" | "unreact";
  emoji: string | null;
  timestamp: number;
}

export interface MetaDeleteEvent {
  kind: "delete";
  channel: MetaChannel;
  customerId: string;
  pageId: string;
  mid: string;
  timestamp: number;
}

export interface MetaIgnoredEvent {
  kind: "ignored";
  reason: string;
}

export type MetaEvent =
  | MetaMessageEvent
  | MetaReactionEvent
  | MetaDeleteEvent
  | MetaIgnoredEvent;

/** Story attachment types, which arrive as ordinary messages. */
const STORY_TYPES = new Set(["story_mention", "story_reply"]);

function readAttachments(raw: unknown): MetaAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MetaAttachment[] = [];
  for (const entry of raw) {
    const type = (entry as { type?: unknown })?.type;
    if (typeof type !== "string") continue;
    const url = (entry as { payload?: { url?: unknown } })?.payload?.url;
    out.push({
      type,
      url: typeof url === "string" ? url : null,
      isStory: STORY_TYPES.has(type),
    });
  }
  return out;
}

/**
 * Which channel produced this payload.
 *
 * `object` is "page" for Messenger and "instagram" for Instagram DMs. Both
 * arrive at the same endpoint with the same entry shape, which is the whole
 * reason 9A chose one integration over two.
 */
export function channelFor(object: unknown): MetaChannel | null {
  if (object === "page") return "messenger";
  if (object === "instagram") return "instagram";
  return null;
}

/** Flattens a whole webhook body into events we can act on. */
export function normalizeWebhook(payload: unknown): MetaEvent[] {
  const channel = channelFor((payload as { object?: unknown })?.object);
  if (!channel) return [{ kind: "ignored", reason: "unknown object type" }];

  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return [{ kind: "ignored", reason: "no entries" }];

  const events: MetaEvent[] = [];
  for (const entry of entries) {
    const messaging = (entry as { messaging?: unknown })?.messaging;
    if (!Array.isArray(messaging)) {
      // `changes` entries (page feed, comments) share the envelope and are
      // not messaging at all.
      events.push({ kind: "ignored", reason: "entry carries no messaging" });
      continue;
    }
    for (const item of messaging) {
      events.push(normalizeMessagingItem(item, channel));
    }
  }
  return events;
}

function normalizeMessagingItem(item: unknown, channel: MetaChannel): MetaEvent {
  const record = (item ?? {}) as Record<string, unknown>;
  const senderId = (record.sender as { id?: unknown } | undefined)?.id;
  const recipientId = (record.recipient as { id?: unknown } | undefined)?.id;
  const timestamp =
    typeof record.timestamp === "number" ? record.timestamp : Date.now();

  if (typeof senderId !== "string" || typeof recipientId !== "string") {
    return { kind: "ignored", reason: "no sender or recipient" };
  }

  const message = record.message as Record<string, unknown> | undefined;

  if (message) {
    const mid = message.mid;
    if (typeof mid !== "string") {
      return { kind: "ignored", reason: "message without an id" };
    }

    const isEcho = message.is_echo === true;
    // On an echo the PAGE is the sender, so the customer is the recipient.
    // Getting this backwards files the reply under a customer whose id is the
    // page, which quietly creates a ticket from ourselves.
    const customerId = isEcho ? recipientId : senderId;
    const pageId = isEcho ? senderId : recipientId;

    if (message.is_deleted === true) {
      return { kind: "delete", channel, customerId, pageId, mid, timestamp };
    }

    const attachments = readAttachments(message.attachments);
    const replyToStory = Boolean(
      (message.reply_to as { story?: unknown } | undefined)?.story
    );

    return {
      kind: isEcho ? "echo" : "message",
      channel,
      mid,
      customerId,
      pageId,
      text: typeof message.text === "string" ? message.text : "",
      attachments,
      timestamp,
      isStoryReply: replyToStory || attachments.some((a) => a.isStory),
    };
  }

  const reaction = record.reaction as Record<string, unknown> | undefined;
  if (reaction && typeof reaction.mid === "string") {
    return {
      kind: "reaction",
      channel,
      customerId: senderId,
      pageId: recipientId,
      mid: reaction.mid,
      action: reaction.action === "unreact" ? "unreact" : "react",
      emoji: typeof reaction.emoji === "string" ? reaction.emoji : null,
      timestamp,
    };
  }

  // read / delivery watermarks, postbacks, typing. Acknowledged, not stored.
  if (record.read) return { kind: "ignored", reason: "read receipt" };
  if (record.delivery) return { kind: "ignored", reason: "delivery receipt" };
  if (record.postback) return { kind: "ignored", reason: "postback" };

  return { kind: "ignored", reason: "unrecognised messaging event" };
}

/** A stable conversation key per (page, customer) pair. */
export function conversationId(
  channel: MetaChannel,
  pageId: string,
  customerId: string
): string {
  // Meta's webhook carries no conversation id, and the thread is defined by
  // the page/customer pair — so we mint one deterministically rather than
  // storing a mapping we would have to keep in step.
  return `${channel}:${pageId}:${customerId}`;
}
