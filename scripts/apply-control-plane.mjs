// Apply supabase/migrations with the migration connection.
// Does nothing to Firestore. Refuses the app role.

import pg from 'pg';
import { poolConfig } from '../lib/control-plane/db.js';
import { applyMigrations } from '../lib/control-plane/migrate.js';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL is not set. Migrations were not applied.');
  process.exit(1);
}

const client = new pg.Client(poolConfig(url));
try {
  await client.connect();
  const applied = await applyMigrations(client);
  if (applied.length === 0) {
    console.log('Control-plane migrations already applied.');
  } else {
    console.log(`Applied ${applied.length} migration(s):`);
    for (const filename of applied) console.log(`  ${filename}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
