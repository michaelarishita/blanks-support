-- ============================================================
-- Blanks Support — brand asset storage
-- Run in the Supabase SQL Editor after 0003_signature.sql.
-- ============================================================

-- Public bucket for the email logo. It has to be public: an email client
-- fetches the image with no session, so a signed URL would 403 (and expire).
insert into storage.buckets (id, name, public)
values ('brand', 'brand', true)
on conflict (id) do nothing;

-- No storage RLS policies are needed here. Reads are public by virtue of the
-- bucket flag, and uploads go through the service-role client in the
-- uploadBrandLogo server action, which checks the caller is an admin first.
