import { createAdminClient } from "@/lib/supabase/admin";
import { getPageAccessToken } from "./graph";
import { processMetaEvents } from "./inbound";
import type { MetaMessageEvent } from "./events";

/**
 * One-time import of the conversations already sitting in the Page inbox.
 *
 * The webhook only hears about messages that arrive AFTER the app is subscribed
 * to the Page. Anything a customer sent before that — the whole backlog — is
 * invisible to the live path and only ever surfaced by reconciliation, which
 * alarms ("never reached the inbox") but does not import. Wes Salonen's
 * "Hello. I love Blank's!!!!" is exactly that: no meta_webhook_events row, found
 * only by the Graph-API reconcile. This closes the gap by actually bringing
 * those messages in.
 *
 * Idempotent by construction: every message is ingested through the SAME
 * processMetaEvents path as a live webhook, and the unique index on
 * meta_message_id absorbs anything already stored — so it "comes in once" no
 * matter how many times the backfill runs. Built on the Graph API, like
 * reconcile, because the webhook log by definition does not have these.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

interface GraphMessage {
  id?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  message?: string;
}
interface GraphConversation {
  id?: string;
  messages?: { data?: GraphMessage[] };
}

/**
 * Turns the Graph conversation listing into ingest events — inbound only.
 *
 * Pure, so the mapping is testable without a Page. `from.id === pageId` is our
 * OWN reply, skipped: those lack a clean customer id in this listing (no
 * recipient field) and are a gap in the thread, not a lost customer message —
 * the same line reconcile draws. Messages with no id can't be deduped, so they
 * are dropped rather than risk a double-import.
 */
export type BackfillPlatform = "messenger" | "instagram";

export function conversationsToEvents(
  conversations: GraphConversation[],
  pageId: string,
  now = Date.now(),
  platform: BackfillPlatform = "messenger"
): MetaMessageEvent[] {
  // The listing's `from.id` is a PSID on Messenger and an IGSID on Instagram;
  // ingestMessage resolves the customer by the matching column (fb_psid /
  // ig_user_id) off the channel, so this is the only switch the import needs.
  const channel: BackfillPlatform = platform;
  const events: MetaMessageEvent[] = [];
  for (const conversation of conversations) {
    for (const m of conversation.messages?.data ?? []) {
      if (!m.id) continue;
      const fromId = m.from?.id;
      if (!fromId || fromId === pageId) continue; // our own outbound
      events.push({
        kind: "message",
        channel,
        mid: m.id,
        customerId: fromId,
        pageId,
        text: m.message ?? "",
        attachments: [],
        timestamp: m.created_time ? Date.parse(m.created_time) : now,
        isStoryReply: false,
      });
    }
  }
  return events;
}

export interface BackfillReport {
  platform: BackfillPlatform;
  conversations: number;
  inboundFound: number;
  alreadyStored: number;
  toImport: number;
  /** Sender + preview for each message that would be / was imported. */
  samples: { from: string; preview: string; at: string | null }[];
  /** Set only on apply. */
  imported?: { created: number; appended: number; skipped: Record<string, number> };
  hitCap: boolean;
  error: string | null;
}

/**
 * Fetch the Page inbox and import anything we don't already have.
 *
 * `dryRun` (the default) reports exactly what WOULD come in without writing —
 * the same discipline as the other admin backfills, so a person can see the
 * list before it lands.
 */
export async function backfillMetaInbox(
  options: { max?: number; dryRun?: boolean; now?: number; platform?: BackfillPlatform } = {}
): Promise<BackfillReport> {
  const max = options.max ?? 200;
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? true;
  const platform: BackfillPlatform = options.platform ?? "messenger";
  const empty: BackfillReport = {
    platform,
    conversations: 0,
    inboundFound: 0,
    alreadyStored: 0,
    toImport: 0,
    samples: [],
    hitCap: false,
    error: null,
  };

  const pageId = process.env.META_PAGE_ID;
  if (!pageId) return { ...empty, error: "META_PAGE_ID is not set" };
  const token = await getPageAccessToken();
  if (!token) return { ...empty, error: "no page access token configured" };

  let body: unknown;
  try {
    const res = await fetch(
      `${GRAPH}/${encodeURIComponent(pageId)}/conversations` +
        `?platform=${platform}&limit=${max}` +
        `&fields=id,messages.limit(50){id,created_time,from,message}` +
        `&access_token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    body = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      return { ...empty, error: message };
    }
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }

  const conversations = ((body as { data?: GraphConversation[] })?.data ?? []) as GraphConversation[];
  const events = conversationsToEvents(conversations, pageId, now, platform);

  // Preview metadata (name/time) kept alongside, for the report only.
  const meta = new Map<string, { from: string; preview: string; at: string | null }>();
  for (const c of conversations) {
    for (const m of c.messages?.data ?? []) {
      if (m.id && m.from?.id && m.from.id !== pageId) {
        meta.set(m.id, {
          from: m.from.name ?? m.from.id,
          preview: (m.message ?? "").slice(0, 80),
          at: m.created_time ?? null,
        });
      }
    }
  }

  const admin = createAdminClient();
  const mids = events.map((e) => e.mid);
  const stored = new Set<string>();
  if (mids.length) {
    const { data: known, error } = await admin
      .from("messages")
      .select("meta_message_id")
      .in("meta_message_id", mids);
    // A failed lookup cannot tell "not stored" from "could not ask", and this
    // one gates whether we re-import — so fail loud rather than double-import.
    if (error) return { ...empty, conversations: conversations.length, error: error.message };
    for (const r of known ?? []) stored.add(r.meta_message_id as string);
  }

  const newEvents = events.filter((e) => !stored.has(e.mid));
  const report: BackfillReport = {
    platform,
    conversations: conversations.length,
    inboundFound: events.length,
    alreadyStored: events.length - newEvents.length,
    toImport: newEvents.length,
    samples: newEvents
      .slice(0, 25)
      .map((e) => meta.get(e.mid) ?? { from: e.customerId, preview: e.text.slice(0, 80), at: null }),
    hitCap: conversations.length >= max,
    error: null,
  };

  if (dryRun || !newEvents.length) return report;

  const result = await processMetaEvents(newEvents);
  report.imported = {
    created: result.created,
    appended: result.appended,
    skipped: result.skipped,
  };
  return report;
}
