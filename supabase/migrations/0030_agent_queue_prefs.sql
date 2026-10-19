-- ============================================================
-- Blanks Support — per-agent queue preferences (Prompt: clear the queue)
-- Run in the Supabase SQL Editor after 0029_email_delivery_cap.sql.
--
-- IDEMPOTENT THROUGHOUT.
--
-- Two per-agent settings, both of which must default to "nobody's queue
-- changes without them choosing it":
--
--   open_channels — which channels the Open view shows for this agent. NULL
--     means "all channels", which is everyone's default. Michael is seeded to
--     Website + Email below; everyone else keeps NULL (all) until they pick.
--
--   hover_preview — whether the desktop hover preview is on. Default FALSE
--     (off for everyone), Michael seeded TRUE. A reading aid some people want
--     and others find noisy, so it is opt-in per person rather than global.
-- ============================================================

alter table agents
  add column if not exists open_channels text[];

alter table agents
  add column if not exists hover_preview boolean not null default false;

-- Michael's defaults. Data, not configuration — the per-agent controls govern
-- these from here, the same way the notification seeds work.
update agents
  set open_channels = array['web_form', 'email']
  where email = 'michael@blankssportsnutrition.com';

update agents
  set hover_preview = true
  where email = 'michael@blankssportsnutrition.com';

notify pgrst, 'reload schema';
