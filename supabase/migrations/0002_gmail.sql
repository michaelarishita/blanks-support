-- ============================================================
-- Blanks Support — Phase 2 (Gmail) schema
-- Run this in the Supabase SQL Editor after 0001_init.sql.
-- Covers all three Phase 2 pieces (connect, send, receive) so the
-- schema only has to be migrated once.
-- ============================================================

-- ---------- MESSAGES ----------
-- gmail_message_id (already present) holds the Gmail *API* id (e.g. "18f2c...").
-- Threading with In-Reply-To/References needs the RFC 2822 Message-ID header,
-- which is a different value — store it separately.
alter table messages add column if not exists rfc822_message_id text;

-- Dedupe guards: Pub/Sub delivers at-least-once, so the inbound sync will
-- try to insert the same Gmail message more than once.
create unique index if not exists messages_gmail_message_id_uniq
  on messages (gmail_message_id) where gmail_message_id is not null;
create index if not exists messages_rfc822_idx
  on messages (rfc822_message_id) where rfc822_message_id is not null;

-- ---------- TICKETS ----------
-- One ticket per Gmail thread; used to route customer replies back.
create unique index if not exists tickets_gmail_thread_id_uniq
  on tickets (gmail_thread_id) where gmail_thread_id is not null;

-- ---------- OAUTH TOKENS ----------
-- Cache the short-lived access token so a send doesn't always cost a refresh
-- round-trip, and track the Gmail watch state for the support inbox.
alter table oauth_tokens add column if not exists encrypted_access_token text;
alter table oauth_tokens add column if not exists access_token_expires_at timestamptz;
alter table oauth_tokens add column if not exists last_history_id text;
alter table oauth_tokens add column if not exists watch_expires_at timestamptz;
alter table oauth_tokens add column if not exists is_support_inbox boolean not null default false;
alter table oauth_tokens add column if not exists updated_at timestamptz not null default now();

-- The support mailbox connection has agent_id = null. Postgres treats NULLs as
-- distinct, so the table's unique (provider, agent_id, account_ref) constraint
-- does NOT stop duplicate support rows — this partial index does.
create unique index if not exists oauth_tokens_support_uniq
  on oauth_tokens (provider, account_ref) where agent_id is null;

-- Only one mailbox can be the designated support inbox at a time.
create unique index if not exists oauth_tokens_one_support_inbox
  on oauth_tokens (provider) where is_support_inbox;

-- ---------- NOTES ----------
-- No RLS changes. oauth_tokens stays admin-only (policy oauth_tokens_admin);
-- every read/write of a token happens server-side through the service-role
-- client, so an agent's browser session never touches ciphertext. The settings
-- page reads agents.gmail_connected (already agent-readable) for its state.
