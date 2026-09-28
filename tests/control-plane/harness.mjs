import pg from 'pg';

const TEST_DB = 'skyway_control_plane_test';
const TEST_PASSWORD = 'control-plane-test';

function configForDatabase(config, database) {
  if (config.connectionString) {
    const url = new URL(config.connectionString);
    url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }
  return { ...config, database };
}

async function connectAdmin() {
  const configs = [];
  if (process.env.CONTROL_PLANE_ADMIN_URL) {
    configs.push({ connectionString: process.env.CONTROL_PLANE_ADMIN_URL });
  } else {
    configs.push({
      host: '/var/run/postgresql',
      user: process.env.USER || 'postgres',
      database: 'postgres',
    });
    configs.push({
      connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    });
  }

  let lastError;
  for (const config of configs) {
    const client = new pg.Client({ ...config, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      return { client, config };
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
    }
  }
  throw new Error(
    `Could not connect to Postgres for control-plane tests. Set CONTROL_PLANE_ADMIN_URL. ${lastError?.message || ''}`,
  );
}

export async function createTestDatabase() {
  const { client: admin, config } = await connectAdmin();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const db = new pg.Client(configForDatabase(config, TEST_DB));
  await db.connect();

  return {
    client: db,
    async enableRoleLogins() {
      await db.query(`ALTER ROLE skyway_app WITH LOGIN PASSWORD '${TEST_PASSWORD}'`);
      await db.query(`ALTER ROLE skyway_migration WITH LOGIN PASSWORD '${TEST_PASSWORD}'`);
    },
    appUrl: `postgres://skyway_app:${TEST_PASSWORD}@127.0.0.1:5432/${TEST_DB}`,
    migrationUrl: `postgres://skyway_migration:${TEST_PASSWORD}@127.0.0.1:5432/${TEST_DB}`,
    async close() {
      await db.end();
    },
  };
}

export const TENANT_TABLES = [
  'tenants',
  'tenant_domains',
  'tenant_branding',
  'users',
  'memberships',
  'identity_providers',
  'subscriptions',
  'tenant_feature_overrides',
  'tenant_feature_effective',
  'tenant_secrets',
  'audit_events',
  'job_runs',
  'platform_operators',
];
