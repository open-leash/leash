create table if not exists organization_domains (
  normalized_domain text primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  status text not null default 'observed',
  verification_method text not null default 'oauth_email_domain',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_domains_normalized_check
    check (normalized_domain = lower(normalized_domain) and normalized_domain ~ '^[a-z0-9.-]+$'),
  constraint organization_domains_status_check
    check (status in ('observed', 'verified'))
);

create index if not exists organization_domains_organization_idx
  on organization_domains(organization_id);

-- Preserve existing, explicitly Business workspaces before domain-based
-- discovery is enabled. Only domains belonging to exactly one qualifying
-- organization are claimed; ambiguous and consumer-mail domains fail closed.
with business_organizations as (
  select o.id
  from organizations o
  where o.infrastructure_config->>'accountAudience' = 'organization'
     or o.infrastructure_config->>'accountPackage' = 'work-managed'
     or exists (
       select 1 from idp_connections idp
       where idp.organization_id=o.id and idp.enabled=true
     )
), candidates as (
  select distinct u.organization_id,
         lower(split_part(u.email,'@',2)) as normalized_domain
  from users u
  join business_organizations bo on bo.id=u.organization_id
  where u.status='active'
    and position('@' in u.email)>1
    and lower(split_part(u.email,'@',2)) not in (
      'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com',
      'yahoo.com','icloud.com','me.com','mac.com','proton.me','protonmail.com',
      'aol.com','gmx.com','mail.com','yandex.com'
    )
), unambiguous as (
  select normalized_domain,min(organization_id::text)::uuid as organization_id
  from candidates
  group by normalized_domain
  having count(distinct organization_id)=1
)
insert into organization_domains
  (normalized_domain,organization_id,status,verification_method)
select normalized_domain,organization_id,'observed','legacy_business_backfill'
from unambiguous
on conflict (normalized_domain) do nothing;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'openleash') then
    grant select, insert, update, delete on table organization_domains to openleash;
  end if;
end
$$;
