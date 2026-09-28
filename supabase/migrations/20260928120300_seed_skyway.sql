-- Skyway is tenant #1. Branding is copied from src/brand.js.
-- Plan internal contains every feature key. Plan none contains only the
-- always-on core keys. Skyway is billing_exempt on internal, with no overrides,
-- so every feature resolves on. Do not seed a force_off.

INSERT INTO roles (code, label, kind) VALUES
  ('crew', 'Crew', 'tenant'),
  ('sales', 'Sales', 'tenant'),
  ('ops', 'Ops', 'tenant'),
  ('maint', 'Maintenance', 'tenant'),
  ('accounting', 'Accounting', 'tenant'),
  ('admin', 'Admin', 'tenant'),
  ('owner', 'Owner', 'tenant');

INSERT INTO features (key, parent_key, label, always_on, nav_section, sort) VALUES
  ('core.home', NULL, 'Home', true, 'home', 10),
  ('core.users', NULL, 'Users', true, 'users', 20),
  ('core.settings', NULL, 'Settings', true, 'settings', 30),
  ('flights.schedule', NULL, 'Schedule', false, 'schedule', 100),
  ('flights.availability', NULL, 'Availability', false, 'availability', 110),
  ('flights.airport_data', NULL, 'Airport & Fuel', false, 'airport-data', 120),
  ('dispatch', NULL, 'Dispatch', false, 'ops', 200),
  ('dispatch.tracking', NULL, 'Tracking', false, 'tracking', 210),
  ('dispatch.manifests', NULL, 'Manifests', false, 'manifests', 220),
  ('dispatch.lodging', NULL, 'Lodging', false, 'lodging', 230),
  ('dispatch.broker_share', NULL, 'Share with broker', false, NULL, 240),
  ('crew.duty', NULL, 'Duty', false, 'duty', 300),
  ('crew.currency', NULL, 'Currency', false, 'currency', 310),
  ('crew.pilot_docs', NULL, 'Pilot documents', false, NULL, 330),
  ('crew.reports', NULL, 'Reports', false, 'reports', 340),
  ('crew.wear', NULL, 'Wear', false, 'wear', 350),
  ('maintenance', NULL, 'Maintenance', false, 'maint', 400),
  ('maintenance.aog', NULL, 'AOG', false, 'aog', 410),
  ('comms', NULL, 'Comms', false, 'comms', 500),
  ('comms.teams', NULL, 'Teams', false, 'teams', 510),
  ('email.mailbox', NULL, 'Mailbox', false, 'mailbox', 600),
  ('email.charter_inbox', NULL, 'Shared inbox', false, 'inbox', 610),
  ('finance.expenses', NULL, 'Expenses', false, 'expenses', 700),
  ('finance.wallet', NULL, 'Wallet', false, 'wallet', 710),
  ('finance.accounting', NULL, 'Accounting', false, 'accounting', 720),
  ('platform.custom_domain', NULL, 'Custom domain', false, NULL, 900),
  ('platform.saml', NULL, 'SAML', false, NULL, 910),
  ('platform.audit_export', NULL, 'Audit export', false, NULL, 920);

INSERT INTO features (key, parent_key, label, always_on, nav_section, sort) VALUES
  ('dispatch.broker_report', 'dispatch', 'Broker pilot report', false, NULL, 250),
  ('crew.safety_rating', 'crew.currency', 'Pilot safety rating', false, NULL, 320),
  ('integrations.foreflight', 'dispatch', 'ForeFlight', false, NULL, 800);

INSERT INTO plans (code, stripe_price_id, name) VALUES
  ('internal', NULL, 'Internal'),
  ('none', NULL, 'No subscription');

INSERT INTO plan_features (plan_id, feature_key)
SELECT p.id, f.key
FROM plans p
CROSS JOIN features f
WHERE p.code = 'internal';

INSERT INTO plan_features (plan_id, feature_key)
SELECT p.id, f.key
FROM plans p
JOIN features f ON f.always_on
WHERE p.code = 'none';

INSERT INTO tenants (
  slug, name, legal_name, app_name, status, billing_exempt, entitlements_version
) VALUES (
  'skyway',
  'Skyway Aviation',
  'Skyway Aviation Services',
  'Skyway Ops',
  'active',
  true,
  1
);

INSERT INTO tenant_domains (tenant_id, hostname, kind, verified_at)
SELECT t.id, host.hostname, 'pinned', now()
FROM tenants t
CROSS JOIN (
  VALUES ('www.skyway.app'), ('skyway.app'), ('135ops.app')
) AS host(hostname)
WHERE t.slug = 'skyway';

INSERT INTO tenant_branding (
  tenant_id,
  logo_url,
  logo_dark_url,
  logo_mark_url,
  logo_mark_dark_url,
  accent_dark,
  accent_light,
  accent,
  contact_email,
  contact_phone,
  tagline,
  email_from
)
SELECT
  t.id,
  '/skyway-logo',
  '/skyway-logo-reverse',
  '/skyway-logo-nav',
  '/skyway-logo-nav-reverse',
  '#3FA9CC',
  '#12708C',
  $json${
    "dark": {
      "base": "#3FA9CC",
      "soft": "rgba(63, 169, 204, 0.12)",
      "border": "rgba(63, 169, 204, 0.40)",
      "contrast": "#06171E"
    },
    "light": {
      "base": "#12708C",
      "soft": "rgba(18, 112, 140, 0.09)",
      "border": "rgba(18, 112, 140, 0.32)",
      "contrast": "#FFFFFF"
    }
  }$json$::jsonb,
  'charters@flyskyway.com',
  '727-605-5000',
  'Private Jet & Helicopter Charter Services',
  'Skyway Ops <noreply@send.flyskyway.com>'
FROM tenants t
WHERE t.slug = 'skyway';

INSERT INTO subscriptions (tenant_id, plan_id, status)
SELECT t.id, p.id, 'active'
FROM tenants t
JOIN plans p ON p.code = 'internal'
WHERE t.slug = 'skyway';

SELECT recompute_tenant_features(id, now())
FROM tenants
WHERE slug = 'skyway';
