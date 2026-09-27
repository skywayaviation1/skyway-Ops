// Public CFS acknowledgement. No Skyway login. The unguessable token is the
// credential. Writes go through the Admin SDK.

import {
  acknowledgeCfs,
  findByAckToken,
  readJson,
  recoveryDb,
} from './_aog-recovery.js';
import { ackTokenUsable, publicCfsView } from '../src/aog-cfs.js';

export const config = { runtime: 'nodejs' };

function tokenFrom(req, body) {
  const query = req.query || {};
  return String(body?.token || query.token || '').trim();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.method === 'POST' ? readJson(req) : {};
    const token = tokenFrom(req, body);
    if (!token || token.length < 20) {
      res.status(400).json({ error: 'This acknowledgement link is missing or invalid' });
      return;
    }
    const db = recoveryDb();
    const found = await findByAckToken(db, token);
    if (!found) {
      res.status(404).json({ error: 'This acknowledgement link is not valid' });
      return;
    }
    const usable = ackTokenUsable(found.data, Date.now());
    if (!usable.ok) {
      res.status(usable.status).json({ error: usable.error });
      return;
    }

    if (req.method === 'GET') {
      res.status(200).json({ ok: true, coverage: publicCfsView(found.data) });
      return;
    }

    const result = await acknowledgeCfs(db, found.ref, {
      name: body.name,
      email: body.email,
      cfsCost: body.cfsCost,
      acceptedCoveragePercent: body.acceptedCoveragePercent,
      coverageLimit: body.coverageLimit,
      reference: body.reference,
      notes: body.notes,
    });
    res.status(200).json({
      ok: true,
      unchanged: result.unchanged === true,
      updated: result.updated === true,
      emailError: result.emailError || '',
      coverage: result.coverage,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Request failed' });
  }
}
