alter table computers
  add column if not exists install_identity text;

-- Hostnames are labels, not device identities. Cloned/default Mac names are
-- common and must not prevent a second legitimately enrolled installation.
alter table computers
  drop constraint if exists computers_user_id_hostname_key;

create unique index if not exists computers_user_install_identity_uidx
  on computers(user_id, install_identity)
  where user_id is not null and install_identity is not null;

create table if not exists desktop_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  computer_id uuid not null references computers(id) on delete cascade,
  token_hash text not null unique,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(computer_id)
);

create index if not exists desktop_credentials_user_idx
  on desktop_credentials(user_id, last_seen_at desc)
  where revoked_at is null;

create index if not exists desktop_credentials_organization_idx
  on desktop_credentials(organization_id, last_seen_at desc)
  where revoked_at is null;

create table if not exists organization_membership_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  normalized_email text not null,
  granted_role text not null default 'engineer',
  source text not null,
  source_reference text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint organization_membership_grants_email_check
    check (normalized_email = lower(normalized_email) and normalized_email like '%@%'),
  constraint organization_membership_grants_role_check
    check (granted_role in ('engineer','viewer'))
);

create unique index if not exists organization_membership_grants_active_source_uidx
  on organization_membership_grants(organization_id, source, source_reference)
  where source_reference is not null and revoked_at is null and consumed_at is null;

create index if not exists organization_membership_grants_lookup_idx
  on organization_membership_grants(organization_id, normalized_email, expires_at desc)
  where revoked_at is null and consumed_at is null;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'openleash') then
    grant select, insert, update, delete on table desktop_credentials to openleash;
    grant select, insert, update, delete on table organization_membership_grants to openleash;
  end if;
end
$$;
