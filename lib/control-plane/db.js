import pg from 'pg';

export const APP_ROLE = 'skyway_app';
export const MIGRATION_ROLE = 'skyway_migration';

let pool;

/**
 * Connection options for node-pg.
 * Local Postgres stays unencrypted. Supabase hosts use SSL.
 * The connection string itself always comes from the environment.
 */
export function poolConfig(connectionString) {
  let hostname = '';
  try {
    hostname = new URL(connectionString.replace(/^postgres(ql)?:\/\//, 'http://')).hostname;
  } catch {
    hostname = '';
  }
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';
  const hosted = hostname.endsWith('.supabase.co')
    || hostname.endsWith('.supabase.com')
    || hostname.endsWith('.pooler.supabase.com');
  const wantsSsl = hosted || /[?&]sslmode=(require|verify-full|verify-ca)/.test(connectionString);
  const config = {
    connectionString,
    application_name: 'skyway-control-plane',
  };
  if (!local && wantsSsl) {
    config.ssl = {
      rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
    };
  }
  return config;
}

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function assertAppDatabaseConfigured() {
  if (!process.env.DATABASE_URL) {
    const error = new Error(
      'DATABASE_URL is not configured. The control plane is idle and Firestore was not contacted.',
    );
    error.code = 'CONTROL_PLANE_UNCONFIGURED';
    throw error;
  }
}

export function getPool() {
  assertAppDatabaseConfigured();
  if (!pool) {
    pool = new pg.Pool({
      ...poolConfig(process.env.DATABASE_URL),
      max: 3,
    });
  }
  return pool;
}

export async function resetPoolForTests() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

/**
 * Run fn with app.tenant_id set for one transaction.
 * The connection must be skyway_app. A superuser or the migration role is refused.
 */
export async function withTenant(tenantId, fn) {
  if (!tenantId) {
    const error = new Error('withTenant requires a tenant id. Refusing to query with no app.tenant_id.');
    error.code = 'TENANT_REQUIRED';
    throw error;
  }
  const client = await getPool().connect();
  try {
    const who = await client.query(`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);
    const role = who.rows[0];
    if (!role || role.rolname !== APP_ROLE || role.rolsuper || role.rolbypassrls) {
      const error = new Error(
        `Refusing control-plane connection as ${role?.rolname || 'unknown'}. DATABASE_URL must be the ${APP_ROLE} role.`,
      );
      error.code = 'APP_ROLE_REQUIRED';
      throw error;
    }
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [String(tenantId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be idle if we failed before BEGIN.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function tenantQuery(tenantId, text, params) {
  return withTenant(tenantId, (client) => client.query(text, params));
}
