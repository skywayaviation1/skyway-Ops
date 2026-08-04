// Admin-only organization settings. Fleet removal is deliberately
// non-destructive: schedules and maintenance history remain intact while the
// aircraft is marked scheduled-only and excluded from managed-fleet surfaces.

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import {
  DEFAULT_MANAGED_TAILS,
  normalizeAircraftByTail,
  normalizeFleetTails,
} from '../src/fleet-config.js';

function getAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  return admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const {
      idToken,
      fleetTails,
      aircraftByTail,
      trackingEnabled,
      dutyTrackerEnabled,
      dutyAlertEmails,
    } = req.body || {};
    if (!idToken || !Array.isArray(fleetTails)) {
      res.status(400).json({ error: 'idToken and fleetTails are required' });
      return;
    }

    const app = getAdmin();
    const auth = admin.auth(app);
    let caller;
    try {
      caller = await auth.verifyIdToken(idToken, true);
    } catch {
      res.status(401).json({ error: 'Invalid or revoked session' });
      return;
    }

    const db = getFirestore(app, 'appusers');
    const profileSnap = await db.collection('users').doc(caller.uid).get();
    const profile = profileSnap.data() || {};
    if (!profileSnap.exists || profile.role !== 'admin' || profile.active === false || profile.approved !== true) {
      res.status(403).json({ error: 'Active administrator access required' });
      return;
    }

    const managed = normalizeFleetTails(fleetTails);
    if (managed.length > 100 || managed.some((tail) => !/^N?[A-Z0-9-]{2,12}$/.test(tail))) {
      res.status(400).json({ error: 'Fleet contains an invalid tail number' });
      return;
    }
    const aircraft = normalizeAircraftByTail(aircraftByTail, managed);
    const emails = Array.isArray(dutyAlertEmails)
      ? [...new Set(dutyAlertEmails.map((email) => String(email || '').trim().toLowerCase()).filter(validEmail))]
      : [];

    const fleetRef = db.collection('app-config').doc('fleet');
    const oldFleetSnap = await fleetRef.get();
    const previous = oldFleetSnap.exists && oldFleetSnap.data()?.configured === true
      ? normalizeFleetTails(oldFleetSnap.data()?.managedTails || [])
      : [...DEFAULT_MANAGED_TAILS];
    const nextSet = new Set(managed);
    const removed = previous.filter((tail) => !nextSet.has(tail));

    const batch = db.batch();
    const now = Date.now();
    batch.set(fleetRef, {
      managedTails: managed,
      aircraftByTail: aircraft,
      configured: true,
      updatedAt: now,
      updatedByUid: caller.uid,
      updatedByName: profile.name || caller.email || 'Administrator',
    }, { merge: true });
    batch.set(db.collection('flightaware').doc('config'), {
      trackingEnabled: trackingEnabled !== false,
      dutyTrackerEnabled: dutyTrackerEnabled === true,
      dutyAlertEmails: emails,
      settingsUpdatedAt: now,
      settingsUpdatedByUid: caller.uid,
    }, { merge: true });

    // Keep every maintenance document and its subcollections. The role flag is
    // enough to hide a removed aircraft from fleet screens without erasing its
    // logs, squawks, MEL history, or scheduled legs.
    for (const tail of managed) {
      const meta = aircraft[tail] || {};
      batch.set(db.collection('maint-aircraft').doc(tail), {
        tail,
        active: true,
        fleetRole: 'managed',
        model: meta.displayName || '',
        displayName: meta.displayName || '',
        icaoType: meta.icaoType || '',
        serialNumber: meta.serialNumber || '',
        homeBase: meta.homeBase || '',
        fleetUpdatedAt: now,
      }, { merge: true });
    }
    for (const tail of removed) {
      batch.set(db.collection('maint-aircraft').doc(tail), {
        tail,
        active: false,
        fleetRole: 'scheduled-only',
        fleetUpdatedAt: now,
      }, { merge: true });
    }
    await batch.commit();

    console.log(
      `[admin-settings] uid=${caller.uid} managed=${managed.join(',') || '(empty)'}`
      + ` removed=${removed.join(',') || '(none)'}`,
    );
    res.status(200).json({
      ok: true,
      fleetTails: managed,
      aircraftByTail: aircraft,
      removed,
      trackingEnabled: trackingEnabled !== false,
      dutyTrackerEnabled: dutyTrackerEnabled === true,
      dutyAlertEmails: emails,
      updatedAt: now,
    });
  } catch (err) {
    console.error('[admin-settings]', err);
    res.status(500).json({ error: 'Could not save administrator settings' });
  }
}
