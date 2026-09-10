import type { ScoreReport } from "@/lib/inbound/harness";

/** A percentage, or an em-dash when the metric is undefined. */
function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * The classifier's precision/recall against the corrections corpus.
 *
 * Deliberately plain: it is a measurement, not a control. Nothing here changes
 * the classifier — that is the whole point of the correction loop. It only
 * shows what the numbers are so a person changes the rules with evidence.
 */
export default function ClassifierScore({ report }: { report: ScoreReport & { error: string | null } }) {
  if (report.error) {
    return (
      <p className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-text">
        The corrections corpus could not be read: {report.error}
      </p>
    );
  }

  if (report.total === 0) {
    return (
      <p className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
        No corrections yet — the corpus is empty, so there is nothing to score.
        It fills as the team marks tickets spam / not spam.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Precision" value={pct(report.precision)} hint="of junked, actually spam" />
        <Stat label="Recall" value={pct(report.recall)} hint="of spam, actually junked" />
        <Stat
          label="False positives"
          value={String(report.falsePositives)}
          hint="customers junked"
          tone={report.falsePositives > 0 ? "danger" : "muted"}
        />
        <Stat
          label="False negatives"
          value={String(report.falseNegatives)}
          hint="spam let through"
          tone="muted"
        />
      </div>

      <p className="text-xs text-gray-500">
        {report.total} labelled example{report.total === 1 ? "" : "s"} ·{" "}
        {report.labeledSpam} spam, {report.labeledNotSpam} not spam · junk
        threshold {report.threshold}.
      </p>

      {report.falsePositiveExamples.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer font-semibold text-danger-text">
            Customers the classifier would have junked ({report.falsePositives})
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {report.falsePositiveExamples.map((line, i) => (
              <li key={i} className="list-disc">{line}</li>
            ))}
          </ul>
        </details>
      )}

      {report.falseNegativeExamples.length > 0 && (
        <details className="text-xs text-gray-600">
          <summary className="cursor-pointer font-semibold text-gray-700">
            Spam the classifier would have missed ({report.falseNegatives})
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {report.falseNegativeExamples.map((line, i) => (
              <li key={i} className="list-disc">{line}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "muted",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "danger" | "muted";
}) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2">
      <div
        className={
          tone === "danger" && value !== "0"
            ? "text-lg font-semibold text-danger-text"
            : "text-lg font-semibold text-gray-900"
        }
      >
        {value}
      </div>
      <div className="text-xs font-medium text-gray-700">{label}</div>
      <div className="text-[11px] text-gray-500">{hint}</div>
    </div>
  );
}
