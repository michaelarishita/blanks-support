import { describe, expect, it } from "vitest";
import { scoreClassifier, type LabeledExample } from "@/lib/inbound/harness";

/**
 * A message that clears the junk threshold: cold-outreach phrasing plus a
 * marketing footer plus mailing-list vocabulary, no customer language.
 */
// pitch phrasing (≥3 → weight 4) + marketing footer (weight 3) + a sales noun
// (weight 1) = 8, exactly the junk threshold.
const spammyText =
  "I came across your website and wanted to reach out. We help brands " +
  "increase your sales. Happy to share a case study. Book a call? " +
  "Unsubscribe here. All rights reserved.";

/** A plain customer message the classifier must NOT flag. */
const customerText = "My order arrived damaged and is leaking. I'd like a refund.";

describe("scoreClassifier — precision/recall of the junk gate", () => {
  it("reports an empty corpus without dividing by zero", () => {
    const r = scoreClassifier([]);
    expect(r.total).toBe(0);
    expect(r.precision).toBeNull();
    expect(r.recall).toBeNull();
  });

  it("counts a true positive: labelled spam the classifier junks", () => {
    const examples: LabeledExample[] = [
      { subject: "partnership", bodyText: spammyText, fromEmail: "x@y.com", label: "spam" },
    ];
    const r = scoreClassifier(examples);
    expect(r.truePositives).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.precision).toBe(1);
  });

  it("counts a false negative: labelled spam the classifier misses", () => {
    // A terse "spam" with no marketing machinery does not clear the high bar —
    // that is the deliberate bias, and it shows up as a false negative here.
    const examples: LabeledExample[] = [
      { subject: "hi", bodyText: "call me", fromEmail: "x@y.com", label: "spam" },
    ];
    const r = scoreClassifier(examples);
    expect(r.falseNegatives).toBe(1);
    expect(r.recall).toBe(0);
    expect(r.falseNegativeExamples.length).toBe(1);
  });

  it("counts a false positive: a customer the classifier would junk", () => {
    // The customer short-circuit means this should NOT happen — which is the
    // point of the test: a real customer message scores below the bar, so it is
    // a true negative, never a false positive.
    const examples: LabeledExample[] = [
      { subject: "refund", bodyText: customerText, fromEmail: "c@c.com", label: "not_spam" },
    ];
    const r = scoreClassifier(examples);
    expect(r.trueNegatives).toBe(1);
    expect(r.falsePositives).toBe(0);
  });

  it("computes precision and recall over a mixed corpus", () => {
    const examples: LabeledExample[] = [
      { subject: "a", bodyText: spammyText, fromEmail: "1@x.com", label: "spam" }, // TP
      { subject: "b", bodyText: "quick note", fromEmail: "2@x.com", label: "spam" }, // FN
      { subject: "c", bodyText: customerText, fromEmail: "3@x.com", label: "not_spam" }, // TN
    ];
    const r = scoreClassifier(examples);
    expect(r.truePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.trueNegatives).toBe(1);
    expect(r.falsePositives).toBe(0);
    expect(r.precision).toBe(1); // 1 / (1 + 0)
    expect(r.recall).toBe(0.5); // 1 / (1 + 1)
  });
});
