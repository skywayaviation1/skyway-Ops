/**
 * Authenticated FBO and fuel-provider lookup.
 *
 * GET /api/aviowiki-fbos?airports=KTEB,KAPF
 *
 * Handling and fuel providers only. An FBO is a handling provider whose
 * serviceLevel is FBO. Fuel prices come from /providers/{aid}/fuelProducts/all.
 * The browser never receives AVIOWIKI_API_TOKEN.
 */

import {
  authorizeFlightOps,
  aviowikiConfigured,
  getAirportFbos,
  mapPool,
  publicAviowikiStatus,
  requestedAirports,
} from './_aviowiki.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    await authorizeFlightOps(req);
    const airports = requestedAirports(req);
    if (airports.length === 0) {
      return res.status(400).json({ error: 'Provide at least one airport identifier' });
    }
    if (airports.length > 10) {
      return res.status(400).json({ error: 'A maximum of 10 airports may be checked at once' });
    }
    if (!aviowikiConfigured()) {
      return res.status(200).json({
        ok: true,
        ...publicAviowikiStatus(),
        airports: airports.map((airport) => ({
          requested: airport,
          airport,
          airportName: '',
          fbos: [],
          unavailable: true,
        })),
        disclaimer: 'aviowiki is not configured on this server.',
      });
    }

    const results = await mapPool(airports, 3, async (airport) => {
      try {
        return await getAirportFbos(airport);
      } catch (error) {
        if (error.code === 'aviowiki_not_configured' || error.code === 'aviowiki_auth_failed') throw error;
        return {
          requested: airport,
          airport,
          airportName: '',
          fbos: [],
          error: error.message,
          code: error.code || null,
        };
      }
    });
    return res.status(200).json({
      ok: true,
      ...publicAviowikiStatus(),
      stale: results.some((result) => result.stale),
      airports: results,
      disclaimer: 'aviowiki fuel prices are a labeled fallback. Confirm price, currency, fees, and availability with the FBO before dispatch or quoting.',
    });
  } catch (error) {
    console.error('[aviowiki-fbos]', error.code || '', error.message);
    return res.status(error.status || 500).json({
      error: error.message || 'aviowiki FBO lookup failed',
      code: error.code || null,
      ...publicAviowikiStatus(),
    });
  }
}
