import { describe, expect, it } from "vitest";
import { scoreCorrections } from "@/lib/personal-triage/harness";

// The harness scores the classifier's stored verdict against the human's label.
// "needs_you" is the positive class (the thing surfaced), so:
//   FN = classifier said probably_not, human said needs_you  → hidden real mail
//        (the COSTLY error the prompt biases against)
//   FP = classifier said needs_you, human said probably_not  → noise shown

describe("scoreCorrections", () => {
  it("counts the four cells with needs_you as the positive class", () => {
    const s = scoreCorrections([
      // TP
      { subject: "a", from_email: "a@x.com", classifier_verdict: "needs_you", corrected_label: "needs_you" },
      // FP — noise shown
      { subject: "b", from_email: "b@x.com", classifier_verdict: "needs_you", corrected_label: "probably_not" },
      // FN — hidden real mail
      { subject: "c", from_email: "c@x.com", classifier_verdict: "probably_not", corrected_label: "needs_you" },
      // TN
      { subject: "d", from_email: "d@x.com", classifier_verdict: "probably_not", corrected_label: "probably_not" },
    ]);
    expect(s.truePositives).toBe(1);
    expect(s.falsePositives).toBe(1);
    expect(s.falseNegatives).toBe(1);
    expect(s.trueNegatives).toBe(1);
    expect(s.total).toBe(4);
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBeCloseTo(0.5);
  });

  it("reports the costly false negative in its own list", () => {
    const s = scoreCorrections([
      { subject: "urgent", from_email: "real@customer.com", classifier_verdict: "probably_not", corrected_label: "needs_you" },
    ]);
    expect(s.falseNegatives).toBe(1);
    expect(s.falseNegativeExamples[0]).toContain("real@customer.com");
    expect(s.falsePositives).toBe(0);
  });

  it("returns null precision/recall rather than lying with a zero", () => {
    // No positive predictions and no actual positives.
    const s = scoreCorrections([
      { subject: "x", from_email: null, classifier_verdict: "probably_not", corrected_label: "probably_not" },
    ]);
    expect(s.precision).toBeNull();
    expect(s.recall).toBeNull();
  });

  it("skips rows missing a verdict or a label — they can't be scored", () => {
    const s = scoreCorrections([
      { subject: "x", from_email: null, classifier_verdict: null, corrected_label: "needs_you" },
      { subject: "y", from_email: null, classifier_verdict: "needs_you", corrected_label: null },
    ]);
    expect(s.total).toBe(0);
  });
});
