create extension if not exists pgcrypto;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  region text,
  logo_url text,
  setup_completed boolean not null default false,
  current_step integer not null default 1,
  onboarding_code text unique,
  deployment_mode text not null default 'cloud',
  infrastructure_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table organizations add column if not exists deployment_mode text not null default 'cloud';
alter table organizations add column if not exists infrastructure_config jsonb not null default '{}'::jsonb;
alter table organizations add column if not exists region text;
alter table organizations add column if not exists logo_url text;
alter table organizations add column if not exists setup_completed boolean not null default false;
alter table organizations add column if not exists current_step integer not null default 1;
alter table organizations add column if not exists onboarding_code text unique;
alter table organizations add column if not exists created_at timestamptz not null default now();
alter table organizations add column if not exists updated_at timestamptz not null default now();

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  email text unique not null,
  display_name text not null,
  role text not null default 'engineer',
  first_name text,
  last_name text,
  department text,
  title text,
  idp_user_id text,
  idp_provider text,
  status text not null default 'active',
  last_login_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  token_hash text unique,
  created_at timestamptz not null default now()
);

alter table users add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table users add column if not exists first_name text;
alter table users add column if not exists last_name text;
alter table users add column if not exists department text;
alter table users add column if not exists title text;
alter table users add column if not exists idp_user_id text;
alter table users add column if not exists idp_provider text;
alter table users add column if not exists status text not null default 'active';
alter table users add column if not exists last_login_at timestamptz;
alter table users add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table users add column if not exists token_hash text unique;
alter table users add column if not exists created_at timestamptz not null default now();
create index if not exists users_organization_idx on users(organization_id);
create unique index if not exists users_org_idp_unique_idx on users(organization_id, idp_user_id) where idp_user_id is not null;

create table if not exists dashboard_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  token_hash text unique not null,
  provider text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists dashboard_sessions_token_idx on dashboard_sessions(token_hash) where revoked_at is null;
create index if not exists dashboard_sessions_user_idx on dashboard_sessions(user_id, created_at desc);

create table if not exists mobile_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  platform text not null default 'unknown',
  push_token text,
  device_name text,
  app_version text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, push_token)
);

create index if not exists mobile_devices_user_idx on mobile_devices(user_id, last_seen_at desc);
create index if not exists mobile_devices_org_idx on mobile_devices(organization_id, last_seen_at desc);

create table if not exists identity_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  name text not null,
  description text,
  idp_group_id text not null,
  idp_provider text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, idp_group_id)
);

create table if not exists identity_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references identity_groups(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(group_id, user_id)
);

create table if not exists idp_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  provider text not null,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  last_sync_at timestamptz,
  user_count integer not null default 0,
  group_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id)
);

create table if not exists role_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  role text not null,
  user_id uuid references users(id) on delete cascade,
  group_id uuid references identity_groups(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists role_assignments_org_idx on role_assignments(organization_id);
create index if not exists identity_groups_org_idx on identity_groups(organization_id);

create table if not exists computers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  hostname text not null,
  platform text not null,
  os_release text,
  last_seen_at timestamptz not null default now(),
  unique(user_id, hostname)
);

create table if not exists agent_runtimes (
  id uuid primary key default gen_random_uuid(),
  computer_id uuid references computers(id) on delete cascade,
  kind text not null,
  display_name text not null,
  version text,
  executable_path text,
  installed boolean not null default true,
  protected boolean not null default false,
  detail text,
  executable_path_key text generated always as (coalesce(executable_path, '')) stored,
  last_seen_at timestamptz not null default now(),
  unique(computer_id, kind, executable_path_key)
);

create table if not exists agent_monitoring_settings (
  user_id uuid references users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  kind text not null,
  monitored boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);

create index if not exists agent_monitoring_settings_org_idx on agent_monitoring_settings(organization_id, kind);

create table if not exists policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  name text not null,
  category text not null default 'General',
  description text not null default '',
  severity text not null default 'medium',
  natural_language_rule text not null,
  enabled boolean not null default true,
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table policies add column if not exists category text not null default 'General';
alter table policies add column if not exists locked boolean not null default false;
alter table policies add column if not exists organization_id uuid references organizations(id) on delete cascade;
alter table policies drop constraint if exists policies_name_key;
drop index if exists policies_name_unique_idx;
create unique index if not exists policies_organization_name_unique_idx
  on policies(organization_id, name)
  where organization_id is not null;
create index if not exists policies_organization_created_idx
  on policies(organization_id, created_at asc);

create table if not exists conversation_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  computer_id uuid references computers(id) on delete cascade,
  agent_runtime_id uuid references agent_runtimes(id) on delete cascade,
  session_id text not null,
  event_name text not null,
  project_path text,
  prompt text,
  tool_name text,
  payload jsonb not null,
  source text not null default 'api_hook',
  provider text,
  idempotency_key text,
  correlation_id text,
  source_capabilities jsonb not null default '{"observe":true,"block":true,"rewritePrompt":false,"rewriteToolInput":true,"rewriteResponse":false}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists conversation_events_user_idempotency_key_uidx
  on conversation_events (user_id, idempotency_key) where idempotency_key is not null;

create table if not exists evaluations (
  id uuid primary key default gen_random_uuid(),
  conversation_event_id uuid references conversation_events(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  decision text not null,
  resolution text,
  resolution_guidance text,
  resolution_payload jsonb,
  resolved_at timestamptz,
  resolved_by text,
  summary text not null,
  question text,
  model text,
  created_at timestamptz not null default now()
);

alter table evaluations add column if not exists resolution_guidance text;
alter table evaluations add column if not exists resolution_payload jsonb;

alter table evaluations add column if not exists resolution text;
alter table evaluations add column if not exists resolved_at timestamptz;
alter table evaluations add column if not exists resolved_by text;

create or replace function openleash_notify_client_sync()
returns trigger
language plpgsql
as $$
declare
  owner_user_id uuid;
  owner_organization_id uuid;
  event_kind text;
  event_id uuid;
begin
  if tg_table_name = 'conversation_events' then
    owner_user_id := new.user_id;
    event_kind := 'activity.created';
    event_id := new.id;
  else
    owner_user_id := new.user_id;
    event_id := new.id;
    if tg_op = 'UPDATE' and old.resolution is null and new.resolution is not null then
      event_kind := 'interaction.resolved';
    elsif tg_op = 'INSERT' and new.decision in ('ask', 'deny') then
      event_kind := 'interaction.created';
    else
      return new;
    end if;
  end if;

  if owner_user_id is null then return new; end if;
  select organization_id into owner_organization_id from users where id = owner_user_id;
  perform pg_notify(
    'openleash_client_sync',
    json_build_object(
      'schemaVersion', '2026-07-27.client-sync.v1',
      'id', event_id,
      'kind', event_kind,
      'occurredAt', now(),
      'userId', owner_user_id,
      'organizationId', owner_organization_id
    )::text
  );
  return new;
end;
$$;

drop trigger if exists conversation_events_client_sync on conversation_events;
create trigger conversation_events_client_sync
after insert on conversation_events
for each row execute function openleash_notify_client_sync();

drop trigger if exists evaluations_client_sync on evaluations;
create trigger evaluations_client_sync
after insert or update of resolution on evaluations
for each row execute function openleash_notify_client_sync();

create table if not exists prompt_transform_settings (
  organization_id uuid primary key references organizations(id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists plugin_settings (
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  profiles jsonb not null default '[]'::jsonb,
  ordering_priority integer,
  installed_version text,
  update_policy text not null default 'manual',
  updated_at timestamptz not null default now(),
  primary key (organization_id, plugin_id),
  constraint plugin_settings_update_policy_check check (update_policy in ('manual', 'patch', 'minor', 'locked')),
  constraint plugin_settings_profiles_array_check check (jsonb_typeof(profiles) = 'array')
);

create index if not exists plugin_settings_org_idx on plugin_settings(organization_id, plugin_id);

create table if not exists user_plugin_settings (
  user_id uuid references users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  profiles jsonb not null default '[]'::jsonb,
  ordering_priority integer,
  installed_version text,
  update_policy text not null default 'manual',
  updated_at timestamptz not null default now(),
  primary key (user_id, plugin_id),
  constraint user_plugin_settings_update_policy_check check (update_policy in ('manual', 'patch', 'minor', 'locked')),
  constraint user_plugin_settings_profiles_array_check check (jsonb_typeof(profiles) = 'array')
);

create index if not exists user_plugin_settings_org_idx on user_plugin_settings(organization_id, plugin_id);

create table if not exists plugin_state (
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null,
  scope_key text not null default 'global',
  state_key text not null,
  value jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, plugin_id, scope_key, state_key)
);

create index if not exists plugin_state_expiry_idx on plugin_state(expires_at) where expires_at is not null;

create table if not exists plugin_log_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null,
  conversation_event_id uuid references conversation_events(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  computer_id uuid references computers(id) on delete set null,
  agent_runtime_id uuid references agent_runtimes(id) on delete set null,
  level text not null,
  category text not null default 'plugin',
  code text,
  message text not null,
  scope jsonb not null default '{}'::jsonb,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint plugin_log_events_level_check check (level in ('debug', 'info', 'warn', 'error', 'security')),
  constraint plugin_log_events_category_check check (category in ('system', 'plugin', 'security', 'audit'))
);

create index if not exists plugin_log_events_org_created_idx on plugin_log_events(organization_id, created_at desc);
create index if not exists plugin_log_events_plugin_created_idx on plugin_log_events(plugin_id, created_at desc);
create index if not exists plugin_log_events_conversation_idx on plugin_log_events(conversation_event_id, created_at asc);

create table if not exists plugin_signals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null,
  conversation_event_id uuid references conversation_events(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  computer_id uuid references computers(id) on delete set null,
  agent_runtime_id uuid references agent_runtimes(id) on delete set null,
  kind text not null,
  severity text not null default 'info',
  title text not null,
  summary text,
  decision text,
  status text,
  target jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  correlation_keys text[] not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists plugin_signals_org_created_idx on plugin_signals(organization_id, created_at desc);
create index if not exists plugin_signals_kind_created_idx on plugin_signals(organization_id, kind, created_at desc);
create index if not exists plugin_signals_severity_created_idx on plugin_signals(organization_id, severity, created_at desc);
create index if not exists plugin_signals_user_created_idx on plugin_signals(user_id, created_at desc);
create index if not exists plugin_signals_plugin_created_idx on plugin_signals(plugin_id, created_at desc);
create index if not exists plugin_signals_correlation_idx on plugin_signals using gin (correlation_keys);

create table if not exists plugin_usage_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null,
  conversation_event_id uuid references conversation_events(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  computer_id uuid references computers(id) on delete set null,
  agent_runtime_id uuid references agent_runtimes(id) on delete set null,
  kind text not null,
  provider text,
  model text,
  quantity numeric,
  unit text,
  input_tokens integer,
  output_tokens integer,
  saved_tokens integer,
  estimated_cost_cents integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists plugin_usage_org_created_idx on plugin_usage_records(organization_id, created_at desc);
create index if not exists plugin_usage_user_created_idx on plugin_usage_records(user_id, created_at desc);
create index if not exists plugin_usage_plugin_created_idx on plugin_usage_records(plugin_id, created_at desc);
create index if not exists plugin_usage_kind_created_idx on plugin_usage_records(organization_id, kind, created_at desc);

create table if not exists provider_usage_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  provider text not null,
  label text,
  enabled boolean not null default true,
  status text not null default 'pending',
  credential_ciphertext text not null,
  credential_key_id text,
  metadata jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, provider)
);

create index if not exists provider_usage_connections_org_idx on provider_usage_connections(organization_id, enabled);

create table if not exists provider_usage_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  connection_id uuid references provider_usage_connections(id) on delete cascade,
  provider text not null,
  external_id text not null,
  provider_user_email text,
  provider_user_name text,
  model text,
  usage_kind text,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  request_count integer not null default 0,
  cost_cents double precision not null default 0,
  currency text not null default 'usd',
  occurred_at timestamptz not null,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider, external_id)
);

create index if not exists provider_usage_events_org_time_idx on provider_usage_events(organization_id, occurred_at desc);
create index if not exists provider_usage_events_connection_idx on provider_usage_events(connection_id);
create index if not exists provider_usage_events_user_idx on provider_usage_events(organization_id, provider_user_email);

create table if not exists provider_usage_budgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  provider text,
  scope text not null default 'organization',
  scope_key text not null default 'organization',
  monthly_budget_cents integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, provider, scope, scope_key)
);

create index if not exists provider_usage_budgets_org_idx on provider_usage_budgets(organization_id, enabled);

create table if not exists provider_usage_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  provider text,
  status text not null default 'queued',
  triggered_by text,
  records integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists provider_usage_sync_jobs_org_idx on provider_usage_sync_jobs(organization_id, created_at desc);

create table if not exists plugin_marketplace (
  plugin_id text primary key,
  slug text not null unique,
  name text not null,
  description text not null,
  version text not null,
  publisher text not null,
  developer_name text not null,
  developer_url text,
  source text not null default 'community',
  review_status text not null default 'pending_review',
  short_description text not null,
  long_description text not null,
  hero_tagline text not null,
  package_url text,
  repository_url text,
  documentation_url text,
  runtime text not null,
  execution jsonb,
  entrypoint text not null,
  events jsonb not null default '[]'::jsonb,
  permissions jsonb not null default '[]'::jsonb,
  effects jsonb not null default '[]'::jsonb,
  ordering jsonb,
  config_schema jsonb,
  default_config jsonb not null default '{}'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  icon_text text not null default 'OL',
  visual_png text,
  featured_rank integer,
  seo_title text not null,
  seo_description text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plugin_marketplace_source_check check (source in ('first_party', 'community', 'private')),
  constraint plugin_marketplace_review_check check (review_status in ('approved', 'pending_review', 'rejected'))
);

create index if not exists plugin_marketplace_search_idx on plugin_marketplace using gin (
  to_tsvector('english', slug || ' ' || description || ' ' || short_description || ' ' || coalesce(tags::text, ''))
);
create index if not exists plugin_marketplace_featured_idx on plugin_marketplace(featured_rank) where featured_rank is not null;
create index if not exists plugin_marketplace_review_idx on plugin_marketplace(review_status);

create table if not exists organization_plugin_policy (
  organization_id uuid references organizations(id) on delete cascade,
  plugin_id text not null references plugin_marketplace(plugin_id) on delete cascade,
  mandatory boolean not null default false,
  default_enabled boolean not null default false,
  user_install_allowed boolean not null default true,
  config_locked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (organization_id, plugin_id)
);

create index if not exists organization_plugin_policy_org_idx on organization_plugin_policy(organization_id, plugin_id);

create table if not exists organization_plugin_marketplace_policy (
  organization_id uuid primary key references organizations(id) on delete cascade,
  allow_user_marketplace_installs boolean not null default true,
  allow_user_community_plugins boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists plugin_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  submitted_by uuid references users(id) on delete set null,
  plugin_id text not null,
  slug text not null,
  name text not null,
  developer_name text not null,
  package_url text,
  repository_url text,
  manifest jsonb not null default '{}'::jsonb,
  status text not null default 'pending_review',
  reviewer_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plugin_submissions_status_check check (status in ('pending_review', 'approved', 'rejected'))
);

create index if not exists plugin_submissions_status_idx on plugin_submissions(status, created_at desc);

create table if not exists plugin_releases (
  id uuid primary key default gen_random_uuid(),
  plugin_id text not null,
  version text not null,
  slug text not null,
  name text not null,
  description text not null,
  publisher text not null,
  developer_name text not null,
  developer_url text,
  source text not null default 'community',
  review_status text not null default 'pending_review',
  short_description text not null,
  long_description text not null,
  hero_tagline text not null,
  package_url text,
  repository_url text not null,
  documentation_url text,
  runtime text not null,
  execution jsonb,
  entrypoint text not null,
  events jsonb not null default '[]'::jsonb,
  permissions jsonb not null default '[]'::jsonb,
  effects jsonb not null default '[]'::jsonb,
  ordering jsonb,
  config_schema jsonb,
  default_config jsonb not null default '{}'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  icon_text text not null default 'OL',
  visual_png text,
  git_ref text not null,
  commit_sha text,
  manifest_path text not null default 'openleash.plugin.json',
  manifest jsonb not null default '{}'::jsonb,
  submitted_by uuid references users(id) on delete set null,
  reviewed_by uuid references users(id) on delete set null,
  reviewer_note text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint plugin_releases_source_check check (source in ('first_party', 'community', 'private')),
  constraint plugin_releases_review_check check (review_status in ('pending_review', 'approved', 'rejected', 'yanked')),
  unique(plugin_id, version)
);

create index if not exists plugin_releases_plugin_version_idx on plugin_releases(plugin_id, version);
create index if not exists plugin_releases_review_idx on plugin_releases(review_status, created_at desc);

create table if not exists mcp_servers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  server_name text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  tool_count integer not null default 0,
  call_count integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  unique(organization_id, server_name)
);

create table if not exists mcp_tool_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  mcp_server_id uuid references mcp_servers(id) on delete cascade,
  conversation_event_id uuid references conversation_events(id) on delete cascade,
  evaluation_id uuid references evaluations(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  computer_id uuid references computers(id) on delete set null,
  agent_runtime_id uuid references agent_runtimes(id) on delete set null,
  server_name text not null,
  tool_name text not null,
  full_tool_name text not null,
  arguments jsonb not null default '{}'::jsonb,
  argument_summary text,
  project_path text,
  session_id text,
  decision text,
  resolution text,
  risk_level text not null default 'observed',
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists mcp_servers_org_last_seen_idx on mcp_servers(organization_id, last_seen_at desc);
create index if not exists mcp_tool_calls_server_idx on mcp_tool_calls(mcp_server_id, occurred_at desc);
create index if not exists mcp_tool_calls_org_idx on mcp_tool_calls(organization_id, occurred_at desc);
create index if not exists mcp_tool_calls_user_idx on mcp_tool_calls(user_id, occurred_at desc);
create index if not exists mcp_tool_calls_event_idx on mcp_tool_calls(conversation_event_id);

create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  agent_kind text not null,
  agent_name text not null,
  scope text not null,
  project_path text,
  skill_name text not null,
  skill_path text not null,
  status text not null default 'observed',
  risk_score integer not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  content_hash text not null,
  content text,
  content_preview text,
  purpose_summary text,
  content_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, user_id, skill_path)
);

create table if not exists skill_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  skill_id uuid references skills(id) on delete cascade,
  evaluation_id uuid references evaluations(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  agent_kind text not null,
  agent_name text not null,
  scope text not null,
  project_path text,
  skill_name text not null,
  skill_path text not null,
  event_type text not null,
  status text not null,
  risk_score integer not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  content_preview text,
  purpose_summary text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists skills_org_status_idx on skills(organization_id, status, updated_at desc);
create index if not exists skills_project_idx on skills(project_path, updated_at desc);
create index if not exists skill_events_org_idx on skill_events(organization_id, created_at desc);

create table if not exists policy_results (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid references evaluations(id) on delete cascade,
  policy_id uuid references policies(id) on delete set null,
  policy_name text not null,
  status text not null,
  severity text not null,
  explanation text not null,
  evidence jsonb not null default '[]'::jsonb,
  question text,
  created_at timestamptz not null default now()
);

create index if not exists conversation_events_created_at_idx on conversation_events(created_at desc);
create index if not exists evaluations_created_at_idx on evaluations(created_at desc);
create index if not exists policy_results_status_idx on policy_results(status);

create table if not exists deployment_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  label text not null,
  token_hash text unique not null,
  mode text not null default 'cloud',
  tenant_url text not null default 'openleash.local',
  mdm text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table deployment_tokens add column if not exists organization_id uuid references organizations(id) on delete cascade;
create index if not exists deployment_tokens_created_at_idx on deployment_tokens(created_at desc);
create index if not exists deployment_tokens_active_idx on deployment_tokens(token_hash) where revoked_at is null;
create index if not exists deployment_tokens_organization_created_idx on deployment_tokens(organization_id, created_at desc);

create table if not exists external_agent_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  label text not null,
  status text not null default 'configured',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, label)
);

create index if not exists external_agent_connections_provider_idx on external_agent_connections(provider);
create index if not exists conversation_events_external_evaluation_key_idx
  on conversation_events ((payload->'raw'->>'externalEvaluationKey'))
  where payload->'raw'->>'externalEvaluationKey' is not null;

alter table computers add column if not exists enrollment_token_id uuid references deployment_tokens(id) on delete set null;
alter table computers add column if not exists enrolled_at timestamptz;

delete from policies
where name in ('Credential file protection', 'Destructive command review', 'Sensitive data minimization');

insert into organizations (name, slug, region, setup_completed, current_step, onboarding_code)
values ('', 'openleash', null, false, 1, null)
on conflict (slug) do nothing;

insert into users (email, display_name, role, token_hash)
values ('dev-user@openleash.local', 'Local developer', 'owner', encode(digest(coalesce(current_setting('openleash.dev_token', true), 'dev-' || gen_random_uuid()::text), 'sha256'), 'hex'))
on conflict (email) do nothing;

update users set organization_id = (select id from organizations where slug = 'openleash' limit 1)
where organization_id is null;
