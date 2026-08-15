-- ============================================================
-- Blanks Support — internal display name, separate from the signature name
-- Run in the Supabase SQL Editor after 0009_notifications.sql.
-- ============================================================

-- agents.name was doing two jobs: the label in the dashboard AND the name
-- customers see on outbound email. Those want different values — the team
-- calls Michael "Mike", customers should not.
--
--   agents.name          → the SIGNATURE name, customer-facing
--   agents.display_name  → the INTERNAL label, team-facing
alter table agents add column if not exists display_name text;

comment on column agents.name is
  'Customer-facing name used in the outbound email signature. Not the dashboard label.';
comment on column agents.display_name is
  'Internal, team-facing label shown in the dashboard. Falls back to name when null.';

-- Backfill: everyone starts with the two the same, so nothing changes look
-- until a display name is deliberately set.
update agents set display_name = name where display_name is null;

-- The two the team actually asked for.
update agents set display_name = 'Jcrow'
  where lower(email) = 'jon@blankssportsnutrition.com';
update agents set display_name = 'Mike'
  where lower(email) = 'michael@blankssportsnutrition.com';

-- Deliberately NOT touching agents.name for those rows: Michael's signature
-- must keep reading "Michael Arishita" on customer email.
