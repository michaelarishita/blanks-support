-- ============================================================
-- Blanks Support — alert mutes (Drop 13)
-- Run in the Supabase SQL Editor after 0022_upload_grants.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- A way to silence a known alarm WITHOUT SHIPPING CODE.
--
-- The Messenger alert sent 127 notifications for a condition that was already
-- known and being worked on, and the fastest available stop was a deploy.
-- That is the wrong shape twice over: it buries the alarms that are NOT known
-- about, and it makes the fix require the one thing that was itself broken at
-- the time.
--
-- Keyed on KIND rather than on an alert row, so a kind can be muted before it
-- has ever fired — which is the case when you already know what tomorrow's
-- maintenance will trigger.
create table if not exists alert_mutes (
  kind text primary key,
  muted_at timestamptz not null default now(),
  muted_by uuid references agents(id) on delete set null,
  -- Null means "until somebody unmutes it". Allowed, because sometimes that
  -- is genuinely what you want — but the dashboard flags it, because an
  -- indefinite mute is how a real alarm becomes a permanent blind spot.
  expires_at timestamptz,
  -- Why. A mute with no reason is indistinguishable from one nobody
  -- remembers making.
  reason text
);

-- "Which kinds are muted" — asked on every alert. The kind lookup itself rides
-- the primary key; this partial index narrows the table to the indefinite
-- mutes, which is also the set the dashboard flags.
--
-- The predicate is `expires_at is null` and NOTHING ELSE on purpose. An index
-- predicate must be IMMUTABLE, and `now()` is only STABLE — the original
-- `where expires_at is null or expires_at > now()` raised
-- `ERROR: functions in index predicate must be marked IMMUTABLE` and aborted
-- the whole paste, which is why this migration never applied. The time-based
-- half of "active" is checked on the fetched row at query time, where a
-- non-immutable function is fine.
create index if not exists alert_mutes_active_idx
  on alert_mutes (kind)
  where expires_at is null;

alter table alert_mutes enable row level security;

do $$ begin
  -- Visible to the whole team: a mute nobody can see is the blind spot this
  -- table is supposed to make impossible.
  if not exists (
    select 1 from pg_policies where tablename = 'alert_mutes' and policyname = 'alert_mutes_select'
  ) then
    create policy alert_mutes_select on alert_mutes for select using (is_agent());
  end if;
  -- Anyone on the team can silence an alarm they are dealing with. Writes go
  -- through the service-role client from a server action, which records who.
end $$;

notify pgrst, 'reload schema';
