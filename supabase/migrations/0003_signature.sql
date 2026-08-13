-- ============================================================
-- Blanks Support — email signature + shared brand settings
-- Run in the Supabase SQL Editor after 0002_gmail.sql.
-- ============================================================

-- ---------- AGENTS: per-person signature fields ----------
alter table agents add column if not exists title text;
alter table agents add column if not exists phone text;
alter table agents add column if not exists signature_enabled boolean not null default true;

-- ---------- SETTINGS ----------
-- Single-row key/value store for brand settings that must be editable
-- without a deploy. The `id` check constraint is what keeps it to one row.
create table if not exists settings (
  id boolean primary key default true,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references agents(id) on delete set null,
  constraint settings_single_row check (id)
);

insert into settings (id, data)
values (
  true,
  jsonb_build_object(
    'company_name', 'Blank''s Sports Nutrition',
    'website', 'https://blankssportsnutrition.com',
    'website_label', 'blankssportsnutrition.com',
    'brand_color', '#f5c518',
    -- Set by an admin in Settings → Signature once the real logo is
    -- uploaded. Until then the signature renders a styled text wordmark.
    'logo_url', null,
    'logo_width', 240,
    'logo_height', null
  )
)
on conflict (id) do nothing;

alter table settings enable row level security;

-- Everyone on the team can read brand settings (the composer previews them);
-- only admins can change them, so one agent can't alter company-wide branding.
create policy settings_select on settings for select using (is_agent());
create policy settings_admin_write on settings for all using (is_admin());
