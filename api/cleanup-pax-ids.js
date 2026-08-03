// Daily privacy cleanup for passenger identification images.
//
// Images are operational evidence, not permanent records. The check-in UI
// discloses a five-day retention period, and this job enforces it in code
// rather than relying on an undocumented bucket-console lifecycle setting.
//
// Triggered by Vercel cron. CRON_SECRET is sent as `Authorization: Bearer ...`.

import admin from 'firebase-admin';
import { getStorage } from 'firebase-admin/storage';

const RETENTION_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_FILES_PER_RUN = 5000;

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  const serviceAccount = JSON.parse(raw);
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
      || 'skyway-ops-app.firebasestorage.app',
  });
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'GET or POST only' });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const app = getAdmin();
    const bucket = getStorage(app).bucket();
    const cutoff = Date.now() - RETENTION_MS;
    let pageToken;
    let inspected = 0;
    let deleted = 0;
    const errors = [];

    do {
      const [files, nextQuery] = await bucket.getFiles({
        prefix: 'pax-ids/',
        maxResults: Math.min(1000, MAX_FILES_PER_RUN - inspected),
        pageToken,
        autoPaginate: false,
      });
      for (const file of files) {
        inspected += 1;
        const created = Date.parse(file.metadata?.timeCreated || '');
        if (!Number.isFinite(created) || created > cutoff) continue;
        try {
          await file.delete({ ignoreNotFound: true });
          deleted += 1;
        } catch (err) {
          errors.push({ name: file.name, error: err?.message || String(err) });
        }
        if (inspected >= MAX_FILES_PER_RUN) break;
      }
      pageToken = nextQuery?.pageToken;
    } while (pageToken && inspected < MAX_FILES_PER_RUN);

    res.status(200).json({
      ok: true,
      inspected,
      deleted,
      retentionDays: 5,
      truncated: Boolean(pageToken),
      errors: errors.slice(0, 20),
    });
  } catch (err) {
    console.error('[cleanup-pax-ids]', err);
    res.status(500).json({ error: 'Passenger ID cleanup failed' });
  }
}
