import { createAdminClient } from "@/lib/supabase/admin";
import {
  assessVendorOutreach,
  VENDOR_JUNK_THRESHOLD,
} from "@/lib/vendor/outreach";

/**
 * The scoring harness — how the classifier is CHANGED with evidence, not feel.
 *
 * Corrections give us the labelled corpus we never had. This runs the CURRENT
 * classifier against every stored correction and reports precision and recall,
 * split into the two errors that matter differently:
 *
 *   false positive — classifier says spam, a human said NOT spam. The costly
 *                    one: this is junking a customer.
 *   false negative — classifier says not spam, a human said spam. The cheap
 *                    one: five seconds of an agent's time.
 *
 * DELIBERATELY NOT an auto-retrainer. Nothing here adjusts a threshold or a
 * phrase list; it only MEASURES. Any future rule change must be run against
 * this corpus before it ships, and the whole reason we bias toward false
 * negatives is that the alternative is discarding real customers — which is
 * exactly what a filter that "optimises" itself on accumulated corrections
 * eventually does.
 */

export interface LabeledExample {
  subject: string;
  bodyText: string;
  fromEmail: string | null;
  bulkMarker?: string | null;
  /** The human's verdict — the ground truth. */
  label: "spam" | "not_spam";
  /** For reporting which examples the classifier got wrong. */
  ref?: string;
}

export interface ScoreReport {
  total: number;
  labeledSpam: number;
  labeledNotSpam: number;
  truePositives: number;
  /** Classifier said spam, human said not_spam — a junked customer. */
  falsePositives: number;
  trueNegatives: number;
  /** Classifier said not_spam, human said spam — spam that reached the inbox. */
  falseNegatives: number;
  /** TP / (TP + FP). Null when the classifier made no positive prediction. */
  precision: number | null;
  /** TP / (TP + FN). Null when the corpus contains no actual spam. */
  recall: number | null;
  /** A few of each, for the human reading the report. */
  falsePositiveExamples: string[];
  falseNegativeExamples: string[];
  threshold: number;
}

/**
 * Pure: the classifier's spam decision here is EXACTLY the one the live sync
 * makes — score at or above the junk threshold. So this measures the real
 * junk gate, not a proxy for it.
 */
export function scoreClassifier(examples: LabeledExample[]): ScoreReport {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const fpEx: string[] = [];
  const fnEx: string[] = [];

  for (const ex of examples) {
    const assessment = assessVendorOutreach({
      subject: ex.subject,
      bodyText: ex.bodyText,
      fromEmail: ex.fromEmail,
      bulkMarker: ex.bulkMarker ?? null,
      // Text-only, matching the live junk gate: the live decision does not run
      // a Shopify lookup at filing time either.
      shopifyCustomerFound: null,
      priorTicketCount: 0,
    });
    const predictedSpam = assessment.score >= VENDOR_JUNK_THRESHOLD;
    const actualSpam = ex.label === "spam";
    const ref = ex.ref ? `${ex.ref} — ` : "";
    const line = `${ref}score ${assessment.score}: ${ex.subject || "(no subject)"}`;

    if (predictedSpam && actualSpam) tp++;
    else if (predictedSpam && !actualSpam) {
      fp++;
      if (fpEx.length < 10) fpEx.push(line);
    } else if (!predictedSpam && actualSpam) {
      fn++;
      if (fnEx.length < 10) fnEx.push(line);
    } else tn++;
  }

  return {
    total: examples.length,
    labeledSpam: tp + fn,
    labeledNotSpam: fp + tn,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    falsePositiveExamples: fpEx,
    falseNegativeExamples: fnEx,
    threshold: VENDOR_JUNK_THRESHOLD,
  };
}

/** Loads the labelled corpus from stored corrections (excluding undone ones). */
export async function loadCorrectionCorpus(): Promise<{
  examples: LabeledExample[];
  error: string | null;
}> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spam_corrections")
    .select("id, subject, body_text, from_email, label, ticket_id")
    .is("undone_at", null);
  if (error) return { examples: [], error: error.message };

  const examples: LabeledExample[] = (data ?? []).map((row) => ({
    subject: (row.subject as string) ?? "",
    bodyText: (row.body_text as string) ?? "",
    fromEmail: (row.from_email as string | null) ?? null,
    label: row.label as "spam" | "not_spam",
    ref: (row.ticket_id as string | null)?.slice(0, 8) ?? (row.id as string).slice(0, 8),
  }));
  return { examples, error: null };
}

/** The number the Settings screen shows, and the pre-merge check runs. */
export async function scoreAgainstCorrections(): Promise<
  ScoreReport & { error: string | null }
> {
  const { examples, error } = await loadCorrectionCorpus();
  if (error) return { ...scoreClassifier([]), error };
  return { ...scoreClassifier(examples), error: null };
}
