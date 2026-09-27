// Shared loader for broker pilot reports.
// Reads logbooks, currency, certificate/medical documents, duty flight time,
// and the operator's saved minimums. Callers must pass the result through
// buildBrokerCrewReports / brokerPilotReport before it leaves the server.

import { brand } from '../src/brand.js';
import {
  buildBrokerCrewReports,
  brokerPilotReport,
  evaluatePilot,
  matchCrewUser,
  summarizeDutyFlightHours,
} from '../src/pilot-safety.js';

async function readDoc(db, collectionName, id) {
  const snap = await db.collection(collectionName).doc(id).get();
  if (!snap.exists) return null;
  return { uid: snap.id, ...snap.data() };
}

async function dutyHoursFor(db, uid, todayMs) {
  try {
    const snap = await db.collection('duty-periods-v2').where('pilotUid', '==', uid).get();
    const periods = snap.docs.map((entry) => entry.data());
    return summarizeDutyFlightHours(periods, uid, todayMs);
  } catch (err) {
    console.warn('[pilot-report] duty lookup failed:', err?.message || err);
    return null;
  }
}

async function docsFor(db, uid) {
  try {
    const snap = await db.collection('pilot-docs').where('uid', '==', uid).get();
    return snap.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
  } catch (err) {
    console.warn('[pilot-report] pilot-docs lookup failed:', err?.message || err);
    return [];
  }
}

export async function loadSafetyContext(db) {
  let standards = null;
  let users = [];
  try {
    const standardsSnap = await db.collection('app-config').doc('pilot-safety').get();
    standards = standardsSnap.exists ? standardsSnap.data() : null;
  } catch (err) {
    console.warn('[pilot-report] standards lookup failed:', err?.message || err);
  }
  try {
    const usersSnap = await db.collection('users').get();
    users = usersSnap.docs.map((entry) => {
      const data = entry.data() || {};
      return {
        uid: entry.id,
        name: data.name || data.displayName || '',
        role: data.role || '',
      };
    });
  } catch (err) {
    console.warn('[pilot-report] users lookup failed:', err?.message || err);
  }
  return { standards, users };
}

export async function loadPilotInputs(db, uid, todayMs = Date.now()) {
  const [logbook, currencyDoc, pilotDocs, dutyHours] = await Promise.all([
    readDoc(db, 'pilot-logbooks', uid).catch(() => null),
    readDoc(db, 'pilot-currencies', uid).catch(() => null),
    docsFor(db, uid),
    dutyHoursFor(db, uid, todayMs),
  ]);
  return { logbook, currencyDoc, pilotDocs, dutyHours };
}

export function operatorIdentity() {
  const current = brand();
  return { name: current.name, legalName: current.legalName };
}

export async function reportsForPilots(db, pilots, { role } = {}) {
  const todayMs = Date.now();
  const generatedAt = new Date(todayMs).toISOString();
  const { standards } = await loadSafetyContext(db);
  const operator = operatorIdentity();
  const reports = [];
  for (const pilot of pilots) {
    if (!pilot?.uid) continue;
    const inputs = await loadPilotInputs(db, pilot.uid, todayMs);
    const evaluation = evaluatePilot({
      pilot,
      ...inputs,
      standards,
      role: role || null,
      todayMs,
    });
    evaluation.pilotName = pilot.name || evaluation.pilotName;
    reports.push(brokerPilotReport(evaluation, {
      operatorName: operator.name,
      operatorLegalName: operator.legalName,
      generatedAt,
    }));
  }
  return reports;
}

export async function crewReportsForTrip(db, trip) {
  const todayMs = Date.now();
  const generatedAt = new Date(todayMs).toISOString();
  const { standards, users } = await loadSafetyContext(db);
  const legs = Array.isArray(trip?.legs) ? trip.legs : [];
  const matchedByUid = new Map();
  for (const leg of legs) {
    for (const name of [leg?.pic, leg?.sic]) {
      const user = matchCrewUser(name, users);
      if (user?.uid) matchedByUid.set(user.uid, user);
    }
  }
  const matched = [...matchedByUid.values()];
  const logbooksByUid = {};
  const currenciesByUid = {};
  const pilotDocsByUid = {};
  const dutyHoursByUid = {};
  await Promise.all(matched.map(async (user) => {
    const inputs = await loadPilotInputs(db, user.uid, todayMs);
    if (inputs.logbook) logbooksByUid[user.uid] = inputs.logbook;
    if (inputs.currencyDoc) currenciesByUid[user.uid] = inputs.currencyDoc;
    pilotDocsByUid[user.uid] = inputs.pilotDocs;
    dutyHoursByUid[user.uid] = inputs.dutyHours;
  }));
  return buildBrokerCrewReports({
    legs,
    aircraftType: trip?.aircraftType || null,
    aircraft: {
      registration: trip?.tail || '',
      type: trip?.aircraftType || '',
      serial: trip?.serialNumber || trip?.serial || '',
      year: trip?.year || '',
      seats: trip?.seats ?? '',
      insuranceExpiry: trip?.insuranceExpiry || '',
    },
    users,
    logbooksByUid,
    currenciesByUid,
    pilotDocsByUid,
    dutyHoursByUid,
    standards,
    operator: operatorIdentity(),
    generatedAt,
    todayMs,
  });
}
