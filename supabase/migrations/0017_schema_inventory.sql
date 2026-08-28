-- ============================================================
-- Blanks Support — schema inventory for the migration banner
-- Run in the Supabase SQL Editor after 0016_alerts_and_vendor_noise.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- The migration banner used to answer "has 0013 been run?" by asking
-- PostgREST for a column and treating ANY error as absence. Two things are
-- wrong with that, and both of them cried wolf:
--
-- 1. PostgREST answers out of a CACHED view of the schema. In the minutes
--    after DDL runs, that cache legitimately does not know about a column
--    that exists — so the banner said "0013/0014/0015 have not been run"
--    at the one moment they had JUST been run.
-- 2. A network blip, a 5xx, an expired key and a genuinely missing column
--    were all `error != null`, and all read as "migration missing". The
--    check ran fifteen sequential requests, so one bad second in the middle
--    reported a contiguous RANGE of migrations as unapplied.
--
-- pg_catalog has neither problem: it is the live truth, it knows about
-- indexes and enum values (which PostgREST cannot see at all), and one call
-- either succeeds or fails as a whole — so "could not check" stays
-- distinguishable from "not there".
--
-- SECURITY INVOKER by design. pg_catalog is readable by every role, so there
-- is nothing here that needs elevating, and a definer function is a thing to
-- justify rather than a default.
create or replace function public.schema_inventory()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'tables', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
    ),
    -- 'table.column', because that is the shape the checker asks about.
    'columns', (
      select coalesce(jsonb_agg(c.relname || '.' || a.attname order by c.relname, a.attname), '[]'::jsonb)
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and a.attnum > 0
        and not a.attisdropped
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
    ),
    -- The reason this function exists at all. A migration whose whole content
    -- is an index — 0013's Meta dedupe — had no probe, so it was reported as
    -- permanently unverifiable. An index that is missing is not cosmetic
    -- there: without it a redelivered Meta event silently doubles a message.
    'indexes', (
      select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'i'
    ),
    'functions', (
      select coalesce(jsonb_agg(distinct p.proname), '[]'::jsonb)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
    ),
    -- Enum labels, so `alter type ... add value` is probeable. 0014 adds
    -- 'new_ticket' to notification_kind; without this the only evidence that
    -- file ran is a column it happens to add alongside.
    'enum_values', (
      select coalesce(jsonb_object_agg(labels.typname, labels.vals), '{}'::jsonb)
      from (
        select t.typname, jsonb_agg(e.enumlabel order by e.enumsortorder) as vals
        from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'
        group by t.typname
      ) labels
    )
  );
$$;

-- Only the server-side checker calls this. It leaks nothing sensitive — these
-- are names, and any authenticated role could read pg_catalog directly — but
-- there is no reason for a browser to be able to ask.
revoke all on function public.schema_inventory() from public;
revoke all on function public.schema_inventory() from anon, authenticated;
grant execute on function public.schema_inventory() to service_role;

-- Everything above reads pg_catalog live, but PostgREST still has to know the
-- function EXISTS before it can be called — and it learns that from the same
-- cached schema whose lag this migration is here to stop trusting. Without
-- this line, for a minute or so after you run the file, the banner would say
-- "0017 has not been run yet" about the migration you just ran: the exact
-- false alarm, in the fix for the false alarm.
notify pgrst, 'reload schema';
