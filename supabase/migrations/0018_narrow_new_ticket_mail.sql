-- ============================================================
-- Blanks Support — narrow the new-ticket broadcast
-- Run in the Supabase SQL Editor after 0017_schema_inventory.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- 0014 seeded watch_new_tickets = true for michael@, melissa@ and harvey@.
-- That produced roughly 200 emails in fourteen days, nearly all unread — the
-- same failure the system alert was rebuilt to escape, and for the same
-- reason: mail that always arrives stops being read, and then the one that
-- mattered is not read either.
--
-- The code now sends a new-ticket notice to everyone with notifications on
-- when a ticket is High or Urgent AND unassigned, without needing this
-- column at all. `watch_new_tickets` keeps its exact meaning — "every new
-- ticket, any priority" — and stays available in Settings for anyone who
-- wants it. It is simply no longer ON by default.
--
-- Turning the seed off is the whole change in practice: these three are the
-- only rows it was ever true for, so leaving it set would mean the narrowing
-- changed nothing for the only people it affects.
--
-- SEED DATA, like 0014's was. Anyone here can turn it straight back on from
-- Settings → Notifications, and this file must not fight them for it — so it
-- is written to be run ONCE, as part of this migration, and not on a
-- schedule. Re-running it after somebody opts back in would silently
-- overrule them.
update agents
set watch_new_tickets = false
where watch_new_tickets = true
  and lower(email) in (
    'michael@blankssportsnutrition.com',
    'melissa@blankssportsnutrition.com',
    'harvey@blankssportsnutrition.com'
  );
