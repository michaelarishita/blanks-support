-- ============================================================
-- Blanks Support — upload grant ledger (Drop 8A follow-up)
-- Run in the Supabase SQL Editor after 0021_meta_webhook_events.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- What we could not answer when a customer said their photo never arrived.
--
-- The upload flow mints a signed URL, the browser PUTs straight to storage,
-- and the intake route claims the result. Nothing recorded the middle step —
-- so "was an upload URL ever issued for this submission?" had no answer, and
-- the rate at which uploads were being lost was not merely unknown but
-- UNKNOWABLE. The temp object is deleted on claim and swept after 24h; the
-- only other trace was a console.error in the customer's own browser.
--
-- Same argument as the mailbox reconciliation: watch the OUTCOME, not the
-- mechanism. A grant with no resolution is a customer who tried to send us
-- something and did not.
create table if not exists upload_grants (
  id uuid primary key default gen_random_uuid(),
  -- The storage path we minted. Unique: one grant, one path, and a replay
  -- cannot quietly create a second row.
  storage_path text not null,
  -- What the customer called it. Useful when asking them to resend.
  original_name text,
  declared_bytes int,
  issued_at timestamptz not null default now(),
  -- Coarse, for rate-limiting forensics only. Not joined to a person.
  issued_ip text,
  -- Null until the intake route reaches a verdict on it.
  resolved_at timestamptz,
  -- 'stored'   — became an attachment row
  -- 'rejected' — claimed but refused (sniffing, size, EXIF, bad grant)
  -- 'missing'  — claimed but the object was not there (the PUT never landed)
  -- 'expired'  — never claimed at all; swept by age
  outcome text check (outcome in ('stored', 'rejected', 'missing', 'expired')),
  -- The real reason, where we have one. A count is not a cause.
  detail text,
  -- Set once the bytes are an attachment, so the two can be joined.
  attachment_id uuid references attachments(id) on delete set null
);

create unique index if not exists upload_grants_path_uniq
  on upload_grants (storage_path);

-- "What is outstanding" — the reconciliation's question.
create index if not exists upload_grants_unresolved_idx
  on upload_grants (issued_at)
  where resolved_at is null;

alter table upload_grants enable row level security;

do $$ begin
  -- Readable by the team; written only by the service-role client, since the
  -- customer minting a grant has no session.
  if not exists (
    select 1 from pg_policies
    where tablename = 'upload_grants' and policyname = 'upload_grants_select'
  ) then
    create policy upload_grants_select on upload_grants
      for select using (is_agent());
  end if;
end $$;

notify pgrst, 'reload schema';
