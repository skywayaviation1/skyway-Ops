// Authenticated FBO actions: match, contact edits, send, manual confirm.

import { authorizeFbo, jsonError, loadLeg, readBody, runFboAction } from './_fbo-server.js';

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
      const legUid = String(req.query?.legUid || '').trim();
      if (!legUid) return res.status(400).json({ error: 'legUid required' });
      const leg = await loadLeg(legUid);
      if (!leg) return res.status(404).json({ error: 'Leg not on the FBO desk yet' });
      return res.status(200).json({ ok: true, leg });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    const actor = await authorizeFbo(req, { write: true });
    const body = readBody(req);
    const result = await runFboAction({
      action: body.action,
      payload: body,
      actor,
    });
    const status = result.ok === false ? 502 : 200;
    return res.status(status).json(result);
  } catch (error) {
    return jsonError(res, error);
  }
}
