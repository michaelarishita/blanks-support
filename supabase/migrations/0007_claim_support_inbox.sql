-- ============================================================
-- Blanks Support — make connecting the support mailbox idempotent
-- Run in the Supabase SQL Editor after 0006_thread_account.sql.
-- ============================================================

-- There is exactly one support-inbox slot (enforced by the partial unique
-- index oauth_tokens_one_support_inbox). Connecting a mailbox must CLAIM that
-- slot, replacing whatever holds it.
--
-- The previous code matched on account_ref, so connecting a different address
-- looked like a brand-new row and tried to INSERT alongside the existing one,
-- failing with a raw constraint violation and leaving the operator stuck.
--
-- Delete + insert has to be atomic, or a crash between the two leaves no
-- support mailbox connected at all — inbound would silently stop. Doing it in
-- one function gives us a single implicit transaction, and returns the
-- displaced row so the caller can revoke its refresh token with Google.
create or replace function claim_support_inbox(
  p_account_ref text,
  p_encrypted_refresh_token text,
  p_encrypted_access_token text,
  p_access_token_expires_at timestamptz,
  p_scopes text[]
)
returns table (
  previous_account_ref text,
  previous_encrypted_refresh_token text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_account text;
  v_previous_token text;
begin
  -- FOR UPDATE so two concurrent connects serialise rather than racing.
  select o.account_ref, o.encrypted_refresh_token
    into v_previous_account, v_previous_token
  from oauth_tokens o
  where o.provider = 'google' and o.is_support_inbox
  for update;

  delete from oauth_tokens o
  where o.provider = 'google' and o.is_support_inbox;

  insert into oauth_tokens (
    provider, agent_id, account_ref,
    encrypted_refresh_token, encrypted_access_token, access_token_expires_at,
    scopes, is_support_inbox, updated_at
  ) values (
    'google', null, p_account_ref,
    p_encrypted_refresh_token, p_encrypted_access_token, p_access_token_expires_at,
    p_scopes, true, now()
  );

  return query select v_previous_account, v_previous_token;
end
$$;

-- Functions are EXECUTE-able by PUBLIC by default, which would let anyone
-- holding the anon key overwrite the support mailbox with their own token.
-- Only the service-role client may call this.
revoke all on function claim_support_inbox(text, text, text, timestamptz, text[])
  from public, anon, authenticated;
grant execute on function claim_support_inbox(text, text, text, timestamptz, text[])
  to service_role;
