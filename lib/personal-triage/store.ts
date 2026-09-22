import { createAdminClient } from "@/lib/supabase/admin";
import {
  listRecentInboxMessages,
  type PersonalMessageMeta,
} from "./gmail";
import {
  classifyMessage,
  CLASSIFIER_MODEL,
  type Classification,
} from "./classifier";

// Sync + persistence for the personal-triage view. Server-only.
//
// What is stored (0027): gmail id, sender, subject, date, Gmail's snippet, and
// the classification. NEVER the body — that is fetched on demand and never
// written down. Writes go through the service-role client because
// personal_messages has no agent INSERT policy: a browser can only READ its
// own rows (owner-only RLS), and only the server, having authorised the agent,
// writes them.

export interface SyncResult {
  scanned: number;
  classified: number;
  reused: number;
  needsYou: number;
  probablyNot: number;
  totalCostUsd: number;
  perMessageCostUsd: number | null;
  error: string | null;
}

/**
 * A prior human correction for the same sender is an explicit label — honour it
 * and skip the LLM. This closes the correction loop (a "wrong" click changes
 * how the next message from that sender is filed) and saves the API call.
 */
async function senderOverride(
  admin: ReturnType<typeof createAdminClient>,
  ownerAgentId: string,
  fromEmail: string | null
): Promise<Classification | null> {
  if (!fromEmail) return null;
  const { data } = await admin
    .from("personal_triage_corrections")
    .select("corrected_label")
    .eq("owner_agent_id", ownerAgentId)
    .eq("from_email", fromEmail)
    .order("corrected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const label = data?.corrected_label as Classification | undefined;
  return label ?? null;
}

/**
 * Lists recent inbox mail, classifies whatever is new, and upserts. Idempotent:
 * a message already stored is left alone (its classification, and any human
 * correction on top of it, is preserved).
 */
export async function syncAndClassify(
  ownerAgentId: string,
  max = 50
): Promise<SyncResult> {
  const empty: SyncResult = {
    scanned: 0,
    classified: 0,
    reused: 0,
    needsYou: 0,
    probablyNot: 0,
    totalCostUsd: 0,
    perMessageCostUsd: null,
    error: null,
  };

  let metas: PersonalMessageMeta[];
  try {
    metas = await listRecentInboxMessages(ownerAgentId, max);
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }

  const admin = createAdminClient();

  // Which of these have we already stored? Only classify the new ones.
  const ids = metas.map((m) => m.gmailMessageId);
  const { data: existingRows, error: existingError } = await admin
    .from("personal_messages")
    .select("gmail_message_id")
    .eq("owner_agent_id", ownerAgentId)
    .in("gmail_message_id", ids.length ? ids : ["__none__"]);
  if (existingError) return { ...empty, scanned: metas.length, error: existingError.message };
  const known = new Set((existingRows ?? []).map((r) => r.gmail_message_id as string));

  const result: SyncResult = { ...empty, scanned: metas.length };

  for (const meta of metas) {
    if (known.has(meta.gmailMessageId)) continue;

    let classification: Classification;
    let reason: string;
    let model = CLASSIFIER_MODEL;

    const override = await senderOverride(admin, ownerAgentId, meta.fromEmail);
    if (override) {
      classification = override;
      reason = "matches a previous correction for this sender";
      model = "override";
      result.reused++;
    } else {
      try {
        const verdict = await classifyMessage({
          fromEmail: meta.fromEmail,
          fromName: meta.fromName,
          subject: meta.subject,
          snippet: meta.snippet,
        });
        classification = verdict.classification;
        reason = verdict.reason;
        model = verdict.model;
        result.classified++;
        result.totalCostUsd += verdict.costUsd;
      } catch (e) {
        // A classifier that cannot run must not hide mail — default to needs_you.
        classification = "needs_you";
        reason = `could not classify (${e instanceof Error ? e.message : String(e)})`;
        model = "unclassified";
      }
    }

    if (classification === "needs_you") result.needsYou++;
    else result.probablyNot++;

    const { error: upsertError } = await admin.from("personal_messages").upsert(
      {
        owner_agent_id: ownerAgentId,
        gmail_message_id: meta.gmailMessageId,
        gmail_thread_id: meta.gmailThreadId,
        from_email: meta.fromEmail,
        from_name: meta.fromName,
        subject: meta.subject,
        message_date: meta.date.toISOString(),
        snippet: meta.snippet,
        classification,
        classifier_reason: reason,
        classifier_model: model,
        classified_at: new Date().toISOString(),
      },
      { onConflict: "owner_agent_id,gmail_message_id" }
    );
    if (upsertError) {
      // Record the failure but keep going — one bad row shouldn't abort the run.
      result.error = upsertError.message;
    }
  }

  result.perMessageCostUsd =
    result.classified > 0 ? result.totalCostUsd / result.classified : null;
  return result;
}
