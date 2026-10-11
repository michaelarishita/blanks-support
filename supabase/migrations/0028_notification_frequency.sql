-- ============================================================
-- Blanks Support — notification cadence per agent (Prompt 34)
-- Run in the Supabase SQL Editor after 0027_personal_triage.sql.
--
-- IDEMPOTENT THROUGHOUT.
--
-- Michael was getting one email per event and wants at most one recap a day.
-- The fix is a PER-AGENT cadence, not a global change: assignment email is how
-- Melissa works, so nobody moves to a digest because someone else is drowning.
--
-- One setting, three values:
--   immediate — every event emails as it happens (what everyone has today)
--   daily     — events are folded into ONE digest at a chosen hour; nothing
--               else emails, EXCEPT an urgent ticket assigned directly to you,
--               which stays immediate (a day's delay on urgent is the cost the
--               digest must not impose)
--   off       — no notification email at all
--
-- CREATE TYPE ... AS ENUM is exempt from the by-hand enum rule (a brand-new
-- type is usable in the same transaction; only ALTER TYPE ... ADD VALUE on an
-- existing type is unsafe), so the type, the column default, and the backfill
-- can all live here.
-- ============================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'notification_frequency') then
    create type notification_frequency as enum ('immediate', 'daily', 'off');
  end if;
end $$;

alter table agents
  add column if not exists notification_frequency notification_frequency not null default 'immediate';

-- The hour (0–23, in the quiet-hours zone) the daily digest is sent. Morning
-- by default, the same hour the old unassigned digest used.
alter table agents
  add column if not exists digest_hour smallint not null default 8;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'agents_digest_hour_range'
  ) then
    alter table agents
      add constraint agents_digest_hour_range check (digest_hour >= 0 and digest_hour <= 23);
  end if;
end $$;

-- When the daily digest last COMPLETED a run for this agent, and how it ended:
--   'sent'  — an email went out (there was something to report)
--   'empty' — it ran and there was nothing to report (a quiet day)
-- Together these make a STOPPED digest distinguishable from a quiet day, which
-- is the whole point: a recent timestamp with 'empty' is a quiet day; an old
-- timestamp is a digest that has stopped. Stamped only on a completed run, so a
-- failed send retries on the next tick rather than showing as done — and shown
-- in Settings. The date dedup (once per local day) is derived from the
-- timestamp, so no separate date column is needed.
alter table agents
  add column if not exists digest_last_run_at timestamptz;
alter table agents
  add column if not exists digest_last_outcome text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'agents_digest_outcome_valid'
  ) then
    alter table agents
      add constraint agents_digest_outcome_valid
      check (digest_last_outcome is null or digest_last_outcome in ('sent', 'empty'));
  end if;
end $$;

-- Backfill so NOBODY's cadence changes silently: whatever they have today is
-- what they keep. notifications off -> 'off', otherwise 'immediate'.
update agents
  set notification_frequency = case
    when notifications_enabled is false then 'off'::notification_frequency
    else 'immediate'::notification_frequency
  end
  where notification_frequency = 'immediate';  -- only rows still at the default

-- The ONE per-person change: Michael moves to a daily recap. Everyone else
-- keeps immediate — Melissa included, deliberately. notifications_enabled is
-- restored to true so the two settings agree (frequency is now authoritative);
-- it was set false by hand as the stop-gap before this migration existed.
update agents
  set notification_frequency = 'daily'::notification_frequency,
      notifications_enabled = true
  where email = 'michael@blankssportsnutrition.com';

notify pgrst, 'reload schema';
