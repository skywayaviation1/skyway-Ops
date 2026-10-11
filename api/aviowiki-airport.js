/**
 * Authenticated airport brief: identity, runways, hours, customs, ATC,
 * fire cover, and operational notes.
 *
 * GET /api/aviowiki-airport?icao=KTEB
 *
 * When AVIOWIKI_API_TOKEN is absent, aviowiki sections are omitted and the
 * response falls back to the OurAirports cache (name and runways only).
 */

import {
  authorizeFlightOps,
  aviowikiConfigured,
  getAirportBundle,
  ourAirportsFallback,
  publicAviowikiStatus,
  requestedAirports,
} from './_aviowiki.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

function cors(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function maybeDb() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const { getDb } = await import('./_foreflight.js');
    return getDb();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    await authorizeFlightOps(req);
    const airports = requestedAirports(req, { single: true });
    if (airports.length !== 1) {
      return res.status(400).json({ error: 'Provide one airport identifier in icao' });
    }
    const icao = airports[0];
    if (!aviowikiConfigured()) {
      const fallback = await ourAirportsFallback(icao, await maybeDb());
      return res.status(200).json({
        ok: true,
        ...publicAviowikiStatus(),
        source: fallback?.source || null,
        stale: false,
        airport: fallback?.airport || { icao, name: '' },
        runways: fallback?.runways || [],
        availability: null,
        notes: [],
      });
    }

    try {
      const bundle = await getAirportBundle(icao);
      return res.status(200).json({ ok: true, ...publicAviowikiStatus(), ...bundle });
    } catch (error) {
      const fallback = await ourAirportsFallback(icao, await maybeDb());
      if (fallback) {
        return res.status(200).json({
          ok: true,
          ...publicAviowikiStatus(),
          ...fallback,
          stale: false,
          warning: error.message,
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('[aviowiki-airport]', error.code || '', error.message);
    return res.status(error.status || 500).json({
      error: error.message || 'aviowiki airport lookup failed',
      code: error.code || null,
      ...publicAviowikiStatus(),
    });
  }
}
