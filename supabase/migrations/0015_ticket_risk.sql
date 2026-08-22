-- ============================================================
-- Blanks Support — advisory risk flagging (Drop 11)
-- Run in the Supabase SQL Editor after 0014_new_ticket_notifications.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- ADVISORY ONLY. Nothing in the product reads these columns to make a
-- decision: no auto-reply, no auto-assign, no auto-resolve, no blocking. They
-- exist to put a sentence in front of a human, and to be measurable later.
--
-- risk_reasons is stored alongside the score precisely so precision can be
-- checked with evidence rather than instinct: if a signal keeps firing on
-- tickets that turn out fine, that is a fact about the signal, and it should
-- be tuned by looking rather than by guessing.
alter table tickets
  add column if not exists risk_score int not null default 0,
  add column if not exists risk_reasons jsonb not null default '[]',
  add column if not exists risk_assessed_at timestamptz,
  -- Dismissal is a judgement an agent made. Kept rather than clearing the
  -- score, so "this was flagged and someone looked" stays distinguishable
  -- from "this was never flagged".
  add column if not exists risk_dismissed_at timestamptz,
  add column if not exists risk_dismissed_by uuid references agents(id) on delete set null;

-- The inbox marker filters on this, and only a small minority of tickets ever
-- carry a score.
create index if not exists tickets_risk_idx
  on tickets (risk_score)
  where risk_score > 0;

-- Reply-To, kept on the inbound message.
--
-- Needed for the domain-mismatch signal, and worth having regardless: a mail
-- whose replies go somewhere other than where it came from is a fact about
-- that mail, and we were discarding it at parse time.
alter table messages
  add column if not exists reply_to_email text;
