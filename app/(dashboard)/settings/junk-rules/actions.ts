"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { humanizePostgresError } from "@/lib/supabase/errors";
import {
  dryRunJunkRule,
  type JunkDryRunResult,
} from "@/lib/junk-rules/engine";
import {
  parseJunkRuleRow,
  usablePatterns,
  validateJunkRule,
  type JunkRuleScope,
} from "@/lib/junk-rules/match";
import type { ActionResult } from "@/lib/types";

/**
 * Junk-rule editing. Admin-only, and every write goes through the ADMIN'S OWN
 * Supabase client so the junk_rules_admin RLS policy is the real gate — a bug
 * in these checks can't hand junk-rule editing to an ordinary agent. The
 * dry-run reads through the service-role client (it reaches spam_corrections,
 * which agents cannot read in full), which is safe because it only ever reads.
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

export interface JunkRuleDraftInput {
  id?: string;
  name: string;
  patterns: string[];
  scope: JunkRuleScope;
  reason: string;
}

function normalize(input: JunkRuleDraftInput) {
  return {
    name: (input.name ?? "").trim(),
    // Keep the raw (trimmed) phrases for storage; usablePatterns drops the
    // blanks. Stored lowercased is tempting but the UI should echo what was
    // typed, so we store trimmed-as-typed and lowercase only at match time.
    patterns: (input.patterns ?? []).map((p) => (p ?? "").trim()).filter(Boolean),
    scope: input.scope === "subject_body" ? ("subject_body" as const) : ("subject" as const),
    reason: (input.reason ?? "").trim(),
  };
}

export async function saveJunkRule(
  input: JunkRuleDraftInput
): Promise<ActionResult & { id?: string }> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit junk rules." };

  const draft = normalize(input);
  const problem = validateJunkRule(draft);
  if (problem) return { error: problem };

  const row = {
    name: draft.name,
    patterns: draft.patterns,
    scope: draft.scope,
    reason: draft.reason,
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { error } = await me.supabase
      .from("junk_rules")
      .update(row)
      .eq("id", input.id);
    if (error) return { error: humanizePostgresError(error, "Could not save the rule.") };
    revalidatePath("/settings/junk-rules");
    revalidatePath("/settings");
    return { ok: true, id: input.id };
  }

  // New rules go to the bottom, disabled — the same precedence discipline as
  // routing rules.
  const { data: last } = await me.supabase
    .from("junk_rules")
    .select("position")
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const position = ((last?.position as number | undefined) ?? -1) + 1;

  const { data: created, error } = await me.supabase
    .from("junk_rules")
    .insert({ ...row, position, enabled: false, created_by: me.id })
    .select("id")
    .single();
  if (error) return { error: humanizePostgresError(error, "Could not create the rule.") };

  revalidatePath("/settings/junk-rules");
  revalidatePath("/settings");
  return { ok: true, id: created.id as string };
}

/**
 * Enable or disable a junk rule.
 *
 * Enabling RE-VALIDATES the stored rule and then runs the false-positive gate:
 * if the pattern matches ANY message a human marked "not spam", enabling is
 * refused. Junking a customer a person deliberately rescued is the specific
 * harm this whole feature has to avoid, so it is blocked at the one moment it
 * could start happening, not merely warned about in a dry run somebody may have
 * skipped.
 */
export async function setJunkRuleEnabled(
  id: string,
  enabled: boolean
): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit junk rules." };

  if (enabled) {
    const { data: row, error } = await me.supabase
      .from("junk_rules")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return { error: humanizePostgresError(error, "Could not read the rule.") };
    if (!row) return { error: "That rule no longer exists." };

    const rule = parseJunkRuleRow(row as Record<string, unknown>);
    const problem = validateJunkRule(rule);
    if (problem) return { error: `Can't enable this rule yet — ${problem}` };

    const dry = await dryRunJunkRule(createAdminClient(), {
      patterns: rule.patterns,
      scope: rule.scope,
    });
    if (dry.error) {
      return { error: `Couldn't verify this rule before enabling — ${dry.error}` };
    }
    if (dry.falsePositives.length) {
      const first = dry.falsePositives[0];
      return {
        error:
          `Can't enable — this pattern matches ${dry.falsePositives.length} message` +
          `${dry.falsePositives.length === 1 ? "" : "s"} a human marked “not spam” ` +
          `(e.g. “${first.subject || "(no subject)"}” on “${first.pattern}”). ` +
          `Narrow the phrase so it can't re-junk a rescued customer.`,
      };
    }
  }

  const { error } = await me.supabase
    .from("junk_rules")
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: humanizePostgresError(error, "Could not save that.") };

  revalidatePath("/settings/junk-rules");
  revalidatePath("/settings");
  return { ok: true };
}

export async function deleteJunkRule(id: string): Promise<ActionResult> {
  const me = await requireAdmin();
  if (!me) return { error: "Only admins can edit junk rules." };

  const { error } = await me.supabase.from("junk_rules").delete().eq("id", id);
  if (error) return { error: humanizePostgresError(error, "Could not delete the rule.") };

  revalidatePath("/settings/junk-rules");
  revalidatePath("/settings");
  return { ok: true };
}

/** "Which of the last 90 days would this junk, and does it hit a rescued customer?" */
export async function testJunkRule(
  draft: JunkRuleDraftInput
): Promise<JunkDryRunResult> {
  const me = await requireAdmin();
  if (!me) {
    return {
      checked: 0,
      capped: false,
      windowDays: 90,
      matches: [],
      falsePositives: [],
      error: "Only admins can test junk rules.",
    };
  }

  const draftN = normalize(draft);
  if (!usablePatterns(draftN.patterns).length) {
    return {
      checked: 0,
      capped: false,
      windowDays: 90,
      matches: [],
      falsePositives: [],
      error: "Add a phrase first — a rule with none never matches anything.",
    };
  }

  return dryRunJunkRule(createAdminClient(), {
    patterns: draftN.patterns,
    scope: draftN.scope,
  });
}
