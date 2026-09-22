import { createAdminClient } from "@/lib/supabase/admin";
import type { Classification } from "./classifier";

// The correction loop, reused in shape from Drop 29's spam corrections.
//
// A "wrong" click on either bucket stores a labelled correction: the message
// snapshot, the classifier's verdict AND reason at the time, and the human's
// label. That row is the eval asset the harness scores against, and it also
// becomes a per-sender override the next sync honours (see store.ts).
//
// Snapshotted fields (from_email, subject, snippet) so the correction survives
// the message row being re-synced — and, like everything here, NO body.
//
// All writes use the service-role client: the calling server action has already
// authorised the owner, and personal_triage_corrections is owner-read-only
// under RLS with no agent write policy.

export interface CorrectionResult {
  error?: string;
  correctionId?: string;
}

/**
 * Records that the classifier got one message wrong and flips its stored
 * classification to the human's label, so the view reflects the correction at
 * once.
 */
export async function correctTriage(
  ownerAgentId: string,
  gmailMessageId: string,
  correctedLabel: Classification
): Promise<CorrectionResult> {
  const admin = createAdminClient();

  const { data: message, error: readError } = await admin
    .from("personal_messages")
    .select("id, from_email, subject, snippet, classification, classifier_reason")
    .eq("owner_agent_id", ownerAgentId)
    .eq("gmail_message_id", gmailMessageId)
    .maybeSingle();
  if (readError) return { error: readError.message };
  if (!message) return { error: "Message not found." };

  const { data: correction, error: insertError } = await admin
    .from("personal_triage_corrections")
    .upsert(
      {
        owner_agent_id: ownerAgentId,
        personal_message_id: message.id,
        gmail_message_id: gmailMessageId,
        from_email: message.from_email,
        subject: message.subject,
        snippet: message.snippet,
        classifier_verdict: message.classification,
        classifier_reason: message.classifier_reason,
        corrected_label: correctedLabel,
        corrected_at: new Date().toISOString(),
      },
      { onConflict: "owner_agent_id,gmail_message_id" }
    )
    .select("id")
    .single();
  if (insertError) return { error: insertError.message };

  // Reflect the human's label immediately on the message row.
  const { error: updateError } = await admin
    .from("personal_messages")
    .update({ classification: correctedLabel })
    .eq("id", message.id);
  if (updateError) return { error: updateError.message };

  return { correctionId: correction.id as string };
}
