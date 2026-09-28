import assert from 'node:assert/strict';
import test from 'node:test';
import { FEATURE_KEYS, ALWAYS_ON_KEYS } from '../../lib/control-plane/catalog.js';
import { resetPoolForTests, tenantQuery, withTenant } from '../../lib/control-plane/db.js';
import { applyMigrations } from '../../lib/control-plane/migrate.js';
import { requireFeature } from '../../lib/control-plane/require-feature.js';
import { shadowCopyUsers } from '../../lib/control-plane/shadow-users.js';
import { createTestDatabase, TENANT_TABLES } from './harness.mjs';

const FAKE_TENANT = '00000000-0000-4000-8000-000000000099';

function quoteRole(role) {
  if (role !== 'skyway_app' && role !== 'skyway_owner' && role !== 'skyway_migration') {
    throw new Error(`unexpected role ${role}`);
  }
  return role;
}

test('control plane phase 1', { timeout: 120_000 }, async (t) => {
  const db = await createTestDatabase();
  const { client } = db;
  try {
    const applied = await applyMigrations(client);
    assert.deepEqual(applied, [
      '20260928120000_roles.sql',
      '20260928120100_control_plane.sql',
      '20260928120200_resolver_and_rls.sql',
      '20260928120300_seed_skyway.sql',
    ]);
    const again = await applyMigrations(client);
    assert.deepEqual(again, []);
    await db.enableRoleLogins();

    const skyway = await client.query(`SELECT id, entitlements_version, billing_exempt FROM tenants WHERE slug = 'skyway'`);
    const skywayId = skyway.rows[0].id;
    assert.equal(skyway.rows[0].entitlements_version, 1);
    assert.equal(skyway.rows[0].billing_exempt, true);

    await t.test('forced RLS hides Skyway from another tenant and from an unset tenant', async () => {
      const flags = await client.query(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname
      `, [TENANT_TABLES]);
      assert.equal(flags.rows.length, TENANT_TABLES.length);
      for (const row of flags.rows) {
        assert.equal(row.relrowsecurity, true, row.relname);
        assert.equal(row.relforcerowsecurity, true, row.relname);
      }

      const roles = await client.query(`
        SELECT rolname, rolbypassrls, rolsuper
        FROM pg_roles
        WHERE rolname IN ('skyway_app', 'skyway_migration', 'skyway_owner')
      `);
      const byName = Object.fromEntries(roles.rows.map((row) => [row.rolname, row]));
      assert.equal(byName.skyway_app.rolbypassrls, false);
      assert.equal(byName.skyway_app.rolsuper, false);
      assert.equal(byName.skyway_owner.rolbypassrls, false);
      assert.equal(byName.skyway_migration.rolbypassrls, true);

      async function countsAs(role, tenantId) {
        await client.query('BEGIN');
        try {
          await client.query(`
            INSERT INTO users (email, firebase_uid, name)
            VALUES ('hidden.pilot@flyskyway.com', 'firebase-hidden', 'Hidden Pilot')
            ON CONFLICT (firebase_uid) DO NOTHING
          `);
          await client.query(`
            INSERT INTO memberships (tenant_id, user_id, role, status)
            SELECT $1, id, 'crew', 'active' FROM users WHERE firebase_uid = 'firebase-hidden'
            ON CONFLICT (tenant_id, user_id) DO NOTHING
          `, [skywayId]);
          await client.query(`SET LOCAL ROLE ${quoteRole(role)}`);
          await client.query('SET LOCAL row_security = on');
          if (tenantId !== undefined) {
            await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
          }
          const counts = {};
          for (const table of TENANT_TABLES) {
            const result = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
            counts[table] = result.rows[0].n;
          }
          const emails = await client.query(`SELECT email FROM users`);
          return { counts, emails: emails.rows.map((row) => row.email) };
        } finally {
          await client.query('ROLLBACK');
        }
      }

      for (const role of ['skyway_app', 'skyway_owner']) {
        for (const tenantId of [FAKE_TENANT, '', 'not-a-uuid', undefined]) {
          const seen = await countsAs(role, tenantId);
          for (const table of TENANT_TABLES) {
            assert.equal(seen.counts[table], 0, `${role} ${tenantId ?? '(unset)'} ${table}`);
          }
          assert.deepEqual(seen.emails, []);
        }

        const own = await countsAs(role, skywayId);
        assert.equal(own.counts.tenants, 1);
        assert.equal(own.counts.tenant_domains, 3);
        assert.equal(own.counts.tenant_branding, 1);
        assert.equal(own.counts.users, 1);
        assert.equal(own.counts.memberships, 1);
        assert.equal(own.counts.subscriptions, 1);
        assert.equal(own.counts.tenant_feature_effective, FEATURE_KEYS.length);
        assert.equal(own.counts.tenant_feature_overrides, 0);
        assert.deepEqual(own.emails, ['hidden.pilot@flyskyway.com']);
      }

      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE skyway_migration');
        const seen = await client.query(`SELECT count(*)::int AS n FROM tenants`);
        assert.equal(seen.rows[0].n, 1);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('the app role cannot write users, recompute, or change the audit log', async () => {
      async function expectDenied(sql, params) {
        await client.query('SAVEPOINT denied');
        await assert.rejects(
          client.query(sql, params),
          (error) => error.code === '42501',
        );
        await client.query('ROLLBACK TO SAVEPOINT denied');
      }

      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE skyway_app');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [skywayId]);
        await expectDenied(`INSERT INTO users (email) VALUES ('nope@flyskyway.com')`);
        await expectDenied(`SELECT recompute_tenant_features($1)`, [skywayId]);
        await client.query(
          `INSERT INTO audit_events (tenant_id, action, entity_type, entity_id)
           VALUES ($1, 'entitlement.override.upsert', 'feature', 'dispatch')`,
          [skywayId],
        );
        await expectDenied(
          `UPDATE audit_events SET action = 'changed' WHERE tenant_id = $1`,
          [skywayId],
        );
        await expectDenied(
          `DELETE FROM audit_events WHERE tenant_id = $1`,
          [skywayId],
        );
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [FAKE_TENANT]);
        const hidden = await client.query(`SELECT count(*)::int AS n FROM audit_events`);
        assert.equal(hidden.rows[0].n, 0);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('Skyway is seeded with every feature on and no overrides', async () => {
      const effective = await client.query(`
        SELECT feature_key, enabled, source
        FROM tenant_feature_effective e
        JOIN tenants t ON t.id = e.tenant_id
        WHERE t.slug = 'skyway'
        ORDER BY feature_key
      `);
      assert.deepEqual(effective.rows.map((row) => row.feature_key), [...FEATURE_KEYS].sort());
      assert.equal(effective.rows.every((row) => row.enabled), true);
      const sources = Object.fromEntries(effective.rows.map((row) => [row.feature_key, row.source]));
      assert.equal(sources['core.home'], 'always_on');
      assert.equal(sources['core.users'], 'always_on');
      assert.equal(sources['core.settings'], 'always_on');
      assert.equal(sources.dispatch, 'plan');
      assert.equal(sources['crew.safety_rating'], 'plan');
      assert.equal(sources['dispatch.broker_report'], 'plan');

      const overrides = await client.query(`
        SELECT count(*)::int AS n
        FROM tenant_feature_overrides o
        JOIN tenants t ON t.id = o.tenant_id
        WHERE t.slug = 'skyway'
      `);
      assert.equal(overrides.rows[0].n, 0);

      const parents = await client.query(`
        SELECT key, parent_key FROM features WHERE parent_key IS NOT NULL ORDER BY key
      `);
      assert.deepEqual(parents.rows, [
        { key: 'crew.safety_rating', parent_key: 'crew.currency' },
        { key: 'dispatch.broker_report', parent_key: 'dispatch' },
        { key: 'integrations.foreflight', parent_key: 'dispatch' },
      ]);

      const domains = await client.query(`
        SELECT hostname FROM tenant_domains d
        JOIN tenants t ON t.id = d.tenant_id
        WHERE t.slug = 'skyway'
        ORDER BY hostname
      `);
      assert.deepEqual(domains.rows.map((row) => row.hostname), [
        '135ops.app',
        'skyway.app',
        'www.skyway.app',
      ]);
    });

    await t.test('plan none resolves only core keys', async () => {
      await client.query('BEGIN');
      try {
        const created = await client.query(`
          INSERT INTO tenants (slug, name, legal_name, app_name, status, billing_exempt)
          VALUES ('sample', 'Sample Air', 'Sample Air LLC', 'Sample', 'active', false)
          RETURNING id
        `);
        const sampleId = created.rows[0].id;
        await client.query(`
          INSERT INTO subscriptions (tenant_id, plan_id, status)
          SELECT $1, id, 'active' FROM plans WHERE code = 'none'
        `, [sampleId]);

        const enabled = await client.query(`
          SELECT f.key
          FROM features f
          CROSS JOIN LATERAL resolve_feature($1, f.key, now()) r
          WHERE r.enabled
          ORDER BY f.key
        `, [sampleId]);
        assert.deepEqual(enabled.rows.map((row) => row.key), [...ALWAYS_ON_KEYS].sort());

        await client.query('SET LOCAL ROLE skyway_app');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [sampleId]);
        const home = await requireFeature({ tenantId: sampleId, client }, 'core.users');
        const dispatch = await requireFeature({ tenantId: sampleId, client }, 'dispatch');
        assert.deepEqual(home, { ok: true });
        assert.deepEqual(dispatch, { ok: false, status: 404, body: { error: 'Not found' } });
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a trial is on before expires_at and off after, even if the effective row is stale', async () => {
      await client.query('BEGIN');
      try {
        const created = await client.query(`
          INSERT INTO tenants (slug, name, legal_name, app_name, status, billing_exempt)
          VALUES ('trialco', 'Trial Co', 'Trial Co LLC', 'Trial', 'active', false)
          RETURNING id
        `);
        const tenantId = created.rows[0].id;
        await client.query(`
          INSERT INTO subscriptions (tenant_id, plan_id, status)
          SELECT $1, id, 'active' FROM plans WHERE code = 'none'
        `, [tenantId]);
        await client.query(`
          INSERT INTO tenant_feature_overrides (tenant_id, feature_key, mode, expires_at)
          VALUES ($1, 'flights.schedule', 'trial', now() + interval '1 day')
        `, [tenantId]);

        const before = await client.query(`
          SELECT enabled, source FROM resolve_feature($1, 'flights.schedule', now())
        `, [tenantId]);
        const after = await client.query(`
          SELECT enabled, source FROM resolve_feature($1, 'flights.schedule', now() + interval '2 days')
        `, [tenantId]);
        assert.deepEqual(before.rows[0], { enabled: true, source: 'trial' });
        assert.deepEqual(after.rows[0], { enabled: false, source: 'plan' });

        await client.query(`SELECT recompute_tenant_features($1, now())`, [tenantId]);
        await client.query(`
          UPDATE tenant_feature_overrides
          SET expires_at = now() - interval '1 minute'
          WHERE tenant_id = $1 AND feature_key = 'flights.schedule'
        `, [tenantId]);
        const stale = await client.query(`
          SELECT enabled FROM tenant_feature_effective
          WHERE tenant_id = $1 AND feature_key = 'flights.schedule'
        `, [tenantId]);
        const live = await client.query(`
          SELECT enabled, source FROM resolve_feature($1, 'flights.schedule', now())
        `, [tenantId]);
        assert.equal(stale.rows[0].enabled, true);
        assert.deepEqual(live.rows[0], { enabled: false, source: 'plan' });

        const later = await client.query(`SELECT now() + interval '2 days' AS at`);
        await client.query(`
          UPDATE tenant_feature_overrides
          SET expires_at = now() + interval '1 day'
          WHERE tenant_id = $1 AND feature_key = 'flights.schedule'
        `, [tenantId]);
        await client.query('SET LOCAL ROLE skyway_app');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        const open = await requireFeature({ tenantId, client }, 'flights.schedule');
        const closed = await requireFeature(
          { tenantId, client, at: later.rows[0].at },
          'flights.schedule',
        );
        assert.equal(open.ok, true);
        assert.deepEqual(closed, { ok: false, status: 404, body: { error: 'Not found' } });
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('force_off beats plan internal, and a child stays off when its parent is off', async () => {
      await client.query('BEGIN');
      try {
        await client.query(`
          INSERT INTO tenant_feature_overrides (tenant_id, feature_key, mode)
          VALUES
            ($1, 'dispatch', 'force_off'),
            ($1, 'dispatch.broker_report', 'force_on'),
            ($1, 'crew.currency', 'force_off'),
            ($1, 'crew.safety_rating', 'force_on')
        `, [skywayId]);

        const rows = await client.query(`
          SELECT f.key, r.enabled, r.source
          FROM features f
          CROSS JOIN LATERAL resolve_feature($1, f.key, now()) r
          WHERE f.key IN (
            'dispatch', 'dispatch.broker_report', 'dispatch.tracking',
            'integrations.foreflight', 'flights.schedule',
            'crew.currency', 'crew.safety_rating', 'core.home'
          )
        `, [skywayId]);
        const byKey = Object.fromEntries(rows.rows.map((row) => [row.key, row]));
        assert.equal(byKey.dispatch.enabled, false);
        assert.equal(byKey.dispatch.source, 'force_off');
        assert.equal(byKey['dispatch.broker_report'].enabled, false);
        assert.equal(byKey['integrations.foreflight'].enabled, false);
        assert.equal(byKey['dispatch.tracking'].enabled, true);
        assert.equal(byKey['flights.schedule'].enabled, true);
        assert.equal(byKey['crew.currency'].enabled, false);
        assert.equal(byKey['crew.safety_rating'].enabled, false);
        assert.equal(byKey['core.home'].enabled, true);

        await client.query(`SELECT recompute_tenant_features($1, now())`, [skywayId]);
        const stored = await client.query(`
          SELECT enabled, source FROM tenant_feature_effective
          WHERE tenant_id = $1 AND feature_key = 'dispatch'
        `, [skywayId]);
        assert.deepEqual(stored.rows[0], { enabled: false, source: 'force_off' });
        const version = await client.query(`SELECT entitlements_version FROM tenants WHERE id = $1`, [skywayId]);
        assert.equal(version.rows[0].entitlements_version, 1);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('a billing-exempt tenant with no subscription still uses plan internal', async () => {
      await client.query('BEGIN');
      try {
        const created = await client.query(`
          INSERT INTO tenants (slug, name, legal_name, app_name, status, billing_exempt)
          VALUES ('exemptco', 'Exempt Co', 'Exempt Co LLC', 'Exempt', 'active', true)
          RETURNING id
        `);
        const code = await client.query(`SELECT tenant_plan_code($1) AS code`, [created.rows[0].id]);
        const dispatch = await client.query(`
          SELECT enabled FROM resolve_feature($1, 'dispatch', now())
        `, [created.rows[0].id]);
        assert.equal(code.rows[0].code, 'internal');
        assert.equal(dispatch.rows[0].enabled, true);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('the shadow copy is one-way and safe to repeat', async () => {
      await client.query('BEGIN');
      try {
        const docs = [
          {
            id: 'uid-pat',
            data: { email: 'Pat@FlySkyway.com', name: 'Pat', role: 'pilot', approved: true, active: true },
          },
          {
            id: 'uid-pending',
            data: { email: 'new@flyskyway.com', name: 'New', role: 'crew', approved: false },
          },
          {
            id: 'uid-disabled',
            data: { email: 'old@flyskyway.com', name: 'Old', role: 'admin', approved: true, active: false },
          },
        ];
        const first = await shadowCopyUsers(client, { tenantId: skywayId, docs });
        assert.equal(first.matched, true);
        assert.equal(first.upserted, 3);

        const secondDocs = docs.map((doc) => (
          doc.id === 'uid-pat' ? { ...doc, data: { ...doc.data, name: 'Pat Updated' } } : doc
        ));
        const second = await shadowCopyUsers(client, { tenantId: skywayId, docs: secondDocs });
        assert.equal(second.matched, true);
        const pat = await client.query(`
          SELECT u.email, u.name, m.role, m.status
          FROM users u
          JOIN memberships m ON m.user_id = u.id
          WHERE u.firebase_uid = 'uid-pat'
        `);
        assert.deepEqual(pat.rows[0], {
          email: 'pat@flyskyway.com',
          name: 'Pat Updated',
          role: 'crew',
          status: 'active',
        });
        const pending = await client.query(`
          SELECT status FROM memberships m
          JOIN users u ON u.id = m.user_id
          WHERE u.firebase_uid = 'uid-pending'
        `);
        assert.equal(pending.rows[0].status, 'invited');
        const disabled = await client.query(`
          SELECT status, role FROM memberships m
          JOIN users u ON u.id = m.user_id
          WHERE u.firebase_uid = 'uid-disabled'
        `);
        assert.deepEqual(disabled.rows[0], { status: 'disabled', role: 'admin' });

        const people = await client.query(`SELECT count(*)::int AS n FROM users`);
        assert.equal(people.rows[0].n, 3);

        const shrunk = await shadowCopyUsers(client, { tenantId: skywayId, docs: [] });
        assert.equal(shrunk.matched, false);
        const stillThere = await client.query(`SELECT count(*)::int AS n FROM users`);
        assert.equal(stillThere.rows[0].n, 3);

        const runs = await client.query(`
          SELECT count(*)::int AS n FROM job_runs WHERE job = 'shadow-copy-users'
        `);
        assert.equal(runs.rows[0].n, 3);
      } finally {
        await client.query('ROLLBACK');
      }
    });

    await t.test('withTenant uses only the app role and scopes the transaction', async () => {
      const previous = process.env.DATABASE_URL;
      process.env.DATABASE_URL = db.appUrl;
      await resetPoolForTests();
      try {
        const domains = await tenantQuery(
          skywayId,
          `SELECT hostname FROM tenant_domains ORDER BY hostname`,
        );
        assert.deepEqual(domains.rows.map((row) => row.hostname), [
          '135ops.app',
          'skyway.app',
          'www.skyway.app',
        ]);
        const hidden = await tenantQuery(
          FAKE_TENANT,
          `SELECT count(*)::int AS n FROM tenants`,
        );
        assert.equal(hidden.rows[0].n, 0);
        const allowed = await requireFeature({ tenantId: skywayId }, 'crew.safety_rating');
        const missing = await requireFeature({ tenantId: skywayId }, 'not.a.feature');
        assert.equal(allowed.ok, true);
        assert.deepEqual(missing, { ok: false, status: 404, body: { error: 'Not found' } });
        await assert.rejects(
          () => withTenant('', () => {}),
          (error) => error.code === 'TENANT_REQUIRED',
        );

        process.env.DATABASE_URL = db.migrationUrl;
        await resetPoolForTests();
        await assert.rejects(
          () => tenantQuery(skywayId, 'SELECT 1'),
          (error) => error.code === 'APP_ROLE_REQUIRED',
        );

        delete process.env.DATABASE_URL;
        await resetPoolForTests();
        await assert.rejects(
          () => requireFeature({ tenantId: skywayId }, 'dispatch'),
          (error) => error.code === 'CONTROL_PLANE_UNCONFIGURED',
        );
      } finally {
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
        await resetPoolForTests();
      }
    });
  } finally {
    await db.close();
  }
});
