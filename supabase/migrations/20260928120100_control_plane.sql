-- Control-plane tables. Operational tables (trips, duty, and the rest) are
-- created in later waves. Every tenant-owned table gets tenant_id, an index
-- that starts with tenant_id, and forced row-level security in the next
-- migration.

CREATE TABLE roles (
  code text PRIMARY KEY,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tenant'))
);

COMMENT ON TABLE roles IS
  'Tenant membership roles. Platform staff are platform_operators, not a row here.';

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  legal_name text NOT NULL,
  app_name text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('provisioning', 'active', 'trialing', 'past_due', 'suspended', 'canceled')
  ),
  billing_exempt boolean NOT NULL DEFAULT false,
  stripe_customer_id text,
  entitlements_version integer NOT NULL DEFAULT 1 CHECK (entitlements_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  hostname text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('pinned', 'subdomain', 'custom')),
  verified_at timestamptz
);

CREATE INDEX tenant_domains_tenant_idx ON tenant_domains (tenant_id);

CREATE TABLE tenant_branding (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  logo_url text,
  logo_dark_url text,
  logo_mark_url text,
  logo_mark_dark_url text,
  accent_dark text,
  accent_light text,
  accent jsonb,
  contact_email text,
  contact_phone text,
  tagline text,
  email_from text
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  firebase_uid text UNIQUE,
  auth_subject text,
  name text
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL REFERENCES roles (code),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

CREATE TABLE platform_operators (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner', 'support'))
);

CREATE TABLE identity_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  kind text NOT NULL CHECK (kind IN ('microsoft', 'saml', 'google')),
  entra_tenant_id text,
  domains text[] NOT NULL DEFAULT '{}'
);

CREATE INDEX identity_providers_tenant_idx ON identity_providers (tenant_id);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  stripe_price_id text UNIQUE,
  name text NOT NULL
);

CREATE TABLE features (
  key text PRIMARY KEY,
  parent_key text REFERENCES features (key),
  label text NOT NULL,
  always_on boolean NOT NULL DEFAULT false,
  nav_section text,
  sort integer NOT NULL
);

CREATE TABLE plan_features (
  plan_id uuid NOT NULL REFERENCES plans (id),
  feature_key text NOT NULL REFERENCES features (key),
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  stripe_customer_id text,
  stripe_subscription_id text,
  plan_id uuid REFERENCES plans (id),
  status text NOT NULL,
  seat_quantity integer,
  trial_ends_at timestamptz,
  current_period_end timestamptz
);

CREATE TABLE tenant_feature_overrides (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  feature_key text NOT NULL REFERENCES features (key),
  mode text NOT NULL CHECK (mode IN ('force_on', 'force_off', 'trial')),
  expires_at timestamptz,
  reason text,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key),
  CHECK (mode <> 'trial' OR expires_at IS NOT NULL)
);

CREATE INDEX tenant_feature_overrides_tenant_idx
  ON tenant_feature_overrides (tenant_id);

CREATE TABLE tenant_feature_effective (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  feature_key text NOT NULL REFERENCES features (key),
  enabled boolean NOT NULL,
  source text NOT NULL CHECK (
    source IN ('always_on', 'plan', 'force_on', 'force_off', 'trial')
  ),
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, feature_key)
);

CREATE INDEX tenant_feature_effective_tenant_idx
  ON tenant_feature_effective (tenant_id, enabled);

CREATE TABLE tenant_secrets (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id),
  actor_user_id uuid REFERENCES users (id),
  actor_role text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, created_at);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id),
  job text NOT NULL,
  ok boolean NOT NULL,
  detail text,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_runs_tenant_idx ON job_runs (tenant_id, job, started_at);

COMMENT ON TABLE tenant_secrets IS
  'Ciphertext only. Phase 1 creates the table. Nothing writes secrets yet.';

COMMENT ON COLUMN tenants.entitlements_version IS
  'Bumped in the same transaction as an override or plan rebuild.';
