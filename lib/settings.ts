import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_COMPANY, type CompanySettings } from "@/lib/email/template";

// Shared brand settings (single row in `settings`). Read on the send path and
// in the signature editor. Server-only.

/** The whole settings blob. Company branding and ops state share this row. */
export async function getSettingsBlob(): Promise<Record<string, unknown>> {
  const admin = createAdminClient();
  const { data } = await admin.from("settings").select("data").eq("id", true).maybeSingle();
  return (data?.data ?? {}) as Record<string, unknown>;
}

/** Shallow-merges keys into the settings blob, leaving the rest untouched. */
export async function patchSettingsBlob(
  patch: Record<string, unknown>,
  agentId?: string | null
): Promise<void> {
  const admin = createAdminClient();
  const current = await getSettingsBlob();
  const { error } = await admin.from("settings").upsert({
    id: true,
    data: { ...current, ...patch },
    updated_at: new Date().toISOString(),
    ...(agentId ? { updated_by: agentId } : {}),
  });
  if (error) throw new Error(error.message);
}

export async function getCompanySettings(): Promise<CompanySettings> {
  const stored = (await getSettingsBlob()) as Partial<CompanySettings>;
  // Merge over defaults so a partially-populated row can't render a
  // signature with missing company name or website.
  return { ...DEFAULT_COMPANY, ...stored };
}

export async function updateCompanySettings(
  patch: Partial<CompanySettings>,
  agentId: string
): Promise<void> {
  // Goes through the blob patcher so unrelated keys (ops/health state) in the
  // same row survive a branding save.
  await patchSettingsBlob(patch as Record<string, unknown>, agentId);
}
