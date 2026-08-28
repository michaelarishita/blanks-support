-- ============================================================
-- Blanks Support — inbound message quarantine (Drop 13)
-- Run in the Supabase SQL Editor after 0018_narrow_new_ticket_mail.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- The escape valve for a message that can never be taken in.
--
-- Holding the cursor for a failed message is right and stays the default: it
-- is what keeps a transient error from becoming permanent loss. But a message
-- that fails EVERY time holds every message behind it forever, and inbound is
-- down until a person notices. That is a 31-hour outage waiting to happen a
-- second time.
--
-- Nothing here deletes anything. The mail is still in Gmail; this is a record
-- that we stopped trying, why, and how many times — so a person can look at
-- it and put it back.
create table if not exists quarantined_messages (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null,
  -- Counted across DISTINCT syncs, not retries within one: a message is
  -- processed at most once per run, so this is a count of days-ish, not of
  -- milliseconds. Three attempts is three separate chances.
  attempts int not null default 1,
  first_failed_at timestamptz not null default now(),
  last_failed_at timestamptz not null default now(),
  -- The real cause, kept in full. A count is what sent someone chasing three
  -- database errors that were Gmail 404s.
  last_error text not null,
  -- 'fetch' or 'store'. They fail for unrelated reasons and the evidence that
  -- clears each one is different — see the batch guard in lib/inbound/quarantine.ts.
  last_phase text not null default 'store'
    check (last_phase in ('fetch', 'store')),
  -- Null while the message is still being retried. Set when we give up, which
  -- is the moment it stops holding the cursor.
  quarantined_at timestamptz,
  -- Set when a person puts it back in the queue. Kept rather than deleting the
  -- row: "this was quarantined and someone released it" is the data that says
  -- whether the threshold is right.
  released_at timestamptz,
  released_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now()
);

-- One row per message, and the lookup the sync does on every run.
create unique index if not exists quarantined_messages_gmail_uniq
  on quarantined_messages (gmail_message_id);

-- The "what are we currently ignoring" query, which is what the banner and
-- Settings both ask.
create index if not exists quarantined_messages_open_idx
  on quarantined_messages (quarantined_at desc)
  where quarantined_at is not null and released_at is null;

alter table quarantined_messages enable row level security;

do $$ begin
  -- Readable by the team: a quarantined message is a customer who did not get
  -- through, and that is everyone's problem, not an admin curiosity.
  if not exists (select 1 from pg_policies where tablename = 'quarantined_messages' and policyname = 'quarantined_messages_select') then
    create policy quarantined_messages_select on quarantined_messages
      for select using (is_agent());
  end if;
  -- Writes go through the service-role client only. The sync owns the
  -- counters; a release is a server action that runs as service role too.
end $$;

notify pgrst, 'reload schema';
