-- ============================================================
-- Blanks Support — full-text search (Prompt 27A)
-- Run in the Supabase SQL Editor after 0022_upload_grants.sql.
--
-- IDEMPOTENT THROUGHOUT.
--
-- Searches ticket subjects, MESSAGE BODIES (public replies, inbound mail, and
-- internal notes), customer name/email, and the ticket number. Searching the
-- bodies is the point — the main use is finding a reply we sent months ago to
-- reuse the wording.
-- ============================================================

-- Stored tsvectors, so the GIN index has something to point at. GENERATED
-- ALWAYS means Postgres keeps them in step with the source column on every
-- write — there is no trigger to forget and no backfill step to skip.
alter table tickets
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(subject, ''))) stored;

alter table messages
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', coalesce(body_text, ''))) stored;

create index if not exists tickets_fts_idx on tickets using gin (fts);
create index if not exists messages_fts_idx on messages using gin (fts);

-- One RPC does the whole search: matching across three tables, ranking, the
-- snippet, and the total count in a single round trip. The dashboard calls it
-- with the AGENT's own client, so it runs SECURITY INVOKER and the existing
-- is_agent() RLS on tickets/messages/customers decides visibility — a search
-- can never surface a row the caller could not already open.
--
-- The snippet is delimited with two CONTROL characters (U+0001 / U+0002), not
-- <mark> tags: ts_headline is fed raw customer text, and a customer message can
-- contain anything. Returning HTML from it and rendering that as markup would
-- reintroduce exactly the injection the thread avoids by rendering inbound
-- bodies as plain text. Control characters never occur in real email, so the
-- client can split on them and wrap the matches itself, with everything else
-- escaped as text. lib/search.ts holds the matching constants.
create or replace function public.search_tickets(
  q text,
  include_resolved boolean default true,
  max_results int default 50
)
returns table (
  id uuid,
  number int,
  subject text,
  status ticket_status,
  channel ticket_channel,
  priority ticket_priority,
  last_message_at timestamptz,
  created_at timestamptz,
  customer_id uuid,
  customer_name text,
  customer_email text,
  assignee_id uuid,
  assignee_name text,
  assignee_display_name text,
  matched_in text,
  snippet text,
  rank real,
  total_matches bigint
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with input as (
    select
      nullif(btrim(q), '') as raw,
      websearch_to_tsquery('english', coalesce(q, '')) as tsq,
      -- ILIKE pattern for customer name/email, with the wildcards the caller
      -- may have typed escaped so they match literally.
      '%' || replace(replace(replace(btrim(coalesce(q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        as like_pattern,
      -- A leading '#' is how people write a ticket number; strip it, then the
      -- number branch only fires when what remains is all digits.
      nullif(regexp_replace(btrim(coalesce(q, '')), '^#', ''), '') as num_text
  ),
  matches as (
    -- Subject.
    select
      t.id,
      ts_rank(t.fts, i.tsq) as rank,
      'subject'::text as matched_in,
      ts_headline(
        'english', t.subject, i.tsq,
        E'StartSel=\x01,StopSel=\x02,MaxFragments=1,MaxWords=20,MinWords=6,HighlightAll=FALSE'
      ) as snippet
    from tickets t
    cross join input i
    where numnode(i.tsq) > 0 and i.tsq @@ t.fts

    union all

    -- Message body: public replies, inbound mail, and internal notes. Nothing
    -- is filtered by direction — a reply we SENT is exactly what someone is
    -- looking for when they want to reuse its wording.
    select
      m.ticket_id,
      ts_rank(m.fts, i.tsq) as rank,
      'message'::text,
      ts_headline(
        'english', m.body_text, i.tsq,
        E'StartSel=\x01,StopSel=\x02,MaxFragments=2,MaxWords=24,MinWords=6,HighlightAll=FALSE'
      )
    from messages m
    cross join input i
    where numnode(i.tsq) > 0
      and m.type in ('public', 'internal_note')
      and i.tsq @@ m.fts

    union all

    -- Customer name or email. ILIKE rather than the tsvector: an email address
    -- tokenises badly under 'english', and a name is a substring lookup, not a
    -- language one. Fixed low rank so a wording match still sorts above it.
    select
      t.id,
      0.02::real,
      'customer'::text,
      c.name || case when c.email is not null then ' · ' || c.email else '' end
    from tickets t
    join customers c on c.id = t.customer_id
    cross join input i
    where i.raw is not null
      and (c.name ilike i.like_pattern or c.email ilike i.like_pattern)

    union all

    -- Exact ticket number. Ranked top: if you typed a number, that is the
    -- ticket you want.
    select
      t.id,
      1.0::real,
      'number'::text,
      '#' || t.number::text
    from tickets t
    cross join input i
    where i.num_text is not null
      and length(i.num_text) <= 9
      and i.num_text ~ '^[0-9]+$'
      and t.number = i.num_text::int
  ),
  -- One row per ticket, keeping its best-ranked match and that match's snippet.
  best as (
    select distinct on (m.id)
      m.id, m.rank, m.matched_in, m.snippet
    from matches m
    order by m.id, m.rank desc
  ),
  filtered as (
    select
      b.rank, b.matched_in, b.snippet,
      t.id, t.number, t.subject, t.status, t.channel, t.priority,
      t.last_message_at, t.created_at,
      t.customer_id, c.name as customer_name, c.email as customer_email,
      t.assignee_id, a.name as assignee_name, a.display_name as assignee_display_name
    from best b
    join tickets t on t.id = b.id
    join customers c on c.id = t.customer_id
    left join agents a on a.id = t.assignee_id
    -- Resolved tickets are IN by default: the old ones are what people search.
    where include_resolved or t.status not in ('resolved', 'closed')
  ),
  -- The full match count travels on every row, so the caller can say "showing
  -- the first N of M" honestly. count() is a window over the pre-LIMIT set.
  counted as (
    select f.*, count(*) over () as total_matches
    from filtered f
  )
  select
    id, number, subject, status, channel, priority,
    last_message_at, created_at,
    customer_id, customer_name, customer_email,
    assignee_id, assignee_name, assignee_display_name,
    matched_in, snippet, rank, total_matches
  from counted
  order by rank desc, last_message_at desc
  limit greatest(1, max_results);
$$;

-- Only the authenticated dashboard user calls this; the browser's anon role
-- and the public never do. RLS still applies (SECURITY INVOKER), so this grant
-- widens nothing that is_agent() does not already allow.
revoke all on function public.search_tickets(text, boolean, int) from public;
revoke all on function public.search_tickets(text, boolean, int) from anon;
grant execute on function public.search_tickets(text, boolean, int) to authenticated, service_role;

notify pgrst, 'reload schema';
