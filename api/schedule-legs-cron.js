// Refresh the JetInsight schedule cache and legs/{uid} documents.
// Vercel cron: every 5 minutes. Broker page reads the cache; this job keeps
// cancellations and tail changes warm even when nobody has the link open.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { loadLiveSchedule, clearScheduleMemory } from './_schedule-cache.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

let adminApp = null;
let _db = null;

function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}

function db() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

function cronOk(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return header === `Bearer ${expected}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  if (!cronOk(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    clearScheduleMemory();
    const schedule = await loadLiveSchedule({ db: db(), force: true });
    const cancelled = (schedule.legs || []).filter((leg) => leg.cancelled).length;
    return res.status(200).json({
      ok: true,
      legs: schedule.legs?.length || 0,
      cancelled,
      fetchedAt: schedule.fetchedAt,
    });
  } catch (error) {
    console.error('[schedule-legs-cron]', error);
    return res.status(500).json({ ok: false, error: error?.message || 'schedule refresh failed' });
  }
}
