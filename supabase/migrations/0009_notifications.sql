-- ============================================================
-- Blanks Support — assignment notifications, reminders, escalation
-- Run in the Supabase SQL Editor after 0008_blue_brand.sql.
-- ============================================================

create type notification_kind as enum ('assignment', 'reminder', 'escalation');

-- One row per notification, sent or scheduled.
--
-- thread_message_id carries the RFC 2822 Message-ID of the FIRST notification
-- for an (agent, ticket) pair. Every later reminder or escalation for that
-- pair replies into it, so an agent gets one Gmail thread per ticket rather
-- than a pile of separate mails with the same subject.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,
  kind notification_kind not null,
  thread_message_id text,
  -- The subject the thread ROOT used. Reminders and escalations reuse it
  -- byte-for-byte: the subject now carries priority, and a ticket whose
  -- priority changed mid-thread would otherwise split the Gmail conversation.
  subject text,
  scheduled_for timestamptz,
  sent_at timestamptz,
  escalation_count int not null default 0,
  created_at timestamptz not null default now()
);

-- The cron's working set: what is due and not yet sent.
create index notifications_due_idx
  on notifications (scheduled_for) where sent_at is null;

-- Finding the thread root, and counting escalations, for a pair.
create index notifications_agent_ticket_idx
  on notifications (agent_id, ticket_id, created_at);

alter table agents
  add column if not exists notifications_enabled boolean not null default true;

alter table notifications enable row level security;
create policy notifications_all on notifications for all using (is_agent());
