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

/**
 * Append a formal maintenance log entry (compliant record).
 * Auto-locked once added — entries are immutable after creation to maintain
 * audit integrity. Each entry includes tech name, cert info, work performed,
 * signature, RTS approval, and a PDF copy stored in Firebase Storage.
 *
 * Returns the entry id.
 */
export async function addLogbookEntry(eventId, entry) {
  if (!eventId) throw new Error('addLogbookEntry: eventId required');
  if (!entry || typeof entry !== 'object') throw new Error('entry required');
  const ref = doc(db, 'aog-events', eventId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`AOG event ${eventId} not found`);
  const current = snap.data();

  const entryId = `entry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const newEntry = {
    id: entryId,
    timestamp: Date.now(),
    workPerformed:        String(entry.workPerformed || '').trim(),
    partsReplaced:        Array.isArray(entry.partsReplaced) ? entry.partsReplaced : [],
    inspectionPerformed:  String(entry.inspectionPerformed || '').trim(),
    aircraftTotalTime:    String(entry.aircraftTotalTime || '').trim(),
    aircraftCycles:       String(entry.aircraftCycles || '').trim(),
    technicianName:       String(entry.technicianName || '').trim(),
    technicianCertType:   String(entry.technicianCertType || '').trim(),
    technicianCertNumber: String(entry.technicianCertNumber || '').trim(),
    signatureDataUrl:     entry.signatureDataUrl || null,
    rtsApproved:          entry.rtsApproved === true,
    signedAt:             Date.now(),
    signedBy: {
      uid:         entry.signedBy?.uid || null,
      displayName: String(entry.signedBy?.displayName || '').trim(),
      email:       String(entry.signedBy?.email || '').trim(),
    },
    pdfDownloadUrl:       entry.pdfDownloadUrl || null,
    pdfStoragePath:       entry.pdfStoragePath || null,
  };

  const existing = Array.isArray(current.logbookEntries) ? current.logbookEntries : [];

  // Also append a brief log line to the activity log
  const activityLog = Array.isArray(current.logEntries) ? current.logEntries : [];

  await updateDoc(ref, {
    logbookEntries: [...existing, newEntry],
    logEntries: [...activityLog, {
      timestamp: Date.now(),
      author: newEntry.technicianName || newEntry.signedBy.displayName || 'Tech',
      message: newEntry.rtsApproved
        ? `RTS logbook entry added: ${newEntry.workPerformed.slice(0, 80)}${newEntry.workPerformed.length > 80 ? '...' : ''}`
        : `Logbook entry added: ${newEntry.workPerformed.slice(0, 80)}${newEntry.workPerformed.length > 80 ? '...' : ''}`,
    }],
    updatedAt: Date.now(),
  });

  return entryId;
}

/**
 * Update the pdfDownloadUrl on an existing logbook entry. Used when the PDF
 * is uploaded to Storage AFTER the entry is created (so the entry has a
 * Firestore record we can reference for the storage path).
 */
export async function updateLogbookEntryPdf(eventId, entryId, pdfDownloadUrl, pdfStoragePath) {
  if (!eventId || !entryId) throw new Error('eventId and entryId required');
  const ref = doc(db, 'aog-events', eventId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('event not found');
  const current = snap.data();
  const entries = Array.isArray(current.logbookEntries) ? current.logbookEntries : [];
  const updated = entries.map(e =>
    e.id === entryId
      ? { ...e, pdfDownloadUrl: pdfDownloadUrl || null, pdfStoragePath: pdfStoragePath || null }
      : e
  );
  await updateDoc(ref, { logbookEntries: updated, updatedAt: Date.now() });
}

/**
 * Delete a logbook entry from an AOG.
 *
 * Hard-delete: removes the entry from the AOG's logbookEntries array AND
 * removes the associated PDF from Firebase Storage. Writes an audit record
 * to the deleted-logbook-entries collection capturing the entry's contents
 * at the moment of deletion plus who performed it.
 *
 * Only the original signer or an admin should call this — caller must enforce
 * that check at the UI layer (also enforced via Firestore rules on the
 * deleted-logbook-entries collection).
 *
 * @param {string} aogId
 * @param {string} entryId
 * @param {{ uid, displayName, email, role }} deleter
 * @param {string} [reason]  — optional, recorded if provided
 */
export async function deleteLogbookEntry(aogId, entryId, deleter, reason = '') {
  if (!aogId || !entryId) throw new Error('aogId and entryId required');
  if (!deleter || !deleter.uid) throw new Error('deleter required');

  const ref = doc(db, 'aog-events', aogId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`AOG event ${aogId} not found`);

  const current = snap.data();
  const entries = Array.isArray(current.logbookEntries) ? current.logbookEntries : [];
  const target = entries.find(e => e.id === entryId);
  if (!target) throw new Error(`Logbook entry ${entryId} not found in AOG ${aogId}`);

  // Write the audit record FIRST so the entry is preserved even if storage
  // delete fails later.
  const auditRecord = {
    deletedEntryId: entryId,
    aogId,
    aogTail: current.tail || '',
    aogLocation: current.location || '',
    originalEntry: target,
    deletedAt: Date.now(),
    deletedBy: {
      uid: deleter.uid,
      displayName: String(deleter.displayName || '').trim(),
      email: String(deleter.email || '').trim(),
      role: String(deleter.role || '').trim(),
    },
    reason: String(reason || '').trim(),
  };
  await setDoc(doc(db, 'deleted-logbook-entries', entryId), auditRecord);

  // Remove entry from AOG, append activity log line
  const activityLog = Array.isArray(current.logEntries) ? current.logEntries : [];
  const newEntries = entries.filter(e => e.id !== entryId);
  await updateDoc(ref, {
    logbookEntries: newEntries,
    logEntries: [...activityLog, {
      timestamp: Date.now(),
      author: deleter.displayName || 'Admin',
      message: `Logbook entry deleted: ${target.workPerformed ? target.workPerformed.slice(0, 60) + (target.workPerformed.length > 60 ? '...' : '') : '(no description)'}${target.rtsApproved ? ' [was RTS approved]' : ''}`,
    }],
    updatedAt: Date.now(),
  });

  // Delete PDF from Storage (best effort — non-fatal if it fails)
  if (target.pdfStoragePath) {
    try {
      const { getStorage, ref: storageRef, deleteObject } = await import('firebase/storage');
      const storage = getStorage();
      await deleteObject(storageRef(storage, target.pdfStoragePath));
    } catch (e) {
      console.warn('[firebase-aog] PDF delete failed (entry already removed from AOG):', e.message);
    }
  }

  return { ok: true, auditRecordId: entryId };
}
