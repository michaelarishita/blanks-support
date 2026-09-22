import { createAdminClient } from "@/lib/supabase/admin";
import type { Classification } from "./classifier";

// The scoring harness — how the classifier is judged with evidence, not feel.
// Same discipline as Drop 29's spam harness.
//
// Each correction stores what the classifier said (classifier_verdict) and what
// the human said (corrected_label). Comparing the two measures the classifier
// AS DEPLOYED, with no need to re-run (and re-pay for) the model.
//
// "needs_you" is the positive class — the thing we surface. So:
//   false NEGATIVE — classifier said probably_not, human said needs_you.
//                    The COSTLY error: a real message was hidden. This is the
//                    one the prompt biases against, exactly like junking a
//                    customer.
//   false POSITIVE — classifier said needs_you, human said probably_not.
//                    The cheap error: one more piece of noise on screen.
//
// MEASURES ONLY. Nothing here adjusts the prompt or a threshold. A change to
// the classifier must be run against this corpus before it ships.

export interface TriageScore {
  total: number;
  labeledNeedsYou: number;
  labeledProbablyNot: number;
  truePositives: number;
  /** Classifier needs_you, human probably_not — noise shown. Cheap. */
  falsePositives: number;
  trueNegatives: number;
  /** Classifier probably_not, human needs_you — a hidden real message. Costly. */
  falseNegatives: number;
  /** TP / (TP + FP). Null when the classifier surfaced nothing. */
  precision: number | null;
  /** TP / (TP + FN). Null when nothing was actually needs_you. */
  recall: number | null;
  falsePositiveExamples: string[];
  falseNegativeExamples: string[];
}

interface CorrectionRow {
  subject: string | null;
  from_email: string | null;
  classifier_verdict: Classification | null;
  corrected_label: Classification | null;
}

export function scoreCorrections(rows: CorrectionRow[]): TriageScore {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const fpEx: string[] = [];
  const fnEx: string[] = [];

  for (const row of rows) {
    // A correction with no verdict recorded can't be scored either way.
    if (!row.corrected_label || !row.classifier_verdict) continue;
    const predictedNeedsYou = row.classifier_verdict === "needs_you";
    const actualNeedsYou = row.corrected_label === "needs_you";
    const line = `${row.from_email ?? "unknown"}: ${row.subject || "(no subject)"}`;

    if (predictedNeedsYou && actualNeedsYou) tp++;
    else if (predictedNeedsYou && !actualNeedsYou) {
      fp++;
      if (fpEx.length < 10) fpEx.push(line);
    } else if (!predictedNeedsYou && actualNeedsYou) {
      fn++;
      if (fnEx.length < 10) fnEx.push(line);
    } else tn++;
  }

  return {
    total: tp + fp + tn + fn,
    labeledNeedsYou: tp + fn,
    labeledProbablyNot: fp + tn,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    falsePositiveExamples: fpEx,
    falseNegativeExamples: fnEx,
  };
}

/** Scores the classifier against one owner's stored corrections. */
export async function scoreAgainstCorrections(
  ownerAgentId: string
): Promise<TriageScore & { error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("personal_triage_corrections")
    .select("subject, from_email, classifier_verdict, corrected_label")
    .eq("owner_agent_id", ownerAgentId);
  if (error) return { ...scoreCorrections([]), error: error.message };
  return { ...scoreCorrections((data ?? []) as CorrectionRow[]), error: null };
}
