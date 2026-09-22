-- ============================================================
-- Blanks Support — personal inbox triage, PHASE A (Prompt 33)
-- Run in the Supabase SQL Editor after 0026_junk_tables.sql.
--
-- IDEMPOTENT THROUGHOUT.
--
-- A PRIVATE, READ-ONLY triage lens over ONE agent's own Gmail inbox — to find
-- out whether an LLM "does Michael need to see this" pass is useful before we
-- build a mailbox around it. Nothing here is a ticket, a channel, or shared.
--
-- PRIVACY IS THE POINT. The rest of this app lets any agent read any ticket
-- (the shared agent-role RLS helpers). That model must NOT reach these tables
-- — the owner is the only reader. So the policies below key on
-- owner_agent_id = auth.uid(), and the role helpers appear NOWHERE in this
-- file. tests/personal-triage-privacy.test.ts fails if that ever changes.
--
-- NO MESSAGE BODIES ARE STORED. We keep the gmail id, sender, subject, date,
-- Gmail's own short snippet, and the classification. The body is fetched from
-- Gmail on demand and never persisted — storing it would make a private inbox
-- a durable copy in our database, which is exactly what we are avoiding.
-- ============================================================

create table if not exists personal_messages (
  id uuid primary key default gen_random_uuid(),
  -- The one agent this row belongs to. Everything hangs off this.
  owner_agent_id uuid not null references agents(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  from_email text,
  from_name text,
  subject text,
  message_date timestamptz,
  -- Gmail's own preview line — short, not the body. The body is never stored.
  snippet text,
  -- The triage verdict. "needs_you" is the safe default (see the classifier).
  classification text check (classification in ('needs_you', 'probably_not')),
  -- One short line of why, and which model said it — so accuracy can be judged.
  classifier_reason text,
  classifier_model text,
  classified_at timestamptz,
  created_at timestamptz not null default now(),
  -- One row per message per owner; a re-sync updates rather than duplicates.
  unique (owner_agent_id, gmail_message_id)
);

-- The list is newest-first for one owner.
create index if not exists personal_messages_owner_date_idx
  on personal_messages (owner_agent_id, message_date desc);

alter table personal_messages enable row level security;

do $$ begin
  -- OWNER-ONLY. Not the shared role helper — that is the ticket-wide model this
  -- table must never inherit. auth.uid() is the signed-in agent's id.
  if not exists (select 1 from pg_policies where tablename = 'personal_messages' and policyname = 'personal_messages_owner_read') then
    create policy personal_messages_owner_read on personal_messages
      for select using (owner_agent_id = auth.uid());
  end if;
  -- No insert/update/delete policy on purpose: sync and corrections run through
  -- the service-role client (which bypasses RLS) after the server has checked
  -- the acting agent. A browser can only ever READ its own rows.
end $$;


-- The correction loop's record — the eval asset, reused from Drop 29's shape.
-- "wrong" on either bucket stores a labelled correction; the harness scores the
-- classifier against these. Snapshotted (sender/subject/snippet) so it survives
-- the message row being re-synced — and, like everything here, NO body.
create table if not exists personal_triage_corrections (
  id uuid primary key default gen_random_uuid(),
  owner_agent_id uuid not null references agents(id) on delete cascade,
  personal_message_id uuid references personal_messages(id) on delete set null,
  gmail_message_id text,
  from_email text,
  subject text,
  snippet text,
  -- The classifier's verdict AT THE TIME, so drift is measurable.
  classifier_verdict text,
  classifier_reason text,
  -- The human's label — the ground truth to score against.
  corrected_label text check (corrected_label in ('needs_you', 'probably_not')),
  corrected_at timestamptz not null default now(),
  unique (owner_agent_id, gmail_message_id)
);

create index if not exists personal_triage_corrections_owner_idx
  on personal_triage_corrections (owner_agent_id, corrected_at desc);

alter table personal_triage_corrections enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'personal_triage_corrections' and policyname = 'personal_triage_corrections_owner_read') then
    create policy personal_triage_corrections_owner_read on personal_triage_corrections
      for select using (owner_agent_id = auth.uid());
  end if;
end $$;

notify pgrst, 'reload schema';
