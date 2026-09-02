-- OAuth authorization responses must be tied to a short-lived initiation
-- record.  The browser/desktop nonce itself is never stored in plaintext.
create table if not exists oauth_login_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text unique not null,
  provider_type text not null,
  audience text not null check (audience in ('individual', 'organization')),
  organization_id uuid references organizations(id) on delete cascade,
  organization_slug text,
  final_redirect_uri text not null,
  exchange_redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists oauth_login_states_active_idx
  on oauth_login_states (state_hash, expires_at)
  where consumed_at is null;

-- A browser-to-Desktop handoff carries only a single-use code.  The code is
-- bound to the Desktop's local OAuth state and PKCE challenge so another app
-- registering the custom URL scheme cannot turn it into an enrollment grant.
create table if not exists desktop_auth_handoffs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  code_hash text unique not null,
  state_hash text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists desktop_auth_handoffs_active_idx
  on desktop_auth_handoffs (code_hash, expires_at)
  where consumed_at is null;

