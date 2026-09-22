"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { syncTriage, loadBody, correct } from "@/app/(dashboard)/triage/actions";

export interface TriageRow {
  gmail_message_id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  message_date: string | null;
  snippet: string | null;
  classification: "needs_you" | "probably_not";
  classifier_reason: string | null;
}

interface ScoreSummary {
  total: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  error: string | null;
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export default function PersonalTriage({
  connectedAs,
  messages,
  score,
}: {
  connectedAs: string;
  messages: TriageRow[];
  score: ScoreSummary;
}) {
  const router = useRouter();
  const [syncing, startSync] = useTransition();
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const [needsYou, probablyNot] = useMemo(() => {
    const a: TriageRow[] = [];
    const b: TriageRow[] = [];
    for (const m of messages) {
      (m.classification === "needs_you" ? a : b).push(m);
    }
    return [a, b];
  }, [messages]);

  function runSync() {
    setSyncNote(null);
    startSync(async () => {
      const res = await syncTriage();
      if (res.error) {
        setSyncNote(`Sync error: ${res.error}`);
      } else {
        const cost =
          res.perMessageCostUsd !== null
            ? ` · $${res.perMessageCostUsd.toFixed(4)}/msg`
            : "";
        setSyncNote(
          `Scanned ${res.scanned} · classified ${res.classified}` +
            (res.reused ? ` · ${res.reused} from corrections` : "") +
            cost
        );
      }
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-3 sm:p-4">
      <header className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-gray-900">Personal triage</h1>
          <button
            onClick={runSync}
            disabled={syncing}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Read-only over <span className="font-medium">{connectedAs}</span>.
          Nothing here is changed in Gmail, and only you can see it.
        </p>
        {syncNote && <p className="text-xs text-gray-600">{syncNote}</p>}
        {score.total > 0 && (
          <p className="text-xs text-gray-500">
            Accuracy on {score.total} correction{score.total === 1 ? "" : "s"}:
            precision {pct(score.precision)}, recall {pct(score.recall)} ·{" "}
            {score.falseNegatives} hidden-by-mistake, {score.falsePositives}{" "}
            shown-by-mistake
          </p>
        )}
      </header>

      <Bucket
        title="Needs you"
        empty="Nothing flagged for you."
        rows={needsYou}
        // On a needs-you row, the correction is "this was noise".
        correctTo="probably_not"
        correctLabel="Not important"
      />
      <Bucket
        title="Probably not"
        empty="Nothing here."
        rows={probablyNot}
        correctTo="needs_you"
        correctLabel="Needs me"
      />
    </div>
  );
}

function Bucket({
  title,
  empty,
  rows,
  correctTo,
  correctLabel,
}: {
  title: string;
  empty: string;
  rows: TriageRow[];
  correctTo: "needs_you" | "probably_not";
  correctLabel: string;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-700">
        {title}
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-500">
          {rows.length}
        </span>
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-400">{empty}</p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {rows.map((row) => (
            <Row
              key={row.gmail_message_id}
              row={row}
              correctTo={correctTo}
              correctLabel={correctLabel}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  row,
  correctTo,
  correctLabel,
}: {
  row: TriageRow;
  correctTo: "needs_you" | "probably_not";
  correctLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [correcting, startCorrect] = useTransition();
  const router = useRouter();

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && body === null && !loading) {
      startLoad(async () => {
        const res = await loadBody(row.gmail_message_id);
        if (res.error) setBodyError(res.error);
        else setBody(res.bodyText ?? "");
      });
    }
  }

  function applyCorrection(e: React.MouseEvent) {
    e.stopPropagation();
    startCorrect(async () => {
      await correct(row.gmail_message_id, correctTo);
      router.refresh();
    });
  }

  const sender = row.from_name || row.from_email || "Unknown sender";

  return (
    <li>
      <button
        onClick={toggle}
        className="flex w-full flex-col gap-0.5 px-3 py-2.5 text-left hover:bg-gray-50"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-gray-900">{sender}</span>
          <span className="flex-none text-xs text-gray-400">
            {shortDate(row.message_date)}
          </span>
        </div>
        <span className="truncate text-sm text-gray-700">
          {row.subject || "(no subject)"}
        </span>
        <span className="truncate text-xs text-gray-400">{row.snippet}</span>
        {row.classifier_reason && (
          <span className="mt-0.5 truncate text-xs italic text-gray-400">
            {row.classifier_reason}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 bg-gray-50 px-3 py-2.5">
          {loading && <p className="text-xs text-gray-400">Loading message…</p>}
          {bodyError && <p className="text-xs text-red-600">{bodyError}</p>}
          {body !== null && (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-gray-800">
              {body || "(empty message)"}
            </pre>
          )}
          <div className="mt-2.5 flex justify-end">
            <button
              onClick={applyCorrection}
              disabled={correcting}
              className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-white disabled:opacity-50"
            >
              {correcting ? "Saving…" : correctLabel}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
