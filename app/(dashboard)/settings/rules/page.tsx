import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMissingSchemaError } from "@/lib/supabase/errors";
import { agentDisplayName } from "@/lib/display";
import { parseRuleRow, type Rule } from "@/lib/rules/types";
import RulesEditor from "@/components/RulesEditor";
import { ArrowLeftIcon } from "@/components/ui/icons";
import type { Tag } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
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
  // Sent back to Settings rather than shown a refusal: an agent following a
  // link they can't use should land somewhere useful.
  if (me?.role !== "admin" || !me.is_active) redirect("/settings");

  const [{ data: ruleRows, error: rulesError }, { data: agentRows }, { data: tagRows }] =
    await Promise.all([
      supabase
        .from("rules")
        .select("*")
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      supabase
        .from("agents")
        .select("id, name, display_name")
        .eq("is_active", true)
        .order("name"),
      supabase.from("tags").select("id, name, color, is_topic").order("name"),
    ]);

  const rules: Rule[] = (ruleRows ?? []).map((row) =>
    parseRuleRow(row as Record<string, unknown>)
  );
  const agents = (agentRows ?? []).map((row) => ({
    id: row.id as string,
    name: agentDisplayName(row),
  }));
  const tags = (tagRows ?? []) as Tag[];

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1.5 text-caption text-tertiary hover:text-secondary"
      >
        <ArrowLeftIcon size={13} />
        Settings
      </Link>

      <h1 className="mt-3 text-2xl font-bold">Routing rules</h1>
      <p className="mt-1 text-sm text-gray-500">
        Applied top to bottom as tickets arrive. The first rule that assigns
        wins; tags, priorities and auto-replies stack.
      </p>

      {rulesError ? (
        <div className="mt-8 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
          <p className="font-semibold">Routing rules aren&apos;t set up yet.</p>
          <p className="mt-1">
            {isMissingSchemaError(rulesError)
              ? "Run supabase/migrations/0011_rules.sql in the Supabase SQL Editor, then reload this page."
              : rulesError.message}
          </p>
        </div>
      ) : (
        <RulesEditor rules={rules} agents={agents} tags={tags} />
      )}
    </div>
  );
}
