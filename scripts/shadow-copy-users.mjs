// One-way copy of Firestore users into Postgres users + memberships.
//
// Reads the named database appusers. Inserts and updates Postgres only.
// Does not schedule itself. Run it by hand. See docs/phase-1-setup.md.

import pg from 'pg';
import { poolConfig, APP_ROLE } from '../lib/control-plane/db.js';
import { shadowCopyUsers, SKYWAY_SLUG } from '../lib/control-plane/shadow-users.js';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) {
  fail('DATABASE_MIGRATION_URL is not set. The shadow copy did not run and Firestore was not contacted.');
} else if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  fail('FIREBASE_SERVICE_ACCOUNT_JSON is not set. The shadow copy did not run and Firestore was not contacted.');
}

let serviceAccount = null;
if (!process.exitCode) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch {
    fail('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Firestore was not contacted.');
  }
}

async function readFirestoreUsers(account) {
  const admin = (await import('firebase-admin')).default;
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(account) });
  const db = getFirestore(app, 'appusers');
  const snap = await db.collection('users').get();
  return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

if (!process.exitCode) {
  const client = new pg.Client(poolConfig(migrationUrl));
  try {
    await client.connect();
    const who = await client.query(`
      SELECT r.rolname, r.rolsuper, r.rolbypassrls
      FROM pg_roles r
      WHERE r.rolname = current_user
    `);
    const role = who.rows[0];
    if (role.rolname === APP_ROLE || (!role.rolsuper && !role.rolbypassrls)) {
      fail(`Refusing to shadow-copy as ${role.rolname}. Use skyway_migration or the Supabase postgres role.`);
    } else {
      const tenant = await client.query(
        'SELECT id FROM tenants WHERE slug = $1',
        [SKYWAY_SLUG],
      );
      if (!tenant.rows[0]) {
        fail('Tenant skyway is not in Postgres. Apply the control-plane migrations first. Firestore was not contacted.');
      } else {
        const docs = await readFirestoreUsers(serviceAccount);
        await client.query('BEGIN');
        try {
          const result = await shadowCopyUsers(client, {
            tenantId: tenant.rows[0].id,
            docs,
          });
          await client.query('COMMIT');
          console.log(JSON.stringify(result, null, 2));
          if (!result.matched) process.exitCode = 2;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    }
  } catch (error) {
    fail(error.message);
  } finally {
    await client.end().catch(() => {});
  }
}
