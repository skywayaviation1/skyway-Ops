// Firebase helpers for Malfunction/Incident Reports.
//
// 14 CFR § 135.65 requires operators to keep records of mechanical
// irregularities. This module stores reports as Firestore documents in the
// `reports` collection, doc ID = auto-generated timestamp+tail.
//
// Document shape:
//   {
//     id, type: 'malfunction',
//     date,                      // YYYY-MM-DD
//     tail,                      // N123AB
//     pic, sic,                  // names
//     flightMode,                // free text (e.g., "Cruise", "Climb")
//     flightConditionIMC,        // bool: true=IMC, false=VMC
//     flightConditionDay,        // bool: true=Day, false=Night
//     departureId,
//     destinationId,
//     diversion,                 // bool
//     divertedTo,                // ICAO/IATA if diverted
//     emergencyDeclared,         // bool
//     affectedSystem,
//     cautionWarningLight,
//     textOfEvent,               // long-form description
//     submittedByRole,           // 'PIC' | 'SIC'
//     certificateNumber,
//     submittedAt,               // server timestamp
//     submittedByUid,
//     submittedByName,
//     submittedByEmail,
//     pdfEmailedTo: [...],       // array of recipient emails
//     emailId,                   // Resend message id (if successful)
//   }

import { db } from './firebase.js';
import {
  doc, setDoc, getDoc, deleteDoc, collection, query, orderBy, onSnapshot,
} from 'firebase/firestore';

export function newReportId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `rpt-${ts}-${rand}`;
}

export async function saveReport(report) {
  if (!report.id) throw new Error('Report must have an id');
  const safeId = String(report.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await setDoc(
    doc(db, 'reports', safeId),
    { ...report, updatedAt: Date.now(), createdAt: report.createdAt || Date.now() },
    { merge: true }
  );
}

export async function fetchReport(id) {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const snap = await getDoc(doc(db, 'reports', safeId));
  return snap.exists() ? { ...snap.data(), id: snap.id } : null;
}

export async function deleteReport(id) {
  if (!id) throw new Error('Missing report id');
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await deleteDoc(doc(db, 'reports', safeId));
}

export function subscribeToAllReports(onUpdate) {
  const q = query(collection(db, 'reports'), orderBy('submittedAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      onUpdate(list);
    },
    (err) => {
      console.error('[reports] subscribe error:', err);
      onUpdate([]);
    }
  );
}
