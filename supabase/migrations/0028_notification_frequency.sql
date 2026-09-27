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

-- Local date key (YYYY-MM-DD) of the last digest RUN for this agent — set once
-- the digest hour is reached and the digest is either sent or found empty, so a
-- missed cron tick catches up rather than skipping the day, and an empty
-- morning doesn't make the next one look overdue.
alter table agents
  add column if not exists digest_last_run_date text;

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
