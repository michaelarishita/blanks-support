-- ============================================================
-- Blanks Support — system alerts + vendor noise (Drop 12)
-- Run in the Supabase SQL Editor after 0015_ticket_risk.sql.
--
-- IDEMPOTENT THROUGHOUT.
-- ============================================================

-- ---------- SYSTEM ALERTS ----------
--
-- The heartbeat worked. Four alerts were delivered correctly and were buried
-- under ~200 routine notification emails in fourteen days, nearly all unread.
-- An alarm that arrives in the same shape, from the same address, with the
-- same subject grammar as a hundred FYIs is not an alarm.
--
-- So an alert is now a ROW, not just an email. The row is what makes it
-- persistent: the banner keeps showing until somebody acknowledges it, which
-- an email cannot do. The email becomes the notification of the row rather
-- than the alert itself.
create table if not exists system_alerts (
  id uuid primary key default gen_random_uuid(),
  -- Stable identifier for the CONDITION, not the occurrence. Everything about
  -- repeat handling keys on this: "inbound_down" firing four times is one
  -- alert seen four times, not four alerts.
  kind text not null,
  severity text not null default 'warning'
    check (severity in ('warning', 'critical')),
  title text not null,
  reasons jsonb not null default '[]',
  detail text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Repeats escalate rather than repeating identically: the subject line
  -- counts, and past the threshold the severity is raised.
  occurrence_count int not null default 1,
  -- When the alert email actually went out, so a repeat inside the cooldown
  -- can update the row without re-mailing.
  last_notified_at timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references agents(id) on delete set null,
  created_at timestamptz not null default now()
);

-- At most ONE open alert per condition. A repeat has to find this row and
-- increment it; without the constraint the banner would grow a new copy of
-- the same problem every hour, which is the email flood again in a new place.
create unique index if not exists system_alerts_open_kind_uniq
  on system_alerts (kind)
  where acknowledged_at is null;

create index if not exists system_alerts_open_idx
  on system_alerts (last_seen_at desc)
  where acknowledged_at is null;

alter table system_alerts enable row level security;

do $$ begin
  -- Everyone on the team sees the alarm. Acknowledging is a team action, not
  -- an admin one: whoever notices first should be able to clear it.
  if not exists (select 1 from pg_policies where tablename = 'system_alerts' and policyname = 'system_alerts_select') then
    create policy system_alerts_select on system_alerts for select using (is_agent());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'system_alerts' and policyname = 'system_alerts_ack') then
    create policy system_alerts_ack on system_alerts for update using (is_agent());
  end if;
end $$;


-- ---------- IGNORED SENDERS ----------
--
-- IGNORED_SENDER_EMAILS is an env var, which means adding a sender is a
-- deploy. Roughly a third of recent tickets are vendor cold outreach, and the
-- person who can identify one is the agent reading it — not whoever has
-- access to Vercel's settings.
--
-- The env var still works and still wins; this table is unioned with it.
create table if not exists ignored_senders (
  id uuid primary key default gen_random_uuid(),
  -- Either a full address (bob@vendor.com) or a domain written with a
  -- leading @ (@vendor.com). Domains matter: cold outreach rotates the local
  -- part constantly while keeping the sending domain.
  value text not null,
  kind text not null check (kind in ('address', 'domain')),
  -- Why, in the words of whoever added it. A list nobody can audit is a list
  -- that eventually swallows a customer and nobody knows when or why.
  reason text,
  added_by uuid references agents(id) on delete set null,
  -- The ticket that prompted it, so the decision has its evidence attached.
  source_ticket_id uuid references tickets(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists ignored_senders_value_uniq
  on ignored_senders (lower(value));

alter table ignored_senders enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'ignored_senders' and policyname = 'ignored_senders_select') then
    create policy ignored_senders_select on ignored_senders for select using (is_agent());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'ignored_senders' and policyname = 'ignored_senders_insert') then
    create policy ignored_senders_insert on ignored_senders for insert with check (is_agent());
  end if;
  -- Removing an entry is how a mistake gets undone, so it must not need an
  -- admin either — but it IS logged by created_at/added_by on re-add.
  if not exists (select 1 from pg_policies where tablename = 'ignored_senders' and policyname = 'ignored_senders_delete') then
    create policy ignored_senders_delete on ignored_senders for delete using (is_agent());
  end if;
end $$;


-- ---------- VENDOR OUTREACH ----------
--
-- Deliberately NOT part of risk_score.
--
-- The risk feature's defining property is that it decides nothing, and a test
-- asserts that nothing outside the risk modules and the UI ever reads
-- risk_score. Vendor outreach DOES decide one small thing — the starting
-- priority — so folding it into the score would quietly destroy that
-- guarantee for the signals that must keep it. Separate columns keep both
-- promises intact.
alter table tickets
  add column if not exists vendor_outreach boolean not null default false,
  add column if not exists vendor_reasons jsonb not null default '[]';

create index if not exists tickets_vendor_outreach_idx
  on tickets (created_at desc)
  where vendor_outreach;


-- ---------- SEED ----------
--
-- These are DATA, taken from the senders that actually produced tickets
-- #1026-#1080, not a guess at what spam looks like. The Settings list governs
-- it from here.
--
-- Domains, where the local part is clearly disposable. Addresses otherwise.
--
-- Deliberately NOT seeded: sponsorship, athlete-partnership and wholesale
-- enquiries. Several read like cold outreach and are indistinguishable from
-- it by shape, but they are the business — there is a routing rule sending
-- Sponsorship to Michael. Muting those would be the expensive mistake here,
-- and it is the one that would be hardest to notice.
insert into ignored_senders (value, kind, reason)
values
  ('@b2bridge.io',                    'domain',  'Shopify app vendor cold outreach (#1052, #1074)'),
  ('@hulkapps.com',                   'domain',  'Shopify app vendor marketing (#1056)'),
  ('@beehiiv.com',                    'domain',  'Newsletter blasts (#1071)'),
  ('@brevosend.com',                  'domain',  'Bulk sending platform, rotating local parts (#1062)'),
  ('@meta-review-case.win',           'domain',  'Phishing — fake Meta verification (#1072)'),
  ('@capcut-mailnoreply.com',         'domain',  'Phishing — fake creator programme (#1053)'),
  ('@obkschool.com',                  'domain',  'Phishing — fake copyright notice (#1066)'),
  ('@topsoftwaredevelopmentcompany.com', 'domain', 'SEO audit spam (#1051)'),
  ('@digitalspeer.com',               'domain',  'Agency cold outreach (#1067)'),
  ('@discoverlinear.com',             'domain',  'SaaS cold outreach (#1068)'),
  ('@newvisionbooking.com',           'domain',  'Event booking cold outreach (#1069)'),
  ('@virelon7.com',                   'domain',  'Packaging cold outreach (#1064)'),
  ('@usesaveracks.com',               'domain',  'Cold outreach (#1058)'),
  ('@smbdealadvisorygroup.com',       'domain',  'M&A cold outreach (#1055)'),
  ('@optyo.net',                      'domain',  'Partnership cold outreach (#1080)'),
  ('@blueoceantea.com',               'domain',  'Partnership cold outreach (#1026)'),
  ('testflight_no_reply@email.apple.com', 'address', 'TestFlight invite spam (#1070, #1073)'),
  ('mail-noreply@google.com',         'address', 'Gmail onboarding mail'),
  ('support@judge.me',                'address', 'Vendor product notifications'),
  ('support@subi.co',                 'address', 'Vendor product notifications'),
  ('jamesjaydenexpert@gmail.com',     'address', 'Cold outreach, repeat sender (#1075, #1077)'),
  ('lauramaness456@gmail.com',        'address', 'Contact-list sales spam (#1027)'),
  ('seemarawat4@outlook.com',         'address', 'App development cold outreach (#1033)'),
  ('supportboostheight.solution3@gmail.com', 'address', 'Spam (#1045)')
on conflict do nothing;
