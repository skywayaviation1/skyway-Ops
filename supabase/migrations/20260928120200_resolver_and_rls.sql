-- Entitlement resolver and forced row-level security.
--
-- app.tenant_id is a transaction setting. The app sets it only after it has
-- decided the tenant. The client never supplies it as authority. An empty or
-- invalid setting resolves to no tenant, and policies then match zero rows.

CREATE OR REPLACE FUNCTION app_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  raw text;
BEGIN
  raw := NULLIF(btrim(current_setting('app.tenant_id', true)), '');
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

-- billing_exempt (Skyway) uses plan internal. Everyone else uses the
-- subscription plan, or plan none when there is no active plan.
CREATE OR REPLACE FUNCTION tenant_plan_code(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_exempt boolean;
  v_code text;
  v_status text;
BEGIN
  SELECT t.billing_exempt INTO v_exempt
  FROM tenants t
  WHERE t.id = p_tenant;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF v_exempt THEN
    RETURN 'internal';
  END IF;

  SELECT p.code, s.status INTO v_code, v_status
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  WHERE s.tenant_id = p_tenant;

  IF v_code IS NULL THEN
    RETURN 'none';
  END IF;

  IF v_status IN ('canceled', 'incomplete', 'incomplete_expired', 'unpaid') THEN
    RETURN 'none';
  END IF;

  RETURN v_code;
END;
$$;

-- Resolution order at time p_at:
--   1. always_on is on
--   2. a parent that is off forces the child off (force_on does not punch through)
--   3. an unexpired override: force_off, force_on, or trial
--   4. otherwise the plan. An expired override falls through to the plan.
CREATE OR REPLACE FUNCTION resolve_feature(
  p_tenant uuid,
  p_key text,
  p_at timestamptz
)
RETURNS TABLE (
  enabled boolean,
  source text,
  expires_at timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_always boolean;
  v_parent text;
  v_parent_enabled boolean;
  v_parent_source text;
  v_mode text;
  v_expires timestamptz;
  v_has_override boolean;
  v_plan_has boolean;
BEGIN
  SELECT f.always_on, f.parent_key
    INTO v_always, v_parent
  FROM features f
  WHERE f.key = p_key;

  IF NOT FOUND THEN
    enabled := false;
    source := 'plan';
    expires_at := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_always THEN
    enabled := true;
    source := 'always_on';
    expires_at := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_parent IS NOT NULL THEN
    SELECT r.enabled, r.source
      INTO v_parent_enabled, v_parent_source
    FROM resolve_feature(p_tenant, v_parent, p_at) r;

    IF NOT COALESCE(v_parent_enabled, false) THEN
      enabled := false;
      source := COALESCE(v_parent_source, 'plan');
      expires_at := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT o.mode, o.expires_at
    INTO v_mode, v_expires
  FROM tenant_feature_overrides o
  WHERE o.tenant_id = p_tenant
    AND o.feature_key = p_key;

  v_has_override := FOUND;

  IF v_has_override AND v_mode = 'trial' AND v_expires IS NULL THEN
    v_has_override := false;
  END IF;

  IF v_has_override AND (v_expires IS NULL OR v_expires > p_at) THEN
    IF v_mode = 'force_off' THEN
      enabled := false;
      source := 'force_off';
      expires_at := v_expires;
      RETURN NEXT;
      RETURN;
    ELSIF v_mode = 'force_on' THEN
      enabled := true;
      source := 'force_on';
      expires_at := v_expires;
      RETURN NEXT;
      RETURN;
    ELSIF v_mode = 'trial' THEN
      enabled := true;
      source := 'trial';
      expires_at := v_expires;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM plan_features pf
    JOIN plans p ON p.id = pf.plan_id
    WHERE p.code = tenant_plan_code(p_tenant)
      AND pf.feature_key = p_key
  ) INTO v_plan_has;

  enabled := COALESCE(v_plan_has, false);
  source := 'plan';
  expires_at := NULL;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION feature_enabled(p_tenant uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN app_tenant_id() IS DISTINCT FROM p_tenant THEN false
    ELSE COALESCE(
      (SELECT r.enabled FROM resolve_feature(p_tenant, p_key, now()) r),
      false
    )
  END;
$$;

CREATE OR REPLACE FUNCTION recompute_tenant_features(
  p_tenant uuid,
  p_at timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  DELETE FROM tenant_feature_effective WHERE tenant_id = p_tenant;

  INSERT INTO tenant_feature_effective (tenant_id, feature_key, enabled, source, expires_at)
  SELECT p_tenant, f.key, r.enabled, r.source, r.expires_at
  FROM features f
  CROSS JOIN LATERAL resolve_feature(p_tenant, f.key, p_at) AS r;
END;
$$;

REVOKE ALL ON FUNCTION app_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_plan_code(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_feature(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION feature_enabled(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION recompute_tenant_features(uuid, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_tenant_id() TO skyway_app, skyway_owner, skyway_migration;
GRANT EXECUTE ON FUNCTION tenant_plan_code(uuid) TO skyway_app, skyway_migration;
GRANT EXECUTE ON FUNCTION resolve_feature(uuid, text, timestamptz) TO skyway_app, skyway_migration;
GRANT EXECUTE ON FUNCTION feature_enabled(uuid, text) TO skyway_app, skyway_migration;
GRANT EXECUTE ON FUNCTION recompute_tenant_features(uuid, timestamptz) TO skyway_migration;

-- Table owner is subject to policies. The migration role bypasses them.
ALTER TABLE tenants OWNER TO skyway_owner;
ALTER TABLE tenant_domains OWNER TO skyway_owner;
ALTER TABLE tenant_branding OWNER TO skyway_owner;
ALTER TABLE users OWNER TO skyway_owner;
ALTER TABLE memberships OWNER TO skyway_owner;
ALTER TABLE platform_operators OWNER TO skyway_owner;
ALTER TABLE identity_providers OWNER TO skyway_owner;
ALTER TABLE subscriptions OWNER TO skyway_owner;
ALTER TABLE tenant_feature_overrides OWNER TO skyway_owner;
ALTER TABLE tenant_feature_effective OWNER TO skyway_owner;
ALTER TABLE tenant_secrets OWNER TO skyway_owner;
ALTER TABLE audit_events OWNER TO skyway_owner;
ALTER TABLE job_runs OWNER TO skyway_owner;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operators FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_overrides FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_effective ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_feature_effective FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_self ON tenants
  FOR ALL
  USING (id = app_tenant_id())
  WITH CHECK (id = app_tenant_id());

CREATE POLICY tenant_domains_isolation ON tenant_domains
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_branding_isolation ON tenant_branding
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY memberships_isolation ON memberships
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- A person is visible only through a membership of the current tenant.
CREATE POLICY users_via_membership ON users
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app_tenant_id()
    )
  );

-- No policy: the app role sees zero platform operators. Support access is a
-- later, audited path and is not a tenant session.
CREATE POLICY identity_providers_isolation ON identity_providers
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY subscriptions_isolation ON subscriptions
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_feature_overrides_isolation ON tenant_feature_overrides
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_feature_effective_isolation ON tenant_feature_effective
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

CREATE POLICY tenant_secrets_isolation ON tenant_secrets
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- Append-only for the app role: INSERT and SELECT are granted, UPDATE and
-- DELETE are not. Platform events (tenant_id null) are invisible to the app.
CREATE POLICY audit_events_isolation ON audit_events
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id IS NOT NULL AND tenant_id = app_tenant_id());

CREATE POLICY job_runs_isolation ON job_runs
  FOR ALL
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT ON
  roles,
  features,
  plans,
  plan_features,
  tenants,
  tenant_domains,
  tenant_branding,
  users,
  memberships,
  identity_providers,
  subscriptions,
  tenant_feature_overrides,
  tenant_feature_effective,
  tenant_secrets,
  audit_events,
  job_runs,
  platform_operators
TO skyway_app;

GRANT INSERT ON audit_events TO skyway_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  roles,
  features,
  plans,
  plan_features,
  tenants,
  tenant_domains,
  tenant_branding,
  users,
  memberships,
  identity_providers,
  subscriptions,
  tenant_feature_overrides,
  tenant_feature_effective,
  tenant_secrets,
  audit_events,
  job_runs,
  platform_operators
TO skyway_migration;
