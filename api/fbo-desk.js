// Ops FBO desk. GET lists upcoming legs. POST syncs the schedule snapshot the
// cron uses, because the JetInsight feed is loaded in the browser.

import { authorizeFbo, jsonError, loadDesk, readBody, syncLegs } from './_fbo-server.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (req.method === 'GET') {
      const actor = await authorizeFbo(req);
      const filters = {
        date: req.query?.date || 'upcoming',
        airport: req.query?.airport || '',
        status: req.query?.status || 'open',
        missingEmail: req.query?.missingEmail,
        fromMs: req.query?.fromMs,
        toMs: req.query?.toMs,
      };
      const desk = await loadDesk({ filters, actor });
      return res.status(200).json(desk);
    }
    if (req.method === 'POST') {
      const actor = await authorizeFbo(req, { write: true });
      const body = readBody(req);
      const synced = await syncLegs({
        legs: body.legs,
        complete: body.complete === true,
        actor,
      });
      return res.status(200).json(synced);
    }
    return res.status(405).json({ error: 'GET or POST only' });
  } catch (error) {
    return jsonError(res, error);
  }
}
