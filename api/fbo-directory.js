// Saved FBO contacts, keyed by airport + aviowiki aid. Ops edits stick for the
// next trip through that FBO. Preferred is one per airport.

import { authorizeFbo, fboDb, jsonError, readBody, upsertDirectory } from './_fbo-server.js';
import { FBO_DIRECTORY, normalizeAirport } from '../src/fbo-notify.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      await authorizeFbo(req);
      const airport = normalizeAirport(req.query?.airport);
      let query = fboDb().collection(FBO_DIRECTORY);
      if (airport) query = query.where('airport', '==', airport);
      const snap = await query.limit(200).get();
      return res.status(200).json({
        ok: true,
        directory: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    const actor = await authorizeFbo(req, { write: true });
    const body = readBody(req);
    const row = await upsertDirectory({ ...body, actor });
    return res.status(200).json({ ok: true, entry: row });
  } catch (error) {
    return jsonError(res, error);
  }
}
