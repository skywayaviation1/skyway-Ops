import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROLE } from './db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const migrationsDir = path.join(root, 'supabase', 'migrations');

export async function listMigrations() {
  const names = await readdir(migrationsDir);
  return names.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Apply supabase/migrations in filename order.
 * Records progress in public.schema_migrations so a second run is a no-op.
 * Supabase CLI tracks the same files in its own table when you use db push.
 * Use one of the two, not both, against a given database.
 */
/**
 * Split a migration file into statements psql would send one at a time.
 * Dollar-quoted function bodies and string literals stay intact.
 */
export function splitSql(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let dollar = null;

  while (i < sql.length) {
    if (!dollar && sql[i] === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      current += sql.slice(i, end === -1 ? sql.length : end + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (!dollar && sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        const tag = match[0];
        if (!dollar) dollar = tag;
        else if (dollar === tag) dollar = null;
        current += tag;
        i += tag.length;
        continue;
      }
    }
    if (!dollar && sql[i] === "'") {
      current += sql[i];
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (!dollar && sql[i] === ';') {
      pushStatement(statements, current);
      current = '';
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  pushStatement(statements, current);
  return statements;
}

function pushStatement(statements, raw) {
  const statement = raw.trim();
  if (!statement) return;
  const code = statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim();
  if (code) statements.push(statement);
}

export async function applyMigrations(client) {
  const who = await client.query('SELECT current_user AS role');
  if (who.rows[0].role === APP_ROLE) {
    throw new Error(
      `Refusing to migrate as ${APP_ROLE}. Use DATABASE_MIGRATION_URL (skyway_migration or the Supabase postgres role).`,
    );
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = await listMigrations();
  const applied = [];
  for (const filename of files) {
    const done = await client.query(
      'SELECT 1 FROM public.schema_migrations WHERE filename = $1',
      [filename],
    );
    if (done.rowCount) continue;
    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    const statements = splitSql(sql);
    await client.query('BEGIN');
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        'INSERT INTO public.schema_migrations (filename) VALUES ($1)',
        [filename],
      );
      await client.query('COMMIT');
      applied.push(filename);
    } catch (error) {
      await client.query('ROLLBACK');
      error.message = `${filename}: ${error.message}`;
      throw error;
    }
  }
  return applied;
}
