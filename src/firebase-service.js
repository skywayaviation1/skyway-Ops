// Firebase SERVICE REQUEST module.
//
// Mirror of firebase-aog.js for routine / scheduled maintenance service
// requests (NOT aircraft-on-ground emergencies). Completely isolated from
// AOG: separate collection, separate token secret, separate API endpoints.
//
// Single collection in Firestore:
//   service-requests/{srId} — full service-request record
//
// Record shape:
//   {
//     id, tail, location, fboName,
//     serviceDescription,                 // what work is requested / squawks
//     serviceType,                        // e.g. 'Scheduled', 'Inspection', 'Discrepancy'
//     requestedDate,                      // free-text desired service date/window
//     status: 'open' | 'completed',
//     requestedAt, requestedBy: { uid, displayName },
//     requestEmailSent: boolean,
//     coordination: { maintLead, technician, vendor, opsContact },
//     diagnostics: { pilotDiscrepancy, troubleshooting, oemRecommendation },
//     parts: [{ partNumber, description, status, eta, shipMethod }],
//     shipTo: { fboName, address, attn },
//     personnel: { techDeparture, techArrivalEta, transport },
//     rtsEstimate, rtsEstimatePrevious,
//     currentStatus, openItems: [string], nextUpdateDue,
//     recipients: [string],
//     completedAt, completedBy: { uid, displayName },
//     logEntries: [{ timestamp, author, message }],
//     logbookEntries: [...], referenceDocs: [...],
//     skywayChatReplies: [...],           // mirrors AOG vendor chat
//     linkTokenIssuedAt, linkRevoked, externalLogbookEnabled,
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
  query,
  orderBy,
} from 'firebase/firestore';

function genServiceId() {
  return `sr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Subscribe to ALL service requests. Returns unsubscribe.
 * onUpdate receives an array sorted by requestedAt desc.
 */
export function subscribeToServiceRequests(onUpdate) {
  const q = query(collection(db, 'service-requests'), orderBy('requestedAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      onUpdate(items);
    },
    (err) => {
      console.error('[firebase-service] subscribe error:', err);
      onUpdate([]);
    }
  );
}

/**
 * Create a new service request. Returns the new request's id.
 * `requester` is { uid, displayName }.
 */
export async function createServiceRequest({ tail, location, fboName, serviceDescription, serviceType, requestedDate, recipients, requester }) {
  const id = genServiceId();
  const now = Date.now();
  const record = {
    id,
    tail: String(tail || '').toUpperCase().trim(),
    location: String(location || '').toUpperCase().trim(),
    fboName: String(fboName || '').trim(),
    serviceDescription: String(serviceDescription || '').trim(),
    serviceType: String(serviceType || 'Scheduled').trim(),
    requestedDate: String(requestedDate || '').trim(),
    status: 'open',
    requestedAt: now,
    requestedBy: requester || null,
    requestEmailSent: false,
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
    completedAt: null,
    completedBy: null,
    logEntries: [
      {
        timestamp: now,
        author: requester?.displayName || 'System',
        message: `Service requested — ${String(tail || '').toUpperCase()} at ${String(location || '').toUpperCase()}`,
      },
    ],
    logbookEntries: [],
    referenceDocs: [],
    skywayChatReplies: [],
    linkTokenIssuedAt: null,
    linkRevoked: false,
    externalLogbookEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, 'service-requests', id), record);
  return id;
}

/**
 * Patch an existing service request. `patch` is a shallow merge object.
 * Auto-updates updatedAt and appends a log entry if provided.
 */
export async function updateServiceRequest(srId, patch, logEntry = null) {
  if (!srId) throw new Error('updateServiceRequest: srId required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();
  const updated = { ...patch, updatedAt: Date.now() };
  if (logEntry) {
    const log = Array.isArray(current.logEntries) ? current.logEntries : [];
    updated.logEntries = [...log, { timestamp: Date.now(), ...logEntry }];
  }
  await updateDoc(ref, updated);
}

/**
 * Mark a service request completed.
 */
export async function completeServiceRequest(srId, completer) {
  if (!srId) throw new Error('completeServiceRequest: srId required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  await updateDoc(ref, {
    status: 'completed',
    completedAt: Date.now(),
    completedBy: completer || null,
    updatedAt: Date.now(),
    logEntries: [...log, {
      timestamp: Date.now(),
      author: completer?.displayName || 'System',
      message: 'Service completed',
    }],
  });
}

/**
 * Append a log entry without other field updates.
 */
export async function appendServiceLogEntry(srId, author, message) {
  if (!srId) throw new Error('appendServiceLogEntry: srId required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
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
 * Delete a service request entirely. Admin-only use.
 */
export async function deleteServiceRequest(srId) {
  if (!srId) throw new Error('deleteServiceRequest: srId required');
  await deleteDoc(doc(db, 'service-requests', srId));
}

/**
 * Append a formal maintenance logbook entry (compliant record).
 * Immutable after creation. Returns the entry id.
 */
export async function addLogbookEntry(srId, entry) {
  if (!srId) throw new Error('addLogbookEntry: srId required');
  if (!entry || typeof entry !== 'object') throw new Error('entry required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
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
 * Update the pdfDownloadUrl on an existing logbook entry (PDF uploaded after
 * the entry record is created).
 */
export async function updateLogbookEntryPdf(srId, entryId, pdfDownloadUrl, pdfStoragePath) {
  if (!srId || !entryId) throw new Error('srId and entryId required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('service request not found');
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
 * Delete a logbook entry. Audit record written to
 * deleted-logbook-entries collection (shared with AOG audit collection).
 */
export async function deleteLogbookEntry(srId, entryId, deleter, reason = '') {
  if (!srId || !entryId) throw new Error('srId and entryId required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();
  const entries = Array.isArray(current.logbookEntries) ? current.logbookEntries : [];
  const target = entries.find(e => e.id === entryId);
  if (!target) throw new Error(`Logbook entry ${entryId} not found in ${srId}`);

  const auditId = `del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await setDoc(doc(db, 'deleted-logbook-entries', auditId), {
    id: auditId,
    source: 'service-request',
    sourceId: srId,
    entry: target,
    deletedAt: Date.now(),
    deletedBy: {
      uid: deleter?.uid || null,
      displayName: String(deleter?.displayName || '').trim() || 'Unknown',
      email: String(deleter?.email || '').trim(),
      role: String(deleter?.role || '').trim(),
    },
    reason: String(reason || '').trim(),
  });

  const activityLog = Array.isArray(current.logEntries) ? current.logEntries : [];
  await updateDoc(ref, {
    logbookEntries: entries.filter(e => e.id !== entryId),
    logEntries: [...activityLog, {
      timestamp: Date.now(),
      author: deleter?.displayName || 'Unknown',
      message: `Logbook entry deleted${reason ? `: ${reason}` : ''}`,
    }],
    updatedAt: Date.now(),
  });

  if (target.pdfStoragePath) {
    try {
      const { getStorage, ref: storageRef, deleteObject } = await import('firebase/storage');
      await deleteObject(storageRef(getStorage(), target.pdfStoragePath));
    } catch (e) {
      console.warn('[firebase-service] logbook PDF delete failed:', e.message);
    }
  }

  return { ok: true };
}

export async function addReferenceDoc(srId, docMeta, uploader) {
  if (!srId) throw new Error('addReferenceDoc: srId required');
  if (!docMeta || !docMeta.url || !docMeta.storagePath) {
    throw new Error('addReferenceDoc: docMeta.url and storagePath required');
  }
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();

  const refId = `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const newDoc = {
    id: refId,
    filename: String(docMeta.filename || 'reference.pdf'),
    url: docMeta.url,
    storagePath: docMeta.storagePath,
    sizeBytes: docMeta.sizeBytes || 0,
    uploadedAt: Date.now(),
    uploadedBy: {
      uid: uploader?.uid || null,
      displayName: String(uploader?.displayName || '').trim() || 'Unknown',
    },
    emailedAt: null,
    emailedTo: [],
  };

  const existing = Array.isArray(current.referenceDocs) ? current.referenceDocs : [];
  const activityLog = Array.isArray(current.logEntries) ? current.logEntries : [];

  await updateDoc(ref, {
    referenceDocs: [...existing, newDoc],
    logEntries: [...activityLog, {
      timestamp: Date.now(),
      author: newDoc.uploadedBy.displayName,
      message: `Reference uploaded: ${newDoc.filename}`,
    }],
    updatedAt: Date.now(),
  });

  return refId;
}

export async function removeReferenceDoc(srId, refId, remover) {
  if (!srId || !refId) throw new Error('srId and refId required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();
  const existing = Array.isArray(current.referenceDocs) ? current.referenceDocs : [];
  const target = existing.find(d => d.id === refId);
  if (!target) throw new Error(`Reference doc ${refId} not found`);

  const activityLog = Array.isArray(current.logEntries) ? current.logEntries : [];
  await updateDoc(ref, {
    referenceDocs: existing.filter(d => d.id !== refId),
    logEntries: [...activityLog, {
      timestamp: Date.now(),
      author: remover?.displayName || 'Unknown',
      message: `Reference removed: ${target.filename}`,
    }],
    updatedAt: Date.now(),
  });

  if (target.storagePath) {
    try {
      const { getStorage, ref: storageRef, deleteObject } = await import('firebase/storage');
      await deleteObject(storageRef(getStorage(), target.storagePath));
    } catch (e) {
      console.warn('[firebase-service] reference PDF delete failed:', e.message);
    }
  }

  return { ok: true };
}

export async function markReferenceEmailed(srId, refIds, sentTo, sender) {
  if (!srId) throw new Error('markReferenceEmailed: srId required');
  const ids = Array.isArray(refIds) ? refIds : [refIds];
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();
  const existing = Array.isArray(current.referenceDocs) ? current.referenceDocs : [];
  const toList = Array.isArray(sentTo) ? sentTo.filter(Boolean) : [];

  const updated = existing.map(d =>
    ids.includes(d.id)
      ? { ...d, emailedAt: Date.now(), emailedTo: toList }
      : d
  );
  const activityLog = Array.isArray(current.logEntries) ? current.logEntries : [];
  await updateDoc(ref, {
    referenceDocs: updated,
    logEntries: [...activityLog, {
      timestamp: Date.now(),
      author: sender?.displayName || 'System',
      message: `References emailed to ${toList.join(', ') || 'vendor'}`,
    }],
    updatedAt: Date.now(),
  });
}

/**
 * Post a Skyway-side chat reply visible to the external vendor portal.
 * Mirrors AOG postSkywayChatReply.
 */
export async function postSkywayChatReply(srId, message, sender) {
  if (!srId) throw new Error('postSkywayChatReply: srId required');
  const text = String(message || '').trim();
  if (!text) throw new Error('message required');
  const ref = doc(db, 'service-requests', srId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`Service request ${srId} not found`);
  const current = snap.data();
  const replies = Array.isArray(current.skywayChatReplies) ? current.skywayChatReplies : [];
  await updateDoc(ref, {
    skywayChatReplies: [...replies, {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      author: sender?.displayName || 'Skyway',
      authorUid: sender?.uid || null,
      message: text,
      from: 'skyway',
    }],
    updatedAt: Date.now(),
  });
}
