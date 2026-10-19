import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMissingSchemaError } from "@/lib/supabase/errors";
import { parseJunkRuleRow } from "@/lib/junk-rules/match";
import JunkRulesEditor, {
  type EditableJunkRule,
} from "@/components/JunkRulesEditor";
import { ArrowLeftIcon } from "@/components/ui/icons";

export const dynamic = "force-dynamic";

export default async function JunkRulesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("agents")
    .select("id, role, is_active")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin" || !me.is_active) redirect("/settings");

  const { data: ruleRows, error } = await supabase
    .from("junk_rules")
    .select("*")
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });

  const rules: EditableJunkRule[] = (ruleRows ?? []).map((row) => {
    const r = parseJunkRuleRow(row as Record<string, unknown>);
    return {
      id: r.id,
      name: r.name,
      patterns: r.patterns,
      scope: r.scope,
      reason: r.reason,
      enabled: r.enabled,
    };
  });

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1.5 text-caption text-tertiary hover:text-secondary"
      >
        <ArrowLeftIcon size={13} />
        Settings
      </Link>

      <h1 className="mt-3 text-2xl font-bold">Junk rules</h1>
      <p className="mt-1 text-sm text-gray-500">
        A subject-match rule files matching new tickets straight to Junk — for
        senders who rotate domains faster than a sender block can keep up. Every
        rule ships disabled; dry-run it before enabling, and enabling is blocked
        if it would re-junk anyone a human marked “not spam”. Every match is
        recorded on the ticket and reversible with “Not spam”.
      </p>

      {error ? (
        <div className="mt-8 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
          <p className="font-semibold">Junk rules aren&apos;t set up yet.</p>
          <p className="mt-1">
            {isMissingSchemaError(error)
              ? "Run supabase/migrations/0031_junk_rules.sql in the Supabase SQL Editor, then reload this page."
              : error.message}
          </p>
        </div>
      ) : (
        <JunkRulesEditor rules={rules} />
      )}
    </div>
  );
}
