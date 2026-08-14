-- ============================================================
-- Blanks Support — scope Gmail threads to the account that owns them
-- Run in the Supabase SQL Editor after 0005_attachments_storage.sql.
-- ============================================================

-- A Gmail threadId is only meaningful inside the mailbox that created it.
-- Passing michael@'s threadId to a send authorised as hello@ makes Gmail
-- answer 404 "Requested entity was not found", and the reply never goes out.
-- Recording which account a thread belongs to lets the sender decide whether
-- reusing it is valid.
--
-- Note this applies only to threadId. In-Reply-To/References carry RFC 5322
-- Message-IDs, which are globally meaningful and safe to send from any
-- mailbox — they are not scoped and are never the cause of that 404.
alter table tickets add column if not exists gmail_account_ref text;

comment on column tickets.gmail_account_ref is
  'Google account whose mailbox owns gmail_thread_id. Null means unknown (rows predating this column); the sender then attempts thread reuse optimistically and falls back to a fresh message on 404.';
