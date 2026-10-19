-- ============================================================
-- Blanks Support — subject-match junk rules (0031)
-- Run in the Supabase SQL Editor after 0030_agent_queue_prefs.sql.
-- ============================================================

-- A general mechanism, not a TRE special case. Some senders rotate domains and
-- freemail addresses faster than a sender/domain block can keep up (The Running
-- Event is the first, not the last), and the one thing their mail has in common
-- is the SUBJECT. A sender/domain override can't match on that, and the routing
-- rules engine deliberately cannot set 'junk'. This table is the missing piece:
-- an admin-authored pattern that files matching NEW tickets straight to Junk,
-- with the reason recorded on the ticket and a one-click rescue ("Not spam").
--
-- Every column choice here mirrors `rules` (0011): ships DISABLED, carries a
-- position, records who made it. The jsonb-vs-column split is different only
-- because a junk rule has no actions — just patterns, a scope and a reason.

create table if not exists junk_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Match if ANY pattern is a case-insensitive substring of the scoped text.
  -- A list rather than one string so "the running event" and "tre 2026" can be
  -- one rule; an empty list (or all-blank) matches NOTHING, enforced in code the
  -- same way a zero-condition routing rule never matches.
  patterns text[] not null default '{}',
  -- 'subject' | 'subject_body'. Subject is the default because it is the signal
  -- that survives a domain rotation; matching the body is opt-in because a body
  -- substring is far likelier to catch a real customer quoting the phrase.
  scope text not null default 'subject' check (scope in ('subject', 'subject_body')),
  -- Shown on every ticket this rule junks, via the junk notice and junk_reason.
  reason text not null,
  -- Ships disabled. A seed rule that fired the moment the migration ran would
  -- junk a week of mail before anyone saw the dry run.
  enabled boolean not null default false,
  position int not null default 0,
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The engine's only hot query: enabled rules, in order.
create index if not exists junk_rules_order_idx on junk_rules (enabled, position);

alter table junk_rules enable row level security;
-- Everyone READS them — "why is this ticket in Junk" has to be answerable by
-- whoever is holding it, the same argument as rules_select.
do $$ begin
  create policy junk_rules_select on junk_rules for select using (is_agent());
exception when duplicate_object then null; end $$;
-- Editing is admin-only. `for all using (...)` covers inserts via WITH CHECK.
do $$ begin
  create policy junk_rules_admin on junk_rules for all using (is_admin());
exception when duplicate_object then null; end $$;

-- ---------- SEED: The Running Event, DISABLED ----------
-- Seeded off, exactly as Michael asked, so the dry run is reviewed before it
-- goes live. Patterns are the phrases that survive a domain rotation; the
-- dry-run's corrections-corpus check is what proves none of them hit a customer
-- a human already rescued.
insert into junk_rules (name, patterns, scope, reason, enabled, position)
select
  'The Running Event (TRE)',
  array['the running event', 'tre 2026', 'tre2026', 'running event 2026'],
  'subject',
  'Trade-show attendee/exhibitor-list spam from The Running Event. They rotate sender domains and freemail addresses, so a sender block never holds — the subject is the only durable signal.',
  false,
  0
where not exists (select 1 from junk_rules where name = 'The Running Event (TRE)');
