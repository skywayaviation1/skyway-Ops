// Firebase AOG (Aircraft On Ground) module.
//
// Single collection in Firestore:
//   aog-events/{eventId} — full AOG record
//
// Record shape:
//   {
//     id, tail, location, fboName,
//     issueDescription,
//     status: 'active' | 'resolved',
//     reportedAt, reportedBy: { uid, displayName },
//     declaredEmailSent: boolean,
//     coordination: {
//       maintLead, technician, vendor, opsContact
//     },
//     diagnostics: {
//       pilotDiscrepancy, troubleshooting, oemRecommendation
//     },
//     parts: [{ partNumber, description, status, eta, shipMethod }],
//     shipTo: { fboName, address, attn },
//     personnel: {
//       techDeparture, techArrivalEta, transport
//     },
//     rtsEstimate, rtsEstimatePrevious,
//     currentStatus, openItems: [string], nextUpdateDue,
//     recipients: [string],   // email addresses for team updates
//     resolvedAt, resolvedBy: { uid, displayName },
//     logEntries: [{ timestamp, author, message }],
//     createdAt, updatedAt
//   }

import { db } from './firebase.js';
import {
  doc,
  setDoc,
  updateDoc,
  getDoc,
  deleteDoc,
  collection,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
} from 'firebase/firestore';

function genAogId() {
  return `aog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Subscribe to ALL AOG events. Returns unsubscribe.
 * onUpdate receives an array sorted by reportedAt desc.
 */
export function subscribeToAogEvents(onUpdate) {
  const q = query(collection(db, 'aog-events'), orderBy('reportedAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      onUpdate(events);
    },
    (err) => {
      console.error('[firebase-aog] subscribe error:', err);
      onUpdate([]);
    }
  );
}

/**
 * Create a new AOG event. Returns the new event's id.
 * `reporter` is { uid, displayName }.
 */
export async function declareAog({ tail, location, fboName, issueDescription, recipients, reporter }) {
  const id = genAogId();
  const now = Date.now();
  const record = {
    id,
    tail: String(tail || '').toUpperCase().trim(),
    location: String(location || '').toUpperCase().trim(),
    fboName: String(fboName || '').trim(),
    issueDescription: String(issueDescription || '').trim(),
    status: 'active',
    reportedAt: now,
    reportedBy: reporter || null,
    declaredEmailSent: false,
    coordination: {
      maintLead: '',
      technician: '',
      vendor: '',
      opsContact: '',
    },
    diagnostics: {
      pilotDiscrepancy: '',
      troubleshooting: '',
      oemRecommendation: '',
    },
    parts: [],
    shipTo: {
      fboName: String(fboName || '').trim(),
      address: '',
      attn: '',
    },
    personnel: {
      techDeparture: '',
      techArrivalEta: '',
      transport: '',
    },
    rtsEstimate: '',
    rtsEstimatePrevious: '',
    currentStatus: '',
    openItems: [],
    nextUpdateDue: '',
    recipients: Array.isArray(recipients) ? recipients.filter(Boolean) : [],
    resolvedAt: null,
    resolvedBy: null,
    logEntries: [
      {
        timestamp: now,
        author: reporter?.displayName || 'System',
        message: `AOG declared — ${String(tail || '').toUpperCase()} at ${String(location || '').toUpperCase()}`,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, 'aog-events', id), record);
  return id;
}

/**
 * Patch an existing AOG event. `patch` is a shallow merge object.
 * Automatically updates updatedAt and appends a log entry if provided.
 */
export async function updateAog(eventId, patch, logEntry = null) {
  if (!eventId) throw new Error('updateAog: eventId required');
  const ref = doc(db, 'aog-events', eventId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`AOG event ${eventId} not found`);
  const current = snap.data();
  const updated = {
    ...patch,
    updatedAt: Date.now(),
  };
  if (logEntry) {
    const log = Array.isArray(current.logEntries) ? current.logEntries : [];
    updated.logEntries = [...log, { timestamp: Date.now(), ...logEntry }];
  }
  await updateDoc(ref, updated);
}

/**
 * Mark an AOG event resolved (return to service).
 */
export async function resolveAog(eventId, resolver) {
  if (!eventId) throw new Error('resolveAog: eventId required');
  const ref = doc(db, 'aog-events', eventId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`AOG event ${eventId} not found`);
  const current = snap.data();
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  await updateDoc(ref, {
    status: 'resolved',
    resolvedAt: Date.now(),
    resolvedBy: resolver || null,
    updatedAt: Date.now(),
    logEntries: [...log, {
      timestamp: Date.now(),
      author: resolver?.displayName || 'System',
      message: 'Returned to service',
    }],
  });
}

/**
 * Append a log entry without other field updates.
 */
export async function appendAogLogEntry(eventId, author, message) {
  if (!eventId) throw new Error('appendAogLogEntry: eventId required');
  const ref = doc(db, 'aog-events', eventId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`AOG event ${eventId} not found`);
  const current = snap.data();
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  await updateDoc(ref, {
    logEntries: [...log, {
      timestamp: Date.now(),
      author: author || 'System',
      message: String(message || ''),
    }],
    updatedAt: Date.now(),
  });
}

/**
 * Delete an AOG event entirely. Admin-only use.
 */
export async function deleteAog(eventId) {
  if (!eventId) throw new Error('deleteAog: eventId required');
  await deleteDoc(doc(db, 'aog-events', eventId));
}
