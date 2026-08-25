/**
 * Is the iFlightPlanner feed reachable from *this* deployment?
 *
 * GET  /api/iflightplanner-status        → configuration only, no provider call
 * POST /api/iflightplanner-status        → admin live test: token + data request
 *
 * Environment variables are scoped per environment on most hosts, so a value
 * present in production is still absent from a branch preview, and a value
 * added without a redeploy never reaches a running function. This endpoint
 * answers which deployment served the request and what it can actually see,
 * so nobody has to infer that from an empty airport screen.
 *
 * Never returns credential values — only whether each name is present.
 */

import admin from 'firebase-admin';
import {
  deploymentContext,
  getFboDataset,
  missingCredentialNames,
  publicIFlightPlannerStatus,
} from './_iflightplanner.js';
import { getAdminApp, getDb } from './_foreflight.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

async function authorizeAdmin(idToken) {
  if (!idToken) {
    const error = new Error('Administrator sign-in required');
    error.status = 401;
    throw error;
  }
  let decoded;
  try {
    decoded = await admin.auth(getAdminApp()).verifyIdToken(idToken, true);
  } catch {
    const error = new Error('Invalid or expired session');
    error.status = 401;
    throw error;
  }
  const snap = await getDb().collection('users').doc(decoded.uid).get();
  const profile = snap.data() || {};
  if (!snap.exists || profile.role !== 'admin' || profile.active === false || profile.approved !== true) {
    const error = new Error('Active administrator access required');
    error.status = 403;
    throw error;
  }
  return { uid: decoded.uid };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      ...publicIFlightPlannerStatus(),
      hint: missingCredentialNames().length > 0
        ? 'Add the named variables to this environment and redeploy.'
        : 'Credentials are present. POST here as an administrator to run a live provider test.',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET or POST only' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    await authorizeAdmin(body.idToken);

    const missing = missingCredentialNames();
    if (missing.length > 0) {
      return res.status(200).json({
        ok: false,
        ...publicIFlightPlannerStatus(),
        stage: 'configuration',
        error: `${missing.join(' and ')} not present on this deployment (${deploymentContext().environment}).`,
      });
    }

    // A forced refresh proves the token exchange and the data call, rather than
    // reporting success from an already-cached dataset.
    const dataset = await getFboDataset({ force: true });
    const withPrices = dataset.records.filter((record) => record.fuelPrices.length > 0).length;
    return res.status(200).json({
      ok: true,
      ...publicIFlightPlannerStatus(),
      stage: 'live',
      dataset: dataset.dataset,
      note: dataset.note,
      recordCount: dataset.records.length,
      recordsWithPrices: withPrices,
      columns: dataset.headers,
      sampleAirports: dataset.records.slice(0, 5).map((record) => record.airport),
      fetchedAt: dataset.fetchedAt,
    });
  } catch (error) {
    console.error('[iflightplanner-status]', error.code || '', error.message);
    const status = publicIFlightPlannerStatus();
    const forbidden = error.code === 'iflightplanner_forbidden';
    const stage = error.code === 'iflightplanner_auth_failed'
      ? 'authorization'
      : (forbidden ? 'entitlement' : 'data');
    return res.status(error.status && error.status < 500 ? error.status : 200).json({
      ok: false,
      ...status,
      stage,
      error: error.message || 'iFlightPlanner test failed',
      code: error.code || null,
      providerMessage: error.providerMessage || null,
      providerHttpStatus: error.httpStatus || null,
      providerResultStatus: error.providerStatus ?? null,
      requestUrl: error.requestUrl || null,
      // A 403 after a successful token exchange is not something the request
      // can fix: the client is authenticated but the dataset is not enabled for
      // it, or the credentials belong to the provider's other environment.
      resolution: forbidden
        ? [
          `The token exchange succeeded, so the Client ID and Secret are valid for ${status.apiBase}.`,
          `This deployment is calling their ${status.environmentKind} host. Their dev and production`
          + ' environments issue different credentials — if these are production credentials, set'
          + ' IFLIGHTPLANNER_BASE_URL to the production API base.',
          'Otherwise ask iFlightPlanner to enable FBO & Fuel Price Data for this API client, quoting'
          + ' the provider message above. Dataset access is licensed per client.',
          'If they issued an application instance value, set IFLIGHTPLANNER_SCOPE to it.',
        ]
        : null,
    });
  }
}
