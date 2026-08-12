import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client — server-side only (intake API, webhooks).
// Bypasses RLS; never import this in client components.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
