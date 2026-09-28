import { withTenant } from './db.js';

export const NOT_FOUND_BODY = Object.freeze({ error: 'Not found' });

const ENABLED_SQL = `
  SELECT CASE
    WHEN app_tenant_id() IS DISTINCT FROM $1::uuid THEN false
    ELSE COALESCE((
      SELECT r.enabled
      FROM resolve_feature($1::uuid, $2::text, COALESCE($3::timestamptz, now())) r
    ), false)
  END AS enabled
`;

/**
 * Server gate for a catalog key.
 *
 * Not called by live routes in phase 1. A missing or disabled feature is the
 * same 404 as an unknown route. The body does not name the feature.
 *
 * ctx.tenantId is the membership the host already resolved. ctx.client, when
 * present, must already be inside a transaction with app.tenant_id set.
 * ctx.at is optional and exists so tests can check an expiry without sleeping.
 * Production callers omit it and the database uses now().
 */
export async function requireFeature(ctx, key) {
  if (!ctx?.tenantId || !key) {
    return { ok: false, status: 404, body: NOT_FOUND_BODY };
  }

  const params = [ctx.tenantId, key, ctx.at || null];
  const read = async (client) => {
    const { rows } = await client.query(ENABLED_SQL, params);
    return rows[0]?.enabled === true;
  };

  const enabled = ctx.client
    ? await read(ctx.client)
    : await withTenant(ctx.tenantId, read);

  if (!enabled) {
    return { ok: false, status: 404, body: NOT_FOUND_BODY };
  }
  return { ok: true };
}
