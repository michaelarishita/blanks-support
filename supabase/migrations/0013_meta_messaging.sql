-- ============================================================
-- Blanks Support — Meta messaging (Drop 9C/9D)
-- Run in the Supabase SQL Editor after 0012_topics_and_live_routing.sql.
--
-- IDEMPOTENT THROUGHOUT, like 0012. Everything here is `if not exists`.
-- ============================================================

-- 0001 already carries every COLUMN this needs — meta_conversation_id,
-- meta_message_id, ig_user_id, fb_psid. What it does not carry is the
-- constraint that makes redelivery safe.

-- ---------- DEDUPE ----------
-- Meta redelivers aggressively: any non-200, any timeout, and the same event
-- arrives again. This is the same discipline as messages_gmail_message_id_uniq
-- — the database refuses the duplicate, so the ingest path does not have to be
-- perfectly transactional to be correct.
--
-- Partial, because every non-Meta message has a null here and nulls are not
-- distinct enough for a plain unique index to be free.
create unique index if not exists messages_meta_message_id_uniq
  on messages (meta_message_id)
  where meta_message_id is not null;

-- ---------- CONVERSATION LOOKUP ----------
-- Every inbound event asks "which ticket is this thread?" before it can do
-- anything else.
create index if not exists tickets_meta_conversation_idx
  on tickets (meta_conversation_id)
  where meta_conversation_id is not null;

-- ---------- UNSEND ----------
-- Meta lets a customer delete a message they already sent. Removing the row
-- would make the thread lie: an agent would see a reply to something that,
-- as far as the record goes, was never said. The message stays and is marked
-- instead, so "they deleted this" is itself part of the history.
alter table messages
  add column if not exists deleted_at timestamptz;
