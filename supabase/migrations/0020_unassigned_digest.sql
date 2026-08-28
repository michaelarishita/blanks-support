-- ============================================================
-- Blanks Support — daily unassigned digest (Drop 13)
-- Run in the Supabase SQL Editor after 0019_message_quarantine.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- The safety net for the hole 0018 opened.
--
-- Narrowing new-ticket mail to unassigned High/Urgent was right — the Normal
-- broadcast was ~200 unread emails in fourteen days. But it means an ordinary
-- Normal ticket that no rule claims now arrives in total silence. Eleven of
-- them landed in one day and nobody was told.
--
-- Per-ticket mail was the wrong shape for that; once a day, only when there is
-- something to say, is the right one. This is the digest 0018's note said
-- would wait for evidence. The evidence arrived.
alter table agents
  add column if not exists watch_unassigned_digest boolean not null default false;

-- SEED DATA, exactly like 0014's was — and like 0014's, the Settings toggle
-- governs it from here. The list has no home in code because the team changes.
update agents
set watch_unassigned_digest = true
where lower(email) in (
  'michael@blankssportsnutrition.com',
  'melissa@blankssportsnutrition.com'
);

notify pgrst, 'reload schema';
