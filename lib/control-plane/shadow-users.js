import { SKYWAY_SLUG } from './skyway-brand.js';

export { SKYWAY_SLUG };

const DIRECT_ROLES = new Set([
  'crew',
  'sales',
  'ops',
  'maint',
  'accounting',
  'admin',
  'owner',
]);

const ROLE_REMAP = {
  pilot: 'crew',
  'chief-pilot': 'ops',
  chief_pilot: 'ops',
};

export const SHADOW_JOB = 'shadow-copy-users';

/**
 * Map one Firestore users/{uid} document onto a Postgres user and membership.
 * This function does not talk to Firestore or Postgres.
 */
export function mapFirestoreUser(id, data = {}) {
  const email = String(data.email || '').trim().toLowerCase();
  const name = String(data.name || '').trim() || null;
  const rawRole = String(data.role || 'crew').trim() || 'crew';
  let role = null;
  let remappedFrom = null;
  if (DIRECT_ROLES.has(rawRole)) {
    role = rawRole;
  } else if (ROLE_REMAP[rawRole]) {
    role = ROLE_REMAP[rawRole];
    remappedFrom = rawRole;
  }

  let status = 'invited';
  if (data.active === false) status = 'disabled';
  else if (data.approved === true) status = 'active';

  let skipReason = null;
  if (!id) skipReason = 'missing id';
  else if (!email) skipReason = 'missing email';
  else if (!role) skipReason = `unmapped role ${rawRole}`;

  return {
    firebaseUid: id ? String(id) : '',
    email,
    name,
    role,
    status,
    remappedFrom,
    skipReason,
  };
}

async function upsertOne(client, tenantId, mapped) {
  const user = await client.query(
    `INSERT INTO users (email, firebase_uid, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (firebase_uid) DO UPDATE
       SET email = EXCLUDED.email,
           name = EXCLUDED.name
     RETURNING id`,
    [mapped.email, mapped.firebaseUid, mapped.name],
  );
  await client.query(
    `INSERT INTO memberships (tenant_id, user_id, role, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, user_id) DO UPDATE
       SET role = EXCLUDED.role,
           status = EXCLUDED.status`,
    [tenantId, user.rows[0].id, mapped.role, mapped.status],
  );
}

/**
 * Insert Firestore user snapshots into Postgres. Never writes back.
 * Safe to call again: the same firebase uid is updated in place.
 * Rows that disappear from Firestore are left in Postgres and the job is
 * recorded as not matched, so a short read cannot delete people.
 */
export async function shadowCopyUsers(client, { tenantId, docs, startedAt = new Date() }) {
  const summary = {
    seen: docs.length,
    upserted: 0,
    skipped: 0,
    remapped: [],
    skippedDetails: [],
  };

  for (const doc of docs) {
    const mapped = mapFirestoreUser(doc.id, doc.data);
    if (mapped.skipReason) {
      summary.skipped += 1;
      summary.skippedDetails.push({ id: doc.id, reason: mapped.skipReason });
      continue;
    }
    if (mapped.remappedFrom) {
      summary.remapped.push({
        id: doc.id,
        from: mapped.remappedFrom,
        to: mapped.role,
      });
    }
    await client.query('SAVEPOINT shadow_user');
    try {
      await upsertOne(client, tenantId, mapped);
      await client.query('RELEASE SAVEPOINT shadow_user');
      summary.upserted += 1;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT shadow_user');
      summary.skipped += 1;
      summary.skippedDetails.push({
        id: doc.id,
        reason: error.message || 'upsert failed',
      });
    }
  }

  const ids = docs.map((doc) => String(doc.id)).filter(Boolean);
  const present = ids.length === 0
    ? { rows: [{ n: 0 }] }
    : await client.query(
      `SELECT count(*)::int AS n
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1
         AND u.firebase_uid = ANY($2::text[])`,
      [tenantId, ids],
    );
  const total = await client.query(
    `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1`,
    [tenantId],
  );
  const matched = summary.skipped === 0
    && present.rows[0].n === docs.length
    && total.rows[0].n === docs.length;

  const detail = JSON.stringify({
    firestore: docs.length,
    upserted: summary.upserted,
    present: present.rows[0].n,
    memberships: total.rows[0].n,
    skipped: summary.skipped,
    skippedDetails: summary.skippedDetails,
    remapped: summary.remapped,
    matched,
  });

  await client.query(
    `INSERT INTO job_runs (tenant_id, job, ok, detail, started_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, SHADOW_JOB, matched, detail, startedAt],
  );

  return {
    ...summary,
    present: present.rows[0].n,
    memberships: total.rows[0].n,
    matched,
  };
}
