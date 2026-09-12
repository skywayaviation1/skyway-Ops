/**
 * Authenticated airport/FBO/fuel-price lookup.
 *
 * GET /api/iflightplanner-fbos?airports=KAPF,KTEB
 *
 * The OAuth client secret never reaches the browser. The full provider feed is
 * cached in the warm server process; only requested airports are returned.
 */

import admin from 'firebase-admin';
import {
  getFboDataset,
  publicIFlightPlannerStatus,
  summarizeAirportFbos,
} from './_iflightplanner.js';
import { getAdminApp, getDb } from './_foreflight.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

async function authorize(req) {
  const idToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || req.query?.idToken;
  if (!idToken) {
    const error = new Error('Sign in to view FBO and fuel-price data');
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
  if (
    !snap.exists
    || !['crew', 'pilot', 'sales', 'ops', 'admin'].includes(String(profile.role || '').toLowerCase())
    || profile.active === false
    || profile.approved !== true
  ) {
    const error = new Error('Approved flight-operations access required');
    error.status = 403;
    throw error;
  }
  return { uid: decoded.uid, role: profile.role };
}

function requestedAirports(req) {
  return String(req.query?.airports || req.query?.airport || '')
    .split(/[\s,;]+/)
    .map((airport) => airport.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
    .filter((airport, index, list) => list.indexOf(airport) === index);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    await authorize(req);
    const airports = requestedAirports(req);
    if (airports.length === 0) {
      return res.status(400).json({ error: 'Provide at least one airport identifier' });
    }
    if (airports.length > 10) {
      return res.status(400).json({ error: 'A maximum of 10 airports may be checked at once' });
    }

    const dataset = await getFboDataset();
    return res.status(200).json({
      ok: true,
      ...publicIFlightPlannerStatus(),
      fetchedAt: dataset.fetchedAt,
      recordCount: dataset.records.length,
      airports: airports.map((airport) => summarizeAirportFbos(dataset.records, airport)),
      disclaimer: 'Posted retail prices can change without notice. Confirm price, fees, and availability with the FBO before dispatch or quoting.',
    });
  } catch (error) {
    console.error('[iflightplanner-fbos]', error.code || '', error.message);
    const status = publicIFlightPlannerStatus();
    return res.status(error.status || 500).json({
      error: error.message || 'iFlightPlanner lookup failed',
      code: error.code || null,
      ...status,
      // Named explicitly so the client can tell "never configured here" from
      // "configured but the provider rejected us".
      missingEnv: error.missingEnv || status.missingEnv,
    });
  }
}
