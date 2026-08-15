-- ============================================================
-- Blanks Support — blue rebrand, email accent
-- Run in the Supabase SQL Editor after 0007_claim_support_inbox.sql.
-- ============================================================

-- The dashboard palette lives in code, but the EMAIL accent colour is stored
-- in settings.data and seeded by 0003 as the old amber. Without this the app
-- would be blue while every outbound email stayed yellow.
--
-- Only rewrites the value if it is still the seeded amber, so a colour an
-- admin has deliberately chosen in Settings → Company branding is left alone.
update settings
set data = jsonb_set(data, '{brand_color}', '"#0061ff"'),
    updated_at = now()
where id = true
  and data->>'brand_color' = '#f5c518';
