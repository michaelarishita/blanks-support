import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_COMPANY, type CompanySettings } from "@/lib/email/template";

// Shared brand settings (single row in `settings`). Read on the send path and
// in the signature editor. Server-only.

export async function getCompanySettings(): Promise<CompanySettings> {
  const admin = createAdminClient();
  const { data } = await admin.from("settings").select("data").eq("id", true).maybeSingle();

  const stored = (data?.data ?? {}) as Partial<CompanySettings>;
  // Merge over defaults so a partially-populated row can't render a
  // signature with missing company name or website.
  return { ...DEFAULT_COMPANY, ...stored };
}

export async function updateCompanySettings(
  patch: Partial<CompanySettings>,
  agentId: string
): Promise<void> {
  const admin = createAdminClient();
  const current = await getCompanySettings();
  const { error } = await admin
    .from("settings")
    .upsert({
      id: true,
      data: { ...current, ...patch },
      updated_at: new Date().toISOString(),
      updated_by: agentId,
    });
  if (error) throw new Error(error.message);
}
