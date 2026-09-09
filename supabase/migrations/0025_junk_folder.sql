-- ============================================================
-- Blanks Support — Junk folder + correction loop (Drop / Prompt 29)
-- Run in the Supabase SQL Editor after 0024_search.sql.
--
-- IDEMPOTENT THROUGHOUT.
--
-- THE POINT. Guards used to DISCARD mail — a drop is a decision with the
-- evidence thrown away, and if one of those was a customer, it was gone
-- silently. This turns the reviewable guard drops (bulk-mail, ignored-sender),
-- and a confidently-spammy classifier verdict, into TICKETS filed in Junk that
-- carry the reason they were junked. Nothing is discarded that a human could
-- not later see and recover.
-- ============================================================

-- ---------- JUNK STATUS ----------
--
-- A new status value rather than a boolean column. Junk is orthogonal to the
-- open/resolved lifecycle — a junked ticket is simply out of the queue until an
-- agent rescues it or retention purges it — but a dedicated status means every
-- view that already filters BY status excludes it for free. A boolean would
-- have to be AND-ed into every list query and every count by hand, and the one
-- that got missed would leak junk into a queue silently. Fewer places to forget.
--
-- ADD VALUE is not used anywhere else in this migration, so there is no
-- "unsafe use of a new enum value in the same transaction" hazard.
alter type ticket_status add value if not exists 'junk';

-- When it was junked, and why.
--
--   junked_at   — retention runs from HERE, not last_message_at. A spammer who
--                 keeps replying would otherwise keep resetting the purge clock.
--   junk_reason — the guard/rule/classifier score, shown on the ticket so the
--                 filing decision is legible rather than a mystery.
alter table tickets add column if not exists junked_at timestamptz;
alter table tickets add column if not exists junk_reason jsonb;

-- The junk view lists by junked_at; the partial index keeps it off the hot path
-- of every other query.
create index if not exists tickets_junk_idx
  on tickets (junked_at desc)
  where status = 'junk';


-- ---------- CORRECTIONS: the eval set we never had ----------
--
-- Every correction (Not spam / Mark as spam) records the message, the
-- classifier's verdict AND score at the time, who corrected it, and when. This
-- record is the asset: a labelled corpus to measure the classifier against, so
-- no future rule change ships unmeasured. We have already shipped one
-- classifier that scored 0/25 on real mail; this is how that does not happen
-- blind again.
create table if not exists spam_corrections (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references tickets(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  -- SNAPSHOTTED, deliberately denormalised: the eval corpus must outlive the
  -- 30-day purge of the junk ticket it came from. A correction whose evidence
  -- vanished with the ticket would be a label with nothing to score against.
  subject text,
  body_text text,
  from_email text,
  from_domain text,
  channel text,
  -- The human's verdict. This is the ground truth.
  label text not null check (label in ('spam', 'not_spam')),
  -- The classifier's verdict AT THE TIME of the correction, so drift between
  -- then and now is itself measurable.
  classifier_score int,
  classifier_likely boolean,
  classifier_reasons jsonb,
  corrected_by uuid references agents(id) on delete set null,
  corrected_at timestamptz not null default now(),
  -- Undo. A reversed correction is EXCLUDED from the eval corpus but kept as
  -- history — "somebody labelled this and then took it back" is itself a fact
  -- worth not losing.
  undone_at timestamptz,
  undone_by uuid references agents(id) on delete set null
);

create index if not exists spam_corrections_active_idx
  on spam_corrections (corrected_at desc)
  where undone_at is null;

alter table spam_corrections enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'spam_corrections' and policyname = 'spam_corrections_select') then
    create policy spam_corrections_select on spam_corrections for select using (is_agent());
  end if;
end $$;


-- ---------- SENDER OVERRIDES: correction takes effect immediately ----------
--
-- A correction takes effect IMMEDIATELY as an explicit override for that sender
-- and domain — fast, obvious, explainable. We deliberately do NOT auto-retrain
-- the classifier or auto-move thresholds: the failure mode of a drifting spam
-- filter is discarding real customers, and it is silent. A per-sender override
-- is a change a human can read and reverse.
--
-- Precedence over the guards and the classifier, in both directions:
--   not_spam → this sender's mail goes to the inbox even if a guard would junk it
--   spam     → this sender's mail goes to Junk even if nothing else would
create table if not exists sender_spam_overrides (
  id uuid primary key default gen_random_uuid(),
  -- 'address' is a full address; 'domain' is a domain WITHOUT the leading @.
  scope text not null check (scope in ('address', 'domain')),
  value text not null,
  label text not null check (label in ('spam', 'not_spam')),
  -- The correction that set it, for audit.
  source_ticket_id uuid references tickets(id) on delete set null,
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per target. A later, opposite correction FLIPS the label in place
  -- rather than leaving two contradictory overrides for the same sender.
  unique (scope, value)
);

alter table sender_spam_overrides enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'sender_spam_overrides' and policyname = 'sender_spam_overrides_select') then
    create policy sender_spam_overrides_select on sender_spam_overrides for select using (is_agent());
  end if;
end $$;


-- PostgREST caches the schema; without this the new columns and tables are
-- invisible to the API until it reloads on its own.
notify pgrst, 'reload schema';
