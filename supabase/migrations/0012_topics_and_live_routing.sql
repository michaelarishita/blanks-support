-- ============================================================
-- Blanks Support — topic changes and the real routing rules
-- Run in the Supabase SQL Editor after 0011_rules.sql.
--
-- IDEMPOTENT THROUGHOUT. 0011 half-applied once and left its enum types
-- behind, so re-running it failed on "type already exists" with no way
-- forward but hand-editing. Every statement here can run twice.
-- ============================================================

-- ---------- TOPIC: Subscription → Subscription Help ----------
-- RENAME the row rather than insert a new one. ticket_tags references tags by
-- id, so a rename carries every historical ticket with it; an insert-and-
-- retire would strip the tag off every subscription ticket ever filed.
--
-- Guarded on the destination not already existing, because tags.name is
-- unique and a second run would otherwise fail the whole migration.
update tags
set name = 'Subscription Help'
where name = 'Subscription'
  and not exists (select 1 from tags where name = 'Subscription Help');

-- ---------- TOPIC: Ambassador / athlete, deprecated ----------
-- Deliberately NOT deleted. It is gone from lib/types.ts TOPICS, so customers
-- can no longer choose it, but the row stays so the tickets that already
-- carry the tag keep showing it. Deleting it would cascade through
-- ticket_tags and quietly rewrite history.
--
-- Nothing to run — this comment IS the change, and tests/topics.test.ts
-- asserts the one-way relationship (every TOPICS entry needs a tag row; a tag
-- row does not need a TOPICS entry).

-- ---------- ROUTING ----------
-- Replaces 0011's placeholders with Michael's actual routing.
--
-- Re-running this file RESETS these four rules to the definitions below, so
-- edits made in Settings → Routing rules would be lost. That is the price of
-- making it re-runnable, and it is the right trade for a seed.
delete from rules where name in (
  -- 0011's placeholders, including the Wholesale rule that shipped with no
  -- assignee and therefore could never be enabled.
  'Order changes → Harvey',
  'Wholesale → tag and route',
  'Sponsorship and athletes → Michael',
  'Refund mentions → High priority',
  -- and this file's own rules, so a second run replaces rather than doubles
  'Product, wholesale and events → Jon',
  'Orders and shipping → Harvey',
  'Sponsorship → Michael'
);

-- `enabled` is conditional on the assignee actually existing. A rule that is
-- on but assigns to nobody looks live in the list and silently does nothing —
-- worse than one that ships off with "choose who this assigns to" showing.
-- The editor refuses to enable it until an agent is picked, so a missing
-- account fails visibly rather than quietly.
insert into rules (name, trigger_on, position, enabled, match_type, conditions, actions) values
(
  'Product, wholesale and events → Jon',
  'ticket_created',
  0,
  (select count(*) > 0 from agents where lower(email) = 'jon@blankssportsnutrition.com' and is_active),
  'any',
  '[
    {"field":"topic","operator":"is","value":"Product questions"},
    {"field":"topic","operator":"is","value":"Wholesale / retailer"},
    {"field":"topic","operator":"is","value":"Event questions"}
  ]'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'type', 'assign',
      'agent_id', (select id from agents where lower(email) = 'jon@blankssportsnutrition.com' and is_active limit 1)
    ),
    -- Normal is already the column default, so this action is a no-op on a
    -- fresh ticket. It is here to be explicit rather than to change anything,
    -- and it means the rule still asserts Normal if a later rule or an agent
    -- had raised it first.
    jsonb_build_object('type', 'priority', 'priority', 'normal')
  )
),
(
  'Orders and shipping → Harvey',
  'ticket_created',
  1,
  (select count(*) > 0 from agents where lower(email) = 'harvey@blankssportsnutrition.com' and is_active),
  'any',
  '[
    {"field":"topic","operator":"is","value":"Order questions"},
    {"field":"topic","operator":"is","value":"Shipping & returns"}
  ]'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'type', 'assign',
      'agent_id', (select id from agents where lower(email) = 'harvey@blankssportsnutrition.com' and is_active limit 1)
    ),
    jsonb_build_object('type', 'priority', 'priority', 'high')
  )
),
(
  'Sponsorship → Michael',
  'ticket_created',
  2,
  (select count(*) > 0 from agents where lower(email) = 'michael@blankssportsnutrition.com' and is_active),
  'all',
  -- 0011's version also matched "Ambassador / athlete". That topic is retired
  -- from the picker, so the condition could never fire again — a dead clause
  -- that still reads as live routing. Sponsorship only.
  '[{"field":"topic","operator":"is","value":"Sponsorship inquiry"}]'::jsonb,
  jsonb_build_array(
    jsonb_build_object(
      'type', 'assign',
      'agent_id', (select id from agents where lower(email) = 'michael@blankssportsnutrition.com' and is_active limit 1)
    )
  )
),
(
  'Refund mentions → High priority',
  'ticket_created',
  -- LAST on purpose. Priority actions stack and the final write wins, so a
  -- refund mention on a Product question ends at High rather than being
  -- reset to Normal by Jon's rule. Moving this above the others silently
  -- inverts that.
  3,
  true,
  'any',
  '[
    {"field":"subject","operator":"contains_any","value":"refund, money back, chargeback, dispute"},
    {"field":"body","operator":"contains_any","value":"refund, money back, chargeback, dispute"}
  ]'::jsonb,
  '[{"type":"priority","priority":"high"}]'::jsonb
);
