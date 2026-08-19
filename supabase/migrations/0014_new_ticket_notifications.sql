-- ============================================================
-- Blanks Support — new-ticket notifications (Drop 10)
-- Run in the Supabase SQL Editor after 0013_meta_messaging.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- A fourth kind, sharing the notifications table so threading, quiet-hours
-- deferral and the sent/scheduled record all work exactly as they already do.
alter type notification_kind add value if not exists 'new_ticket';

-- Who wants to hear about EVERY new ticket, regardless of assignment.
--
-- Deliberately its own column rather than reusing notifications_enabled:
-- that one controls the mail you get about YOUR tickets, and someone who
-- wants their own assignments but not a firehose of everyone else's is a
-- perfectly reasonable person. Conflating them would give them no way to say
-- so except by muting both.
--
-- Defaults FALSE, so an agent added later is quiet until they ask not to be.
alter table agents
  add column if not exists watch_new_tickets boolean not null default false;

-- The three who want it today. This is SEED DATA, not configuration: the
-- toggle in Settings is what governs it from here, and Wes and Will (and
-- whoever comes after) turn it on for themselves. Matched on email so it is
-- a no-op for any address that does not exist yet.
update agents
set watch_new_tickets = true
where lower(email) in (
  'michael@blankssportsnutrition.com',
  'melissa@blankssportsnutrition.com',
  'harvey@blankssportsnutrition.com'
);
