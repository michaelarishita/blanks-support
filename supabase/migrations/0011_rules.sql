-- ============================================================
-- Blanks Support — routing rules (Drop 7C)
-- Run in the Supabase SQL Editor after 0010_display_names.sql.
-- ============================================================

-- DROP-7-SPEC.md says "`rules` table already exists". It does not — 0001
-- created 13 tables and none of them was this one. This migration is that
-- table, plus the one column the auto-reply action needs.

create type rule_trigger as enum ('ticket_created', 'message_received');
create type rule_match as enum ('all', 'any');

-- Columns are `trigger_on` / `match_type` rather than `trigger` / `match`:
-- both bare words are Postgres keywords, and a column you have to quote is a
-- column somebody will eventually forget to quote.
create table rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trigger_on rule_trigger not null default 'ticket_created',
  -- Evaluation order, ascending. Deliberately NOT unique: reordering rewrites
  -- the whole list, and a unique index would make the intermediate states of
  -- that rewrite illegal. Ties break on created_at.
  position int not null default 0,
  -- Every rule ships disabled. A seed rule that started firing the moment the
  -- migration ran would route a week of tickets before anyone looked.
  enabled boolean not null default false,
  match_type rule_match not null default 'all',
  -- [{ field, operator, value }] — shapes live in lib/rules/types.ts, which is
  -- also what validates them. Kept as jsonb so adding a condition field is a
  -- code change, not a migration.
  conditions jsonb not null default '[]',
  -- [{ type, ... }] — assign | tag | priority | reply.
  actions jsonb not null default '[]',
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The engine's only query: enabled rules for one trigger, in order.
create index rules_order_idx on rules (trigger_on, position);

alter table rules enable row level security;
-- Everyone can READ the rules — "why was this assigned to Harvey" has to be
-- answerable by the person holding the ticket, not only by an admin.
create policy rules_select on rules for select using (is_agent());
-- Editing is admin-only. `for all using (...)` supplies the same expression as
-- WITH CHECK, so inserts are covered too.
create policy rules_admin on rules for all using (is_admin());

-- ---------- AUTOMATED MESSAGES ----------
-- An auto-reply is an outbound public message, so without this it would stamp
-- tickets.first_response_at and quietly report that a human answered in two
-- seconds — corrupting exactly the metric Phase 5 reports on.
alter table messages
  add column if not exists is_automated boolean not null default false;

-- Same body as 0001's trigger, with first_response_at now ignoring automated
-- sends. last_message_at and the customer-reply reopen are unchanged.
create or replace function on_message_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update tickets set
    last_message_at = new.created_at,
    updated_at = now(),
    -- customer reply reopens pending/resolved tickets
    status = case
      when new.direction = 'inbound' and status in ('pending','resolved') then 'open'::ticket_status
      else status
    end,
    -- first outbound public reply stamps first_response_at — but an
    -- auto-acknowledgement is not a first response.
    first_response_at = case
      when new.direction = 'outbound'
       and new.type = 'public'
       and new.is_automated = false
       and first_response_at is null then new.created_at
      else first_response_at
    end
  where id = new.ticket_id;
  return new;
end $$;

-- ---------- SEED RULES ----------
-- All disabled, exactly the four in DROP-7-SPEC 7C and no more: Melissa's
-- actual triage over the next fortnight is better evidence than our guesses,
-- and the dry-run exists so rules get built from that evidence.
--
-- The assignee subselects resolve by email if the account exists and fall to
-- null if it doesn't. A null target is not a silent failure: the editor shows
-- "choose who this assigns to" and enabling is refused until it is set.

insert into rules (name, trigger_on, position, match_type, conditions, actions) values
(
  'Order changes → Harvey',
  'ticket_created',
  0,
  'any',
  '[
    {"field":"topic","operator":"is","value":"Order questions"},
    {"field":"subject","operator":"contains_any","value":"cancel, change address, wrong item, modify order, change my order"}
  ]'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'type', 'assign',
      'agent_id', (select id from agents where lower(email) like 'harvey@%' and is_active limit 1)
    )
  )
),
(
  'Wholesale → tag and route',
  'ticket_created',
  1,
  'all',
  '[{"field":"topic","operator":"is","value":"Wholesale / retailer"}]'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'type', 'tag',
      'tag_id', (select id from tags where name = 'Wholesale / retailer' limit 1)
    ),
    -- Who wholesale routes to is Michael's call, so this ships without a
    -- target on purpose.
    jsonb_build_object('type', 'assign', 'agent_id', null)
  )
),
(
  'Sponsorship and athletes → Michael',
  'ticket_created',
  2,
  'any',
  '[
    {"field":"topic","operator":"is","value":"Sponsorship inquiry"},
    {"field":"topic","operator":"is","value":"Ambassador / athlete"}
  ]'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'type', 'assign',
      'agent_id', (select id from agents where lower(email) like 'michael@%' and is_active limit 1)
    )
  )
),
(
  'Refund mentions → High priority',
  'ticket_created',
  3,
  'any',
  '[
    {"field":"subject","operator":"contains_any","value":"refund, money back, chargeback, dispute"},
    {"field":"body","operator":"contains_any","value":"refund, money back, chargeback, dispute"}
  ]'::jsonb,
  '[{"type":"priority","priority":"high"}]'::jsonb
);
