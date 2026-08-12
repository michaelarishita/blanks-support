-- ============================================================
-- Blanks Support — Phase 1 schema
-- Run this in the Supabase SQL Editor (or `supabase db push`)
-- ============================================================

-- ---------- ENUMS ----------
create type ticket_status as enum ('new','open','pending','resolved','closed');
create type ticket_channel as enum ('web_form','email','instagram','messenger');
create type ticket_priority as enum ('low','normal','high','urgent');
create type message_direction as enum ('inbound','outbound');
create type message_type as enum ('public','internal_note');
create type agent_role as enum ('admin','agent');

-- ---------- AGENTS ----------
-- One row per team member, linked to Supabase Auth.
create table agents (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  role agent_role not null default 'agent',
  avatar_url text,
  gmail_connected boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Auto-create an agent row when an invited user first signs in.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.agents (id, email, name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- CUSTOMERS ----------
create table customers (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  name text,
  phone text,
  ig_user_id text unique,
  fb_psid text unique,
  shopify_customer_id text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index customers_email_idx on customers (lower(email));

-- ---------- TICKETS ----------
create sequence ticket_number_seq start 1000;

create table tickets (
  id uuid primary key default gen_random_uuid(),
  number int not null default nextval('ticket_number_seq') unique,
  customer_id uuid not null references customers(id) on delete cascade,
  channel ticket_channel not null default 'web_form',
  topic text,
  subject text not null,
  status ticket_status not null default 'new',
  priority ticket_priority not null default 'normal',
  assignee_id uuid references agents(id) on delete set null,
  order_number text,
  -- external references (used by later phases)
  gmail_thread_id text,
  meta_conversation_id text,
  first_response_at timestamptz,
  resolved_at timestamptz,
  sla_due_at timestamptz,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tickets_status_idx on tickets (status);
create index tickets_assignee_idx on tickets (assignee_id);
create index tickets_channel_idx on tickets (channel);
create index tickets_customer_idx on tickets (customer_id);
create index tickets_last_message_idx on tickets (last_message_at desc);

-- ---------- MESSAGES ----------
create table messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  direction message_direction not null,
  type message_type not null default 'public',
  agent_id uuid references agents(id) on delete set null,   -- null = customer
  body_text text not null,
  body_html text,
  gmail_message_id text,
  meta_message_id text,
  delivery_status text not null default 'stored',            -- stored | queued | sent | failed
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index messages_ticket_idx on messages (ticket_id, created_at);

-- ---------- ATTACHMENTS ----------
create table attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  filename text not null,
  mime_type text,
  size_bytes int,
  storage_path text not null,
  created_at timestamptz not null default now()
);

-- ---------- TAGS ----------
create table tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text not null default '#6b7280',
  is_topic boolean not null default false,
  created_at timestamptz not null default now()
);

create table ticket_tags (
  ticket_id uuid not null references tickets(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  primary key (ticket_id, tag_id)
);

-- ---------- MACROS (canned responses) ----------
create table macros (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- TICKET EVENTS (audit trail) ----------
create table ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references tickets(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  event_type text not null,        -- status_changed | assigned | tagged | untagged | created | note_added
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index ticket_events_ticket_idx on ticket_events (ticket_id, created_at);

-- ---------- OAUTH TOKENS (Phase 2/3 — created now so schema is stable) ----------
create table oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                    -- google | meta
  agent_id uuid references agents(id) on delete cascade,
  account_ref text,                          -- email address or page id
  encrypted_refresh_token text,
  scopes text[],
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (provider, agent_id, account_ref)
);

-- ---------- EXPORTS (Phase 5) ----------
create table exports (
  id uuid primary key default gen_random_uuid(),
  range_start date,
  range_end date,
  filters jsonb not null default '{}',
  row_count int,
  storage_path text,
  created_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- TRIGGERS ----------
-- Keep tickets.last_message_at fresh & auto-reopen on customer reply.
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
    -- first outbound public reply stamps first_response_at
    first_response_at = case
      when new.direction = 'outbound' and new.type = 'public' and first_response_at is null then new.created_at
      else first_response_at
    end
  where id = new.ticket_id;
  return new;
end $$;

create trigger messages_after_insert
  after insert on messages
  for each row execute function on_message_insert();

-- Stamp resolved_at when a ticket is resolved.
create or replace function on_ticket_update()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    new.resolved_at := now();
  end if;
  return new;
end $$;

create trigger tickets_before_update
  before update on tickets
  for each row execute function on_ticket_update();

-- ---------- ROW LEVEL SECURITY ----------
alter table agents enable row level security;
alter table customers enable row level security;
alter table tickets enable row level security;
alter table messages enable row level security;
alter table attachments enable row level security;
alter table tags enable row level security;
alter table ticket_tags enable row level security;
alter table macros enable row level security;
alter table ticket_events enable row level security;
alter table oauth_tokens enable row level security;
alter table exports enable row level security;

-- Helper: is the caller an active agent?
create or replace function is_agent()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from agents where id = auth.uid() and is_active);
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from agents where id = auth.uid() and is_active and role = 'admin');
$$;

-- Agents: everyone on the team can see the team; only admins modify roles.
create policy agents_select on agents for select using (is_agent());
create policy agents_update_self on agents for update using (id = auth.uid());
create policy agents_admin_all on agents for all using (is_admin());

-- Core tables: any active agent has full access (small trusted team).
create policy customers_all on customers for all using (is_agent());
create policy tickets_all on tickets for all using (is_agent());
create policy messages_all on messages for all using (is_agent());
create policy attachments_all on attachments for all using (is_agent());
create policy tags_all on tags for all using (is_agent());
create policy ticket_tags_all on ticket_tags for all using (is_agent());
create policy macros_all on macros for all using (is_agent());
create policy ticket_events_all on ticket_events for all using (is_agent());

-- Sensitive tables: admin only.
create policy oauth_tokens_admin on oauth_tokens for all using (is_admin());
create policy exports_admin on exports for all using (is_admin());

-- ---------- REALTIME ----------
alter publication supabase_realtime add table tickets;
alter publication supabase_realtime add table messages;

-- ---------- SEED: topic tags ----------
insert into tags (name, color, is_topic) values
  ('Order questions',      '#4fc3f7', true),
  ('Product questions',    '#4caf82', true),
  ('Shipping & returns',   '#f0954f', true),
  ('Subscription',         '#a78bfa', true),
  ('Wholesale / retailer', '#f5c518', true),
  ('Sponsorship inquiry',  '#e06c5b', true),
  ('Event questions',      '#64b5f6', true),
  ('Ambassador / athlete', '#81c784', true),
  ('Feedback',             '#ba68c8', true),
  ('Other',                '#9aa3af', true);

-- ---------- SEED: starter macros ----------
insert into macros (title, body) values
  ('Where''s my order', E'Hey {{customer.first_name}},\n\nThanks for reaching out! I just looked up your order and it''s on the way. You can track it here: {{order.tracking_url}}\n\nLet me know if there''s anything else!\n\n— Blanks Support'),
  ('Return / exchange', E'Hey {{customer.first_name}},\n\nNo problem — we''re happy to help with a return or exchange. Just reply with your order number and what you''d like to swap it for, and we''ll take care of the rest.\n\n— Blanks Support'),
  ('Sponsorship inquiry', E'Hey {{customer.first_name}},\n\nThanks so much for your interest in partnering with Blanks! Please send over your social handles, audience info, and what you have in mind — we review every application and will get back to you within a week.\n\n— Blanks Support');
