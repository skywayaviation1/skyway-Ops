// Public, token-gated arrival confirmation. No Skyway login.
// The page shows tail, trip ID, ETA, and pax count. Never passenger names.

import { jsonError, publicGet, publicRespond, readBody } from './_fbo-server.js';

export const config = { runtime: 'nodejs' };

function tokenFrom(req) {
  const body = readBody(req);
  return String(req.query?.token || body.token || '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const token = tokenFrom(req);
    if (!token) return res.status(400).json({ error: 'Missing confirmation link' });
    if (req.method === 'GET') {
      const result = await publicGet(token);
      if (!result.ok) return res.status(result.status || 400).json(result);
      return res.status(200).json(result);
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
    const body = readBody(req);
    const result = await publicRespond({
      token,
      csrName: body.csrName,
      notes: body.notes,
      kind: body.kind === 'question' ? 'question' : 'confirm',
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    return res.status(200).json(result);
  } catch (error) {
    return jsonError(res, error);
  }
}
