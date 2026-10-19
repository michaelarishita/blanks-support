"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/Toast";
import {
  saveJunkRule,
  setJunkRuleEnabled,
  deleteJunkRule,
  testJunkRule,
} from "@/app/(dashboard)/settings/junk-rules/actions";
import type { JunkDryRunResult } from "@/lib/junk-rules/engine";
import type { JunkRuleScope } from "@/lib/junk-rules/match";

export interface EditableJunkRule {
  id: string;
  name: string;
  patterns: string[];
  scope: JunkRuleScope;
  reason: string;
  enabled: boolean;
}

interface Draft {
  id?: string;
  name: string;
  patternsText: string; // one phrase per line, as typed
  scope: JunkRuleScope;
  reason: string;
}

const emptyDraft = (): Draft => ({
  name: "",
  patternsText: "",
  scope: "subject",
  reason: "",
});

function toDraft(rule: EditableJunkRule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    patternsText: rule.patterns.join("\n"),
    scope: rule.scope,
    reason: rule.reason,
  };
}

function patternsOf(text: string): string[] {
  return text
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

export default function JunkRulesEditor({ rules }: { rules: EditableJunkRule[] }) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dry, setDry] = useState<JunkDryRunResult | null>(null);
  const [pending, start] = useTransition();

  function openNew() {
    setDry(null);
    setDraft(emptyDraft());
  }
  function openEdit(rule: EditableJunkRule) {
    setDry(null);
    setDraft(toDraft(rule));
  }
  function close() {
    setDraft(null);
    setDry(null);
  }

  function toggle(rule: EditableJunkRule) {
    start(async () => {
      const res = await setJunkRuleEnabled(rule.id, !rule.enabled);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(rule.enabled ? "Rule disabled" : "Rule enabled", { tone: "success" });
      router.refresh();
    });
  }

  function remove(rule: EditableJunkRule) {
    start(async () => {
      const res = await deleteJunkRule(rule.id);
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast("Rule deleted", { tone: "success" });
      if (draft?.id === rule.id) close();
      router.refresh();
    });
  }

  function save() {
    if (!draft) return;
    start(async () => {
      const res = await saveJunkRule({
        id: draft.id,
        name: draft.name,
        patterns: patternsOf(draft.patternsText),
        scope: draft.scope,
        reason: draft.reason,
      });
      if (res?.error) {
        toast(res.error, { tone: "error" });
        return;
      }
      toast(draft.id ? "Rule saved" : "Rule created (disabled)", { tone: "success" });
      close();
      router.refresh();
    });
  }

  function test() {
    if (!draft) return;
    start(async () => {
      const res = await testJunkRule({
        name: draft.name,
        patterns: patternsOf(draft.patternsText),
        scope: draft.scope,
        reason: draft.reason,
      });
      setDry(res);
    });
  }

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">
          {rules.length} rule{rules.length === 1 ? "" : "s"}
        </h2>
        {!draft && (
          <button
            type="button"
            onClick={openNew}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
          >
            New junk rule
          </button>
        )}
      </div>

      {/* Existing rules */}
      <ul className="mt-4 space-y-2">
        {rules.map((rule) => (
          <li
            key={rule.id}
            className="rounded-xl border border-gray-200 bg-white px-4 py-3"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-gray-900">
                    {rule.name}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      rule.enabled
                        ? "bg-success-bg text-success-text"
                        : "bg-gray-100 text-gray-500"
                    )}
                  >
                    {rule.enabled ? "Live" : "Off"}
                  </span>
                </div>
                <p className="mt-1 text-caption text-gray-500">
                  Matches {rule.scope === "subject_body" ? "subject + body" : "subject"} ·{" "}
                  {rule.patterns.map((p) => `“${p}”`).join(", ")}
                </p>
                <p className="mt-0.5 text-caption text-gray-400">{rule.reason}</p>
              </div>
              <div className="flex flex-none items-center gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => toggle(rule)}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  {rule.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => openEdit(rule)}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(rule)}
                  className="rounded-lg border border-danger-border px-2.5 py-1 text-xs font-semibold text-danger-text hover:bg-danger-bg disabled:opacity-60"
                >
                  Delete
                </button>
              </div>
            </div>
          </li>
        ))}
        {!rules.length && (
          <li className="rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
            No junk rules yet.
          </li>
        )}
      </ul>

      {/* Editor */}
      {draft && (
        <div className="mt-6 rounded-xl border border-gray-300 bg-gray-50 p-5">
          <h3 className="text-sm font-semibold text-gray-800">
            {draft.id ? "Edit rule" : "New junk rule"}
          </h3>

          <label className="mt-4 block text-xs font-semibold text-gray-600">
            Name
          </label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="The Running Event (TRE)"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />

          <label className="mt-4 block text-xs font-semibold text-gray-600">
            Phrases to match — one per line, case-insensitive
          </label>
          <textarea
            value={draft.patternsText}
            onChange={(e) => setDraft({ ...draft, patternsText: e.target.value })}
            rows={4}
            placeholder={"the running event\ntre 2026"}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
          />
          <p className="mt-1 text-caption text-gray-500">
            A ticket is junked if any phrase appears as a substring. Keep phrases
            specific — the dry run below shows what each would catch.
          </p>

          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-gray-600">Match against</legend>
            <div className="mt-1 flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="scope"
                  checked={draft.scope === "subject"}
                  onChange={() => setDraft({ ...draft, scope: "subject" })}
                />
                Subject only
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="scope"
                  checked={draft.scope === "subject_body"}
                  onChange={() => setDraft({ ...draft, scope: "subject_body" })}
                />
                Subject + body
              </label>
            </div>
          </fieldset>

          <label className="mt-4 block text-xs font-semibold text-gray-600">
            Reason (shown on every ticket this rule junks)
          </label>
          <textarea
            value={draft.reason}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
            rows={2}
            placeholder="Trade-show attendee-list spam; they rotate sender domains."
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={save}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
            >
              {draft.id ? "Save" : "Create (disabled)"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={test}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-white disabled:opacity-60"
            >
              Dry run (last 90 days)
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={close}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>

          {dry && <DryRunReport dry={dry} />}
        </div>
      )}
    </div>
  );
}

function DryRunReport({ dry }: { dry: JunkDryRunResult }) {
  if (dry.error) {
    return (
      <div className="mt-4 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-text">
        {dry.error}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {/* False positives — the gate. Loud, first. */}
      {dry.falsePositives.length > 0 ? (
        <div className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5 text-sm text-danger-text">
          <p className="font-semibold">
            ⚠ {dry.falsePositives.length} false positive
            {dry.falsePositives.length === 1 ? "" : "s"} — this pattern matches
            mail a human marked “not spam”.
          </p>
          <ul className="mt-1.5 space-y-1">
            {dry.falsePositives.slice(0, 8).map((fp, i) => (
              <li key={i} className="text-caption">
                “{fp.subject || "(no subject)"}” — {fp.fromEmail ?? "unknown"} ·
                matched “{fp.pattern}”
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-caption">
            Enabling is blocked until this is zero. Narrow the phrase.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-success-border bg-success-bg px-3 py-2 text-sm text-success-text">
          No false positives — the pattern matches nothing a human has marked
          “not spam”.
        </div>
      )}

      {/* Historical matches */}
      <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
        <p className="text-sm font-semibold text-gray-700">
          {dry.matches.length} ticket
          {dry.matches.length === 1 ? "" : "s"} in the last {dry.windowDays} days
          would match
          {dry.capped ? " (window is capped — coverage is partial)" : ""}.
        </p>
        {dry.matches.length > 0 && (
          <ul className="mt-2 space-y-1">
            {dry.matches.slice(0, 25).map((m) => (
              <li
                key={m.id}
                className={cn(
                  "text-caption",
                  m.correctedNotSpam ? "font-semibold text-danger-text" : "text-gray-600"
                )}
              >
                #{m.number} · {m.status} · “{m.subject || "(no subject)"}” ·{" "}
                {m.customerEmail ?? "no email"}
                {m.correctedNotSpam ? " — RESCUED by a human, do not junk" : ""}
              </li>
            ))}
            {dry.matches.length > 25 && (
              <li className="text-caption text-gray-400">
                …and {dry.matches.length - 25} more.
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
