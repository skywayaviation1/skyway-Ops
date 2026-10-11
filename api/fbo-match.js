// Fuzzy-match FBO names already on a leg against aviowiki handling providers.

import { authorizeFbo, jsonError, matchAirport, readBody } from './_fbo-server.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  try {
    await authorizeFbo(req);
    const body = req.method === 'POST' ? readBody(req) : {};
    const airport = req.query?.airport || body.airport;
    const hints = body.hints || String(req.query?.hints || '').split('|').filter(Boolean);
    if (!airport) return res.status(400).json({ error: 'airport required' });
    const result = await matchAirport({ airport, hints });
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    return jsonError(res, error);
  }
}
