-- ============================================================
-- Blanks Support — Meta webhook event log (Drop 9C)
-- Run in the Supabase SQL Editor after 0020_unassigned_digest.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- The durable landing pad for Meta webhook events, and the reason the
-- endpoint can answer in milliseconds.
--
-- Meta requires a 200 within FIVE SECONDS. It retries immediately on failure,
-- alerts after fifteen minutes, and UNSUBSCRIBES THE APP after an hour of
-- them. An unsubscribed app is a silent inbound outage with no signal of its
-- own — the mailbox equivalent would be Gmail quietly cancelling our watch.
--
-- So the endpoint does exactly two things: check the signature, and write the
-- row. Everything else — profile fetches, media downloads, ticket creation —
-- happens after the response has gone. A slow Graph API call can no longer
-- cost us the subscription.
--
-- This is also the audit log. `signature_ok = false` rows are kept rather than
-- discarded: a run of them is either somebody probing the endpoint or our own
-- secret being wrong, and those need opposite responses.
create table if not exists meta_webhook_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  -- 'page' for Messenger, 'instagram' for IG. Null when the body was
  -- unparseable, which is still worth recording.
  object text,
  entry_id text,
  -- Meta's message id, when the event carries one. The dedupe that matters is
  -- on messages.meta_message_id; this is for tracing an event to its message.
  mid text,
  payload jsonb not null,
  signature_ok boolean not null,
  -- Null until processed. This is the queue: anything with a null here and a
  -- good signature is work outstanding.
  processed_at timestamptz,
  -- The reason processing failed, in full. A count is not a cause.
  error text,
  attempts int not null default 0
);

-- The queue lookup, and the only one that runs on a hot path.
create index if not exists meta_webhook_events_pending_idx
  on meta_webhook_events (received_at)
  where processed_at is null and signature_ok;

-- "How many signature failures in the last 24h" — the heartbeat's question.
create index if not exists meta_webhook_events_bad_sig_idx
  on meta_webhook_events (received_at desc)
  where not signature_ok;

-- "When did we last hear anything at all", for the Settings panel.
create index if not exists meta_webhook_events_received_idx
  on meta_webhook_events (received_at desc);

alter table meta_webhook_events enable row level security;

do $$ begin
  -- Readable by the team: "is Messenger working" is everybody's question.
  -- Writes go through the service-role client only — the webhook has no user.
  if not exists (
    select 1 from pg_policies
    where tablename = 'meta_webhook_events' and policyname = 'meta_webhook_events_select'
  ) then
    create policy meta_webhook_events_select on meta_webhook_events
      for select using (is_agent());
  end if;
end $$;

notify pgrst, 'reload schema';
