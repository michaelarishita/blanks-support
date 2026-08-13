-- ============================================================
-- Blanks Support — inbound attachment storage
-- Run in the Supabase SQL Editor after 0004_brand_storage.sql.
-- ============================================================

-- PRIVATE, unlike the `brand` bucket. Customer attachments routinely contain
-- receipts, addresses and order details; they're served through
-- /api/attachments/[id], which checks the agent's session and then hands back
-- a short-lived signed URL.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- No storage policies needed: reads and writes both go through the
-- service-role client behind a session check in the route/sync.
