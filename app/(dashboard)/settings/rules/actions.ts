"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { humanizePostgresError } from "@/lib/supabase/errors";
import { plainField } from "@/lib/fields";
import { dryRunRule, type DryRunResult } from "@/lib/rules/engine";
import {
  MAX_RULE_NAME,
  parseRuleRow,
  validateRule,
  type RuleDraft,
  type ValidationContext,
} from "@/lib/rules/types";
import type { ActionResult } from "@/lib/types";

/**
 * Rule editing. Admin-only, and every write goes through the ADMIN'S OWN
 * Supabase client rather than the service-role one — the rules_admin policy is
 * what actually enforces the restriction, so a bug in the checks here can't
 * hand rule editing to an ordinary agent.
 */
async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: me } = await supabase
    .from("agents")
    .select("id, role, is_active")
    .eq("id", user.id)
    .single();
  if (!me?.is_active || me.role !== "admin") return null;

  return { supabase, id: me.id as string };
}

/** Tags and agents a rule is allowed to reference. */
async function validationContext(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<ValidationContext> {
  const [{ data: tags }, { data: agents }] = await Promise.all([
    supabase.from("tags").select("id, name"),
    supabase.from("agents").select("id").eq("is_active", true),
  ]);
  return {
    tagNames: (tags ?? []).map((tag) => tag.name as string),
    tagIds: (tags ?? []).map((tag) => tag.id as string),
    agentIds: (agents ?? []).map((agent) => agent.id as string),
  };
}

function normalizeDraft(draft: RuleDraft): RuleDraft {
  return {
    ...draft,
    name: plainField(draft.name, MAX_RULE_NAME) ?? "",
    conditions: (draft.conditions ?? []).map((condition) => ({
      ...condition,
      value: (condition.value ?? "").trim(),
    })),
    actions: (draft.actions ?? []).map((action) =>
      action.type === "reply" ? { ...action, body: (action.body ?? "").trim() } : action
    ),
  };
}

export async function saveRule(
  input: RuleDraft & { id?: string }
): Promise<ActionResult & { id?: string }> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit routing rules." };

  const draft = normalizeDraft(input);
  const problem = validateRule(draft, await validationContext(me.supabase));
  if (problem) return { error: problem };

  const row = {
    name: draft.name,
    trigger_on: draft.trigger_on,
    match_type: draft.match_type,
    conditions: draft.conditions,
    actions: draft.actions,
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { error } = await me.supabase.from("rules").update(row).eq("id", input.id);
    if (error) return { error: humanizePostgresError(error, "Could not save the rule.") };
    revalidatePath("/settings/rules");
    revalidatePath("/settings");
    return { ok: true, id: input.id };
  }

  // New rules go to the bottom. Anything else would silently change the
  // precedence of rules that are already live.
  const { data: last } = await me.supabase
    .from("rules")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = ((last?.position as number | undefined) ?? -1) + 1;

  const { data: created, error } = await me.supabase
    .from("rules")
    .insert({ ...row, position, enabled: false, created_by: me.id })
    .select("id")
    .single();
  if (error) return { error: humanizePostgresError(error, "Could not create the rule.") };

  revalidatePath("/settings/rules");
  revalidatePath("/settings");
  return { ok: true, id: created.id as string };
}

/**
 * Turns a rule on or off.
 *
 * Enabling REVALIDATES the stored rule rather than trusting that it was
 * checked on the way in. The seed rules are inserted by SQL and never touch
 * saveRule, so "Wholesale → tag and route" ships with no assignee — without
 * this check it could be switched on and would then fire an assign action at
 * nobody on every wholesale enquiry, silently.
 */
export async function setRuleEnabled(
  id: string,
  enabled: boolean
): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit routing rules." };

  if (enabled) {
    const { data: row, error } = await me.supabase
      .from("rules")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return { error: humanizePostgresError(error, "Could not read the rule.") };
    if (!row) return { error: "That rule no longer exists." };

    const rule = parseRuleRow(row as Record<string, unknown>);
    const problem = validateRule(rule, await validationContext(me.supabase));
    if (problem) return { error: `Can't enable this rule yet — ${problem}` };
  }

  const { error } = await me.supabase
    .from("rules")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: humanizePostgresError(error, "Could not save that.") };

  revalidatePath("/settings/rules");
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteRule(id: string): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit routing rules." };

  const { error } = await me.supabase.from("rules").delete().eq("id", id);
  if (error) return { error: humanizePostgresError(error, "Could not delete the rule.") };

  revalidatePath("/settings/rules");
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Rewrites the whole order from the list the client is showing.
 *
 * Sending the full order rather than a swap means the stored positions always
 * end up as 0..n-1 with no gaps, and a reorder issued against a stale list
 * can't interleave two rules into the same slot.
 */
export async function reorderRules(ids: string[]): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit routing rules." };

  const { data: existing, error: readError } = await me.supabase
    .from("rules")
    .select("id");
  if (readError) {
    return { error: humanizePostgresError(readError, "Could not reorder the rules.") };
  }

  const known = new Set((existing ?? []).map((row) => row.id as string));
  // Refuse a partial list. Writing 0..n-1 over a subset would give the omitted
  // rules positions that collide with the ones being written.
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    return { error: "The rule list changed — reload the page and try again." };
  }

  for (const [index, id] of ids.entries()) {
    const { error } = await me.supabase
      .from("rules")
      .update({ position: index })
      .eq("id", id);
    if (error) {
      return { error: humanizePostgresError(error, "Could not reorder the rules.") };
    }
  }

  revalidatePath("/settings/rules");
  revalidatePath("/settings");
  return { ok: true };
}

/** "Which of the last 50 tickets would this have matched?" */
export async function testRule(draft: RuleDraft): Promise<DryRunResult> {
  const me = await requireAdmin();
  if (!me) {
    return { checked: 0, matches: [], error: "Only admins can test routing rules." };
  }

  const normalized = normalizeDraft(draft);
  if (!normalized.conditions.length) {
    return {
      checked: 0,
      matches: [],
      error: "Add a condition first — a rule with none never matches anything.",
    };
  }

  return dryRunRule(normalized);
}
