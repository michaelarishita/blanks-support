import { createAdminClient } from "@/lib/supabase/admin";
import { raiseSystemAlert } from "@/lib/alerts";
import { getPageAccessToken } from "./graph";

/**
 * Messenger's half of the reconciliation: compare what Meta says happened
 * against what we stored.
 *
 * The reason this exists is the same reason the mailbox version does. Every
 * other alarm watches a MECHANISM — is the subscription live, is the token
 * valid, did the webhook fire — and every outage so far found a new mechanism
 * to break. This asks the only question that stays right whatever breaks
 * next: is there a message in the Page inbox we have no record of?
 *
 * It is deliberately NOT built on the webhook log. Reconciling our record
 * against our record would find nothing; the whole point is that the Graph API
 * is an independent witness.
 */

const GRAPH = "https://graph.facebook.com/v21.0";
const DEFAULT_WINDOW_DAYS = 7;
/** Conversations per run. Bounded, and a full page is reported, never silent. */
const DEFAULT_MAX = 50;
/**
 * A message newer than this is not yet a discrepancy.
 *
 * The webhook queue drains after the response, and the heartbeat drains again
 * hourly. Anything inside the grace period may simply be in flight — flagging
 * it would make this alarm fire on healthy traffic, which is how an alarm
 * stops being read.
 */
const GRACE_MS = 60 * 60 * 1000;

export interface MetaDiscrepancy {
  mid: string;
  conversationId: string | null;
  from: string | null;
  preview: string;
  createdAt: string | null;
}

export interface MetaReconcileReport {
  windowDays: number;
  checkedAt: string;
  conversations: number;
  examined: number;
  accounted: { stored: number; tooRecent: number; fromUs: number };
  discrepancies: MetaDiscrepancy[];
  hitCap: boolean;
  /** Set when the check could not complete — never a clean run. */
  error: string | null;
}

async function graph(
  path: string,
  token: string
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const res = await fetch(
      `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      { cache: "no-store" }
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, error: message };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function reconcileMessenger(
  options: { days?: number; max?: number; now?: number } = {}
): Promise<MetaReconcileReport> {
  const windowDays = options.days ?? DEFAULT_WINDOW_DAYS;
  const max = options.max ?? DEFAULT_MAX;
  const now = options.now ?? Date.now();
  const empty: MetaReconcileReport = {
    windowDays,
    checkedAt: new Date(now).toISOString(),
    conversations: 0,
    examined: 0,
    accounted: { stored: 0, tooRecent: 0, fromUs: 0 },
    discrepancies: [],
    hitCap: false,
    error: null,
  };

  const pageId = process.env.META_PAGE_ID;
  if (!pageId) return { ...empty, error: "META_PAGE_ID is not set" };

  const token = await getPageAccessToken();
  if (!token) return { ...empty, error: "no page access token configured" };

  const since = Math.floor((now - windowDays * 86_400_000) / 1000);
  const listed = await graph(
    `${encodeURIComponent(pageId)}/conversations` +
      `?platform=messenger&limit=${max}` +
      `&fields=id,updated_time,messages.limit(25){id,created_time,from,message}`,
    token
  );
  if (!listed.ok) return { ...empty, error: listed.error };

  const conversations =
    (listed.body as {
      data?: {
        id?: string;
        updated_time?: string;
        messages?: {
          data?: { id?: string; created_time?: string; from?: { id?: string; name?: string }; message?: string }[];
        };
      }[];
    })?.data ?? [];

  // Everything Meta showed us, flattened. `from.id === pageId` is our own
  // outbound and is accounted for by definition — an echo we never stored is
  // a gap in the thread, not a lost customer message, and mixing the two
  // would bury the one that matters.
  const candidates: { mid: string; conversationId: string; createdAt: string | null; from: { id?: string; name?: string } | null; preview: string }[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages?.data ?? []) {
      if (!message.id) continue;
      const createdAt = message.created_time ?? null;
      if (createdAt && Date.parse(createdAt) < since * 1000) continue;
      candidates.push({
        mid: message.id,
        conversationId: conversation.id ?? "",
        createdAt,
        from: message.from ?? null,
        preview: (message.message ?? "").slice(0, 80),
      });
    }
  }

  if (!candidates.length) {
    return { ...empty, conversations: conversations.length, hitCap: conversations.length >= max };
  }

  const admin = createAdminClient();
  const { data: known, error: knownError } = await admin
    .from("messages")
    .select("meta_message_id")
    .in("meta_message_id", candidates.map((c) => c.mid));
  // A failed lookup cannot tell "we never stored it" from "we could not ask",
  // and the difference is the entire output of this job.
  if (knownError) return { ...empty, conversations: conversations.length, error: knownError.message };

  const stored = new Set((known ?? []).map((m) => m.meta_message_id as string));

  let stored_ = 0;
  let tooRecent = 0;
  let fromUs = 0;
  const discrepancies: MetaDiscrepancy[] = [];

  for (const candidate of candidates) {
    if (stored.has(candidate.mid)) {
      stored_++;
      continue;
    }
    if (candidate.from?.id && candidate.from.id === pageId) {
      fromUs++;
      continue;
    }
    if (candidate.createdAt && now - Date.parse(candidate.createdAt) < GRACE_MS) {
      tooRecent++;
      continue;
    }
    discrepancies.push({
      mid: candidate.mid,
      conversationId: candidate.conversationId || null,
      from: candidate.from?.name ?? candidate.from?.id ?? null,
      preview: candidate.preview,
      createdAt: candidate.createdAt,
    });
  }

  return {
    windowDays,
    checkedAt: new Date(now).toISOString(),
    conversations: conversations.length,
    examined: candidates.length,
    accounted: { stored: stored_, tooRecent, fromUs },
    discrepancies,
    hitCap: conversations.length >= max,
    error: null,
  };
}

const NAMED_IN_ALERT = 10;

/** Runs the check and raises the alarm if the Page holds mail we never saw. */
export async function runMessengerReconciliation(
  options: { days?: number; max?: number; now?: number } = {}
): Promise<MetaReconcileReport> {
  const report = await reconcileMessenger(options);

  if (report.error) {
    // Reported, not silent: while this cannot run, the one check that watches
    // the outcome is not watching.
    console.error("[meta] reconciliation could not run:", report.error);
    return report;
  }
  if (!report.discrepancies.length) return report;

  const named = report.discrepancies.slice(0, NAMED_IN_ALERT);
  const reasons = named.map(
    (d) => `${d.mid} — ${d.from ?? "unknown sender"} — ${d.preview || "(no text)"}`
  );
  if (report.discrepancies.length > named.length) {
    reasons.push(`…and ${report.discrepancies.length - named.length} more`);
  }

  await raiseSystemAlert({
    kind: "meta_reconciliation",
    title: `${report.discrepancies.length} Messenger message(s) never reached the inbox`,
    severity: "warning",
    reasons,
    detail:
      `Checked the last ${report.windowDays} days across ${report.conversations} conversation(s): ` +
      `${report.examined} messages, ${report.accounted.stored} stored, ` +
      `${report.accounted.fromUs} our own, ${report.accounted.tooRecent} too recent to judge. ` +
      "The messages above are none of those — they are in the Page inbox and we have no record of them.",
  });

  return report;
}
