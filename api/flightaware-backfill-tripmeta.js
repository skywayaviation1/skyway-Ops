// api/flightaware-backfill-tripmeta.js
//
// ONE-TIME / ON-DEMAND MIGRATION
//
// Loops through a client-provided list of iCal trips and writes tripMeta to
// each corresponding trip-state Firestore doc. This unblocks the FlightAware
// auto-fire matcher for trips that existed before the tripMeta schema landed
// (PR 2c), and gives admins a single-click way to backfill at any time.
//
// Triggered from the Skyway app's Settings panel by an admin. The client
// already has all iCal trips loaded — we just need the routing data and the
// trip UID for each leg.
//
// Body shape:
//   {
//     idToken: <firebase auth idToken>,
//     trips: [
//       { uid: 'f676...', tail: 'N168ZZ', from: 'KMYNN', to: 'KTPA',
//         start: '2026-05-11T10:30:00Z', legType: 'REVENUE' },
//       ...
//     ]
//   }
//
// Response:
//   { ok: true, updated: 42, created: 3, skipped: 0, errors: [] }
//
// Behavior:
//   - For each trip with valid tail/from/uid:
//       - If trip-state doc exists, update its tripMeta field (shallow merge)
//       - If trip-state doc doesn't exist, create it with just tripMeta +
//         updatedAt fields so the matcher can find it
//   - Trips without tail/from/uid are counted as skipped
//   - All errors collected and returned, processing continues

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';

let adminApp = null;
let _db = null;

function getAdmin() {
  if (adminApp) return adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return adminApp;
}

function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { idToken, trips } = req.body || {};

    if (!idToken) {
      res.status(401).json({ error: 'Missing idToken' });
      return;
    }
    if (!Array.isArray(trips)) {
      res.status(400).json({ error: 'trips must be an array' });
      return;
    }

    // === Verify admin role ===
    const auth = admin.auth(getAdmin());
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch (e) {
      res.status(401).json({ error: 'Invalid idToken' });
      return;
    }

    const db = getDb();
    const userSnap = await db.collection('users').doc(decoded.uid).get();
    const profile = userSnap.data() || {};
    if (
      !userSnap.exists
      || !['admin', 'ops'].includes(profile.role)
      || profile.active === false
      || profile.approved !== true
    ) {
      res.status(403).json({ error: 'Active admin or operations role required' });
      return;
    }

    // === Process each trip ===
    let updated = 0;
    let created = 0;
    let skipped = 0;
    let unchanged = 0;
    const errors = [];

    // Process in small batches to avoid hot-looping Firestore
    const BATCH_SIZE = 25;
    for (let i = 0; i < trips.length; i += BATCH_SIZE) {
      const batch = trips.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (trip) => {
        try {
          if (!trip?.uid || !trip?.tail || !trip?.from) {
            skipped++;
            return;
          }

          const tripMeta = {
            tail: String(trip.tail).toUpperCase(),
            from: String(trip.from).toUpperCase(),
            to: String(trip.to || '').toUpperCase(),
            start: trip.start || null,
            end: trip.end || null,
            legType: trip.legType || 'REVENUE',
          };

          const ref = db.collection('trip-state').doc(trip.uid);
          const snap = await ref.get();

          if (snap.exists) {
            const current = snap.data()?.tripMeta || {};
            const changed = (
              current.tail !== tripMeta.tail
              || current.from !== tripMeta.from
              || current.to !== tripMeta.to
              || current.start !== tripMeta.start
              || (current.end || null) !== tripMeta.end
              || current.legType !== tripMeta.legType
            );
            if (changed) {
              // Update only when schedule routing/times differ. This endpoint
              // runs after every feed refresh and can cover the entire future
              // schedule without rewriting unchanged docs.
              await ref.update({
                tripMeta,
                updatedAt: Date.now(),
              });
              updated++;
            } else {
              unchanged++;
            }
          } else {
            // Create a minimal doc with just tripMeta so the matcher can find it
            await ref.set({
              tripMeta,
              updatedAt: Date.now(),
              archived: false,
              brokerEmail: '',
              autoNotify: false,
              hasCatering: true,
              statuses: {},
            });
            created++;
          }
        } catch (err) {
          errors.push({ uid: trip?.uid || '?', error: err.message || String(err) });
        }
      }));
    }

    console.log('[backfill-tripmeta]', {
      total: trips.length, updated, created, unchanged, skipped, errorCount: errors.length,
    });

    res.status(200).json({ ok: true, updated, created, unchanged, skipped, errors });
  } catch (err) {
    console.error('[backfill-tripmeta] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
