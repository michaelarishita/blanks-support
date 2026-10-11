-- ============================================================
-- Blanks Support — the delivery-layer email cap (Prompt 38)
-- Run in the Supabase SQL Editor after 0028_notification_frequency.sql.
--
-- IDEMPOTENT THROUGHOUT.
--
-- Three separate senders have now flooded this inbox — the new-ticket
-- broadcast, the Messenger heartbeat, and the escalation hand-off — and each
-- time we fixed that one sender a new one found a way through. Per-sender rules
-- do not hold. This is the ONE place every human-facing email passes through,
-- regardless of which feature sent it: a per-agent daily cap, enforced in
-- lib/notifications/delivery.ts (sendTeamEmail). Anything over the cap is not
-- dropped — it is recorded here and rolled into a daily overflow digest.
-- ============================================================

-- The per-agent ceiling. Default is a FLOOD BACKSTOP, not a day-to-day limit:
-- high enough that an ordinary busy day for an agent who lives on assignment
-- email is untouched, low enough that 127-in-five-days or dozens-in-a-day is
-- caught. Michael is set to 1 below; configurable per agent from here.
alter table agents
  add column if not exists daily_email_cap int not null default 50;

-- Michael: at most one immediate email a day. Everything past it rolls into his
-- overflow digest. (Set to 0 for a strict single-digest-per-day.)
update agents set daily_email_cap = 1
  where email = 'michael@blankssportsnutrition.com';

-- The ledger: every human-facing email attempt and what became of it. This is
-- both the cap's counter and the record that makes the cap LOSSLESS — a
-- deferred email keeps its full body here so the digest can reproduce it.
--
--   sent      — delivered; counts toward the day's cap
--   deferred  — over cap, NOT delivered; full content kept for the digest
--   bypassed  — delivered via an explicit, named, logged bypass (the overflow
--               digest itself is the only one). Recorded so it is never silent.
--   error     — the send failed; recorded so a failure never reads as an absence
create table if not exists email_ledger (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete set null,
  recipient_email text not null,
  kind text not null,
  ticket_id uuid references tickets(id) on delete set null,
  subject text,
  body_text text,
  outcome text not null check (outcome in ('sent', 'deferred', 'bypassed', 'error')),
  bypass_reason text,
  detail text,
  -- When a deferred row was rolled into a digest, so it is never rolled twice.
  digested_at timestamptz,
  -- Local calendar day (team timezone) the cap counts within.
  day date not null,
  created_at timestamptz not null default now()
);

-- The cap count: delivered emails to a recipient on a day.
create index if not exists email_ledger_cap_idx
  on email_ledger (recipient_email, day, outcome);

-- The digest's feed: deferred rows not yet rolled up.
create index if not exists email_ledger_pending_idx
  on email_ledger (recipient_email, created_at)
  where outcome = 'deferred' and digested_at is null;

alter table email_ledger enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'email_ledger' and policyname = 'email_ledger_select'
  ) then
    create policy email_ledger_select on email_ledger for select using (is_agent());
  end if;
  -- Writes go through the service-role client from the delivery chokepoint.
end $$;

notify pgrst, 'reload schema';
