// Firebase MX Projects module — scheduled/planned maintenance work.
//
// Distinct from AOG (emergency, unplanned). MX projects are inspections,
// service bulletins, AD compliance, planned squawks, etc.
//
// Single Firestore collection with embedded arrays:
//   mx-projects/{projectId}
//
// Project shape:
//   {
//     id, title, projectType ('inspection'|'sb'|'ad'|'squawk'|'other'),
//     tail, location ('hangar-a' etc), locationDetail,
//     status ('planned'|'in_work'|'pending_parts'|'inspection'|'complete'),
//     statusHistory: [{ status, at, by }],
//     leadUid, leadName,
//     assignedTechs: [{uid, name}],
//     description,
//     dueDate, startedAt, completedAt,
//     aircraftTotalTime, aircraftCycles,
//
//     tasks: [{
//       id, title, description,
//       status ('open'|'in_progress'|'blocked_parts'|'complete'),
//       assignedUid, assignedName,
//       completedAt, completedByUid, completedByName,
//       blockedByPartIds: []   // populated when a needed part is pending
//     }],
//
//     parts: [{
//       id, partNumber, description, quantity, estimatedCost,
//       status ('pending'|'approved'|'ordered'|'in_transit'|'delivered'|'denied'),
//       trackingNumber,                 // set when ordered
//       requestedByUid, requestedByName, requestedAt,
//       approvedByUid, approvedByName, approvedAt,
//       deniedReason,
//       relatedTaskId,                  // task this part is for (optional)
//       shipMethod, deliveredAt
//     }],
//
//     inspectionPdfUrl, inspectionPdfPath, inspectionPdfFilename,
//     inspectionPdfUploadedAt, inspectionPdfUploadedBy,
//
//     checklist: [{
//       id, item,
//       checked, checkedByUid, checkedByName, checkedAt
//     }],
//
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
  query,
  orderBy,
} from 'firebase/firestore';

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const PROJECT_STATUS_LABELS = {
  planned: 'Planned',
  in_work: 'In Work',
  pending_parts: 'Pending Parts',
  inspection: 'Inspection',
  complete: 'Complete',
};

export const PROJECT_TYPE_LABELS = {
  inspection: 'Inspection',
  sb: 'Service Bulletin',
  ad: 'AD Compliance',
  squawk: 'Squawk',
  other: 'Other',
};

/* ============================================================
   Subscriptions + reads
   ============================================================ */

export function subscribeToMxProjects(onUpdate) {
  const q = query(collection(db, 'mx-projects'), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const projects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      onUpdate(projects);
    },
    (err) => {
      console.error('[firebase-mx] subscribe error:', err);
      onUpdate([]);
    }
  );
}

/* ============================================================
   Project CRUD
   ============================================================ */

export async function createMxProject({
  title,
  projectType,
  tail,
  location,
  locationDetail,
  description,
  dueDate,
  leadUid,
  leadName,
  assignedTechs,
  aircraftTotalTime,
  aircraftCycles,
  creator,
}) {
  const id = genId('mx');
  const now = Date.now();
  const record = {
    id,
    title: String(title || '').trim(),
    projectType: String(projectType || 'other').trim(),
    tail: String(tail || '').toUpperCase().trim(),
    location: String(location || '').trim(),
    locationDetail: String(locationDetail || '').trim(),
    description: String(description || '').trim(),
    status: 'planned',
    statusHistory: [{ status: 'planned', at: now, byUid: creator?.uid || null, byName: creator?.displayName || null }],
    leadUid: leadUid || null,
    leadName: String(leadName || '').trim(),
    assignedTechs: Array.isArray(assignedTechs) ? assignedTechs : [],
    dueDate: String(dueDate || '').trim(),
    startedAt: null,
    completedAt: null,
    aircraftTotalTime: String(aircraftTotalTime || '').trim(),
    aircraftCycles: String(aircraftCycles || '').trim(),
    tasks: [],
    parts: [],
    inspectionPdfUrl: null,
    inspectionPdfPath: null,
    inspectionPdfFilename: null,
    inspectionPdfUploadedAt: null,
    inspectionPdfUploadedBy: null,
    checklist: [],
    logEntries: [{
      timestamp: now,
      author: creator?.displayName || 'System',
      message: `Project created — ${String(tail || '').toUpperCase()}${title ? ' · ' + title : ''}`,
    }],
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(doc(db, 'mx-projects', id), record);
  return id;
}

export async function updateMxProject(projectId, patch, logEntry = null) {
  if (!projectId) throw new Error('projectId required');
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error(`MX project ${projectId} not found`);
  const current = snap.data();
  const update = { ...patch, updatedAt: Date.now() };
  if (logEntry) {
    const log = Array.isArray(current.logEntries) ? current.logEntries : [];
    update.logEntries = [...log, { timestamp: Date.now(), ...logEntry }];
  }
  await updateDoc(ref, update);
}

export async function deleteMxProject(projectId) {
  await deleteDoc(doc(db, 'mx-projects', projectId));
}

/* ============================================================
   Status transitions
   ============================================================ */

/**
 * Compute the status that this project SHOULD be in given its tasks/parts.
 * Returns one of the PROJECT_STATUS keys.
 *
 * Logic:
 *   - If user manually marked complete, stay complete
 *   - If any task is blocked on a pending part, status = pending_parts
 *   - If all tasks are complete AND there's a checklist with at least one item, status = inspection
 *   - If all tasks AND all checklist items are complete, status = ready for complete (but don't auto-set complete — lead must approve)
 *   - If at least one task is in_progress or started, status = in_work
 *   - Else status = planned
 */
export function computeSuggestedStatus(project) {
  if (!project) return 'planned';
  if (project.status === 'complete') return 'complete';

  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  const parts = Array.isArray(project.parts) ? project.parts : [];
  const checklist = Array.isArray(project.checklist) ? project.checklist : [];

  const anyTaskBlockedOnParts = tasks.some(t =>
    t.status === 'blocked_parts' ||
    (Array.isArray(t.blockedByPartIds) && t.blockedByPartIds.length > 0 &&
      t.blockedByPartIds.some(pid => {
        const p = parts.find(pp => pp.id === pid);
        return p && ['pending', 'approved', 'ordered', 'in_transit'].includes(p.status);
      }))
  );
  if (anyTaskBlockedOnParts) return 'pending_parts';

  const allTasksDone = tasks.length > 0 && tasks.every(t => t.status === 'complete');
  const checklistStarted = checklist.length > 0 && checklist.some(c => c.checked);
  const allChecklistDone = checklist.length > 0 && checklist.every(c => c.checked);

  if (allTasksDone && checklist.length > 0 && !allChecklistDone) return 'inspection';
  if (checklistStarted && tasks.some(t => t.status !== 'complete')) return 'inspection';

  const anyInProgress = tasks.some(t => t.status === 'in_progress' || t.status === 'complete');
  if (anyInProgress) return 'in_work';

  return 'planned';
}

/**
 * Apply an auto-status update if the suggested status differs from current.
 * Returns true if a change was applied.
 */
export async function maybeApplyAutoStatus(projectId, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return false;
  const current = snap.data();
  if (current.status === 'complete') return false;

  const suggested = computeSuggestedStatus(current);
  if (suggested === current.status) return false;

  const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();

  const patch = {
    status: suggested,
    statusHistory: [...history, {
      status: suggested,
      at: now,
      byUid: actor?.uid || null,
      byName: 'System (auto)',
      reason: 'auto',
    }],
    logEntries: [...log, {
      timestamp: now,
      author: 'System',
      message: `Status auto-changed: ${PROJECT_STATUS_LABELS[current.status] || current.status} → ${PROJECT_STATUS_LABELS[suggested] || suggested}`,
    }],
    updatedAt: now,
  };

  if (suggested === 'in_work' && !current.startedAt) {
    patch.startedAt = now;
  }
  await updateDoc(ref, patch);
  return true;
}

/**
 * Manually set status (e.g. lead marks complete). Records in history.
 */
export async function setProjectStatus(projectId, newStatus, actor, reason = '') {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const history = Array.isArray(current.statusHistory) ? current.statusHistory : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();

  const patch = {
    status: newStatus,
    statusHistory: [...history, {
      status: newStatus,
      at: now,
      byUid: actor?.uid || null,
      byName: actor?.displayName || 'Unknown',
      reason,
    }],
    logEntries: [...log, {
      timestamp: now,
      author: actor?.displayName || 'System',
      message: `Status changed to ${PROJECT_STATUS_LABELS[newStatus] || newStatus}${reason ? ': ' + reason : ''}`,
    }],
    updatedAt: now,
  };
  if (newStatus === 'in_work' && !current.startedAt) patch.startedAt = now;
  if (newStatus === 'complete') patch.completedAt = now;
  await updateDoc(ref, patch);
}

/* ============================================================
   Task operations
   ============================================================ */

export async function addTask(projectId, { title, description, assignedUid, assignedName, relatedPartIds }, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  const task = {
    id: genId('task'),
    title: String(title || '').trim(),
    description: String(description || '').trim(),
    status: 'open',
    assignedUid: assignedUid || null,
    assignedName: String(assignedName || '').trim(),
    blockedByPartIds: Array.isArray(relatedPartIds) ? relatedPartIds : [],
    createdAt: now,
    completedAt: null,
    completedByUid: null,
    completedByName: null,
  };
  await updateDoc(ref, {
    tasks: [...tasks, task],
    logEntries: [...log, {
      timestamp: now,
      author: actor?.displayName || 'System',
      message: `Task added: ${task.title}${task.assignedName ? ' → ' + task.assignedName : ''}`,
    }],
    updatedAt: now,
  });
  return task.id;
}

export async function updateTask(projectId, taskId, patch, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const newTasks = tasks.map(t => t.id === taskId ? { ...t, ...patch } : t);
  await updateDoc(ref, { tasks: newTasks, updatedAt: Date.now() });
}

export async function completeTask(projectId, taskId, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error('task not found');
  const newTasks = tasks.map(t => t.id === taskId
    ? { ...t, status: 'complete', completedAt: now, completedByUid: actor?.uid, completedByName: actor?.displayName }
    : t
  );
  await updateDoc(ref, {
    tasks: newTasks,
    logEntries: [...log, {
      timestamp: now,
      author: actor?.displayName || 'Tech',
      message: `Task completed: ${task.title}`,
    }],
    updatedAt: now,
  });
}

export async function uncompleteTask(projectId, taskId, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const newTasks = tasks.map(t => t.id === taskId
    ? { ...t, status: t.assignedUid ? 'in_progress' : 'open', completedAt: null, completedByUid: null, completedByName: null }
    : t
  );
  await updateDoc(ref, { tasks: newTasks, updatedAt: Date.now() });
}

export async function deleteTask(projectId, taskId, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const task = tasks.find(t => t.id === taskId);
  await updateDoc(ref, {
    tasks: tasks.filter(t => t.id !== taskId),
    logEntries: [...log, {
      timestamp: Date.now(),
      author: actor?.displayName || 'System',
      message: `Task removed: ${task?.title || taskId}`,
    }],
    updatedAt: Date.now(),
  });
}

/* ============================================================
   Parts request operations
   ============================================================ */

export async function requestPart(projectId, { partNumber, description, quantity, estimatedCost, relatedTaskId }, requester) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const parts = Array.isArray(current.parts) ? current.parts : [];
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  const part = {
    id: genId('part'),
    partNumber: String(partNumber || '').trim(),
    description: String(description || '').trim(),
    quantity: Number(quantity) || 1,
    estimatedCost: estimatedCost === '' || estimatedCost == null ? null : Number(estimatedCost),
    status: 'pending',
    trackingNumber: '',
    requestedByUid: requester?.uid || null,
    requestedByName: requester?.displayName || 'Unknown',
    requestedAt: now,
    approvedByUid: null,
    approvedByName: null,
    approvedAt: null,
    deniedReason: '',
    relatedTaskId: relatedTaskId || null,
    shipMethod: '',
    deliveredAt: null,
  };
  let newTasks = tasks;
  if (relatedTaskId) {
    newTasks = tasks.map(t => t.id === relatedTaskId
      ? {
          ...t,
          status: 'blocked_parts',
          blockedByPartIds: Array.isArray(t.blockedByPartIds) ? [...t.blockedByPartIds, part.id] : [part.id],
        }
      : t
    );
  }
  await updateDoc(ref, {
    parts: [...parts, part],
    tasks: newTasks,
    logEntries: [...log, {
      timestamp: now,
      author: requester?.displayName || 'Tech',
      message: `Part requested: ${part.partNumber} (${part.description})${part.estimatedCost != null ? ' · $' + part.estimatedCost : ''}`,
    }],
    updatedAt: now,
  });
  return part.id;
}

export async function approvePart(projectId, partId, approver) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const parts = Array.isArray(current.parts) ? current.parts : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  const part = parts.find(p => p.id === partId);
  if (!part) throw new Error('part not found');
  const newParts = parts.map(p => p.id === partId
    ? { ...p, status: 'approved', approvedByUid: approver?.uid, approvedByName: approver?.displayName, approvedAt: now }
    : p
  );
  await updateDoc(ref, {
    parts: newParts,
    logEntries: [...log, {
      timestamp: now,
      author: approver?.displayName || 'Lead',
      message: `Part approved: ${part.partNumber}`,
    }],
    updatedAt: now,
  });
}

export async function denyPart(projectId, partId, approver, reason = '') {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const parts = Array.isArray(current.parts) ? current.parts : [];
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  const part = parts.find(p => p.id === partId);
  if (!part) throw new Error('part not found');
  const newParts = parts.map(p => p.id === partId
    ? { ...p, status: 'denied', approvedByUid: approver?.uid, approvedByName: approver?.displayName, approvedAt: now, deniedReason: String(reason || '') }
    : p
  );
  // Unblock any tasks that were blocked on this part
  const newTasks = tasks.map(t => {
    if (!Array.isArray(t.blockedByPartIds) || !t.blockedByPartIds.includes(partId)) return t;
    const remaining = t.blockedByPartIds.filter(pid => pid !== partId);
    return {
      ...t,
      blockedByPartIds: remaining,
      status: remaining.length === 0 && t.status === 'blocked_parts' ? (t.assignedUid ? 'in_progress' : 'open') : t.status,
    };
  });
  await updateDoc(ref, {
    parts: newParts,
    tasks: newTasks,
    logEntries: [...log, {
      timestamp: now,
      author: approver?.displayName || 'Lead',
      message: `Part denied: ${part.partNumber}${reason ? ' (' + reason + ')' : ''}`,
    }],
    updatedAt: now,
  });
}

export async function updatePartStatus(projectId, partId, newStatus, extras = {}, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const parts = Array.isArray(current.parts) ? current.parts : [];
  const tasks = Array.isArray(current.tasks) ? current.tasks : [];
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  const part = parts.find(p => p.id === partId);
  if (!part) throw new Error('part not found');
  const updated = { ...part, status: newStatus, ...extras };
  if (newStatus === 'delivered') updated.deliveredAt = now;
  const newParts = parts.map(p => p.id === partId ? updated : p);

  // If part is now delivered, unblock any task that was blocked on it
  let newTasks = tasks;
  if (newStatus === 'delivered') {
    newTasks = tasks.map(t => {
      if (!Array.isArray(t.blockedByPartIds) || !t.blockedByPartIds.includes(partId)) return t;
      const remaining = t.blockedByPartIds.filter(pid => pid !== partId);
      return {
        ...t,
        blockedByPartIds: remaining,
        status: remaining.length === 0 && t.status === 'blocked_parts' ? (t.assignedUid ? 'in_progress' : 'open') : t.status,
      };
    });
  }

  await updateDoc(ref, {
    parts: newParts,
    tasks: newTasks,
    logEntries: [...log, {
      timestamp: now,
      author: actor?.displayName || 'System',
      message: `Part ${part.partNumber} → ${newStatus}`,
    }],
    updatedAt: now,
  });
}

/* ============================================================
   Inspection criteria operations
   ============================================================ */

export async function setInspectionPdf(projectId, { url, path, filename }, uploader) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const log = Array.isArray(current.logEntries) ? current.logEntries : [];
  const now = Date.now();
  await updateDoc(ref, {
    inspectionPdfUrl: url || null,
    inspectionPdfPath: path || null,
    inspectionPdfFilename: filename || null,
    inspectionPdfUploadedAt: now,
    inspectionPdfUploadedBy: uploader ? {
      uid: uploader.uid,
      displayName: uploader.displayName,
    } : null,
    logEntries: [...log, {
      timestamp: now,
      author: uploader?.displayName || 'System',
      message: `Inspection PDF uploaded: ${filename || '(unnamed)'}`,
    }],
    updatedAt: now,
  });
}

export async function addChecklistItem(projectId, itemText, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const checklist = Array.isArray(current.checklist) ? current.checklist : [];
  const item = {
    id: genId('chk'),
    item: String(itemText || '').trim(),
    checked: false,
    checkedByUid: null,
    checkedByName: null,
    checkedAt: null,
  };
  await updateDoc(ref, {
    checklist: [...checklist, item],
    updatedAt: Date.now(),
  });
  return item.id;
}

export async function toggleChecklistItem(projectId, itemId, actor) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const checklist = Array.isArray(current.checklist) ? current.checklist : [];
  const item = checklist.find(c => c.id === itemId);
  if (!item) throw new Error('item not found');
  const now = Date.now();
  const newChecklist = checklist.map(c => c.id === itemId
    ? {
        ...c,
        checked: !c.checked,
        checkedByUid: !c.checked ? actor?.uid : null,
        checkedByName: !c.checked ? actor?.displayName : null,
        checkedAt: !c.checked ? now : null,
      }
    : c
  );
  await updateDoc(ref, { checklist: newChecklist, updatedAt: now });
}

export async function deleteChecklistItem(projectId, itemId) {
  const ref = doc(db, 'mx-projects', projectId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('not found');
  const current = snap.data();
  const checklist = Array.isArray(current.checklist) ? current.checklist : [];
  await updateDoc(ref, {
    checklist: checklist.filter(c => c.id !== itemId),
    updatedAt: Date.now(),
  });
}
