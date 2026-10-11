// Admin-only FBO email safety switch. Test mode defaults on.

import { authorizeFbo, jsonError, loadSettings, readBody, saveSettings } from './_fbo-server.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const actor = await authorizeFbo(req);
      const settings = await loadSettings();
      return res.status(200).json({ ok: true, settings, canEdit: actor.role === 'admin' });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    const actor = await authorizeFbo(req, { write: true });
    if (actor.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can change FBO email mode' });
    const body = readBody(req);
    const settings = await saveSettings(body, actor);
    return res.status(200).json({ ok: true, settings });
  } catch (error) {
    return jsonError(res, error);
  }
}
