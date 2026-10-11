// Shift handoff model for the operations control log (`ops-shift-log`
// in the named Firestore database `appusers`).
//
// States: this log has one persisted state, `submitted`. There is no draft
// collection and no save-for-later path. A note exists only after an
// operations or admin user submits it, which is what "Add to shift log"
// has always done. Documents written before `status` was stored are
// treated as submitted when they have a created or submitted time and no
// other status. Any explicit status other than `submitted` — including
// `draft` — cannot be edited or deleted.
//
// Retention: a note is older than 7 days when its submitted time, or its
// created time when it was never given a submitted time, is strictly
// earlier than now minus 7 days. The home screen hides those notes and a
// daily cron deletes them. Editing a note does not move this timestamp.

export const HANDOFF_COLLECTION = 'ops-shift-log';
export const HANDOFF_DATABASE_ID = 'appusers';
export const SUBMITTED_STATUS = 'submitted';
export const HANDOFF_RETENTION_DAYS = 7;
export const HANDOFF_RETENTION_MS = HANDOFF_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const HANDOFF_TEXT_LIMIT = 2000;
export const HANDOFF_CATEGORIES = ['handoff', 'risk', 'update', 'decision'];
export const HANDOFF_DELETE_BATCH = 400;

export function handoffTimestamp(note) {
  const submitted = Number(note?.submittedAt);
  if (Number.isFinite(submitted) && submitted > 0) return submitted;
  const created = Number(note?.createdAt);
  if (Number.isFinite(created) && created > 0) return created;
  return null;
}

export function handoffCutoff(now = Date.now()) {
  return now - HANDOFF_RETENTION_MS;
}

/** True when the note is strictly older than the 7-day retention window. */
export function isExpiredHandoff(note, now = Date.now()) {
  const ts = handoffTimestamp(note);
  if (ts == null) return false;
  return ts < handoffCutoff(now);
}

/**
 * Submitted means the note was committed to the log. Legacy notes with a
 * timestamp and no status are submitted. Drafts and any other status are not.
 */
export function isSubmittedHandoff(note) {
  if (!note || typeof note !== 'object') return false;
  const status = note.status;
  if (status == null || status === '') return handoffTimestamp(note) != null;
  return status === SUBMITTED_STATUS;
}

export function handoffMutationBlock(note) {
  if (!note) return { status: 404, error: 'Handoff not found' };
  if (!isSubmittedHandoff(note)) {
    return { status: 409, error: 'Only submitted handoffs can be edited or deleted' };
  }
  return null;
}

export function classifyHandoffs(notes, now = Date.now()) {
  const visible = [];
  const expired = [];
  const undated = [];
  for (const note of notes || []) {
    const ts = handoffTimestamp(note);
    if (ts == null) undated.push(note);
    else if (isExpiredHandoff(note, now)) expired.push(note);
    else visible.push(note);
  }
  return { visible, expired, undated };
}

export function visibleHandoffs(notes, now = Date.now()) {
  return classifyHandoffs(notes, now).visible;
}

export function planHandoffCleanup(notes, now = Date.now()) {
  const { visible, expired, undated } = classifyHandoffs(notes, now);
  return {
    scanned: (notes || []).length,
    eligible: expired.length,
    skippedUndated: undated.length,
    retained: visible.length,
    deleteIds: expired.map((note) => note.id).filter(Boolean),
  };
}

export function normalizeCategory(value) {
  return HANDOFF_CATEGORIES.includes(value) ? value : 'update';
}

export function normalizeHandoffText(value) {
  const text = String(value || '').trim().slice(0, HANDOFF_TEXT_LIMIT);
  if (!text) {
    const err = new Error('Shift note required');
    err.status = 400;
    throw err;
  }
  return text;
}

export function normalizeHandoffId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    const err = new Error('Handoff id required');
    err.status = 400;
    throw err;
  }
  return id;
}

export function buildSubmittedHandoff({ text, category, pinned, author, now = Date.now() }) {
  return {
    text: normalizeHandoffText(text),
    category: normalizeCategory(category),
    pinned: pinned === true,
    status: SUBMITTED_STATUS,
    authorUid: author?.uid || null,
    authorName: author?.name || 'Operations',
    authorRole: author?.role || null,
    createdAt: now,
    submittedAt: now,
  };
}

/** Edit patch. Does not move createdAt, submittedAt, status, or authorship. */
export function buildHandoffEdit(note, { text, category, pinned, editor, now = Date.now() }) {
  const block = handoffMutationBlock(note);
  if (block) {
    const err = new Error(block.error);
    err.status = block.status;
    throw err;
  }
  return {
    text: normalizeHandoffText(text),
    category: normalizeCategory(category),
    pinned: pinned === true,
    updatedAt: now,
    updatedByUid: editor?.uid || null,
    updatedByName: editor?.name || 'Operations',
  };
}

export function chunkIds(ids, size = HANDOFF_DELETE_BATCH) {
  const unique = [];
  const seen = new Set();
  for (const id of ids || []) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const chunks = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

export async function runShiftHandoffCleanup({
  listDocs,
  deleteDocs,
  now = Date.now(),
  dryRun = false,
  log = console.log,
}) {
  const notes = await listDocs();
  const plan = planHandoffCleanup(notes, now);
  let deleted = 0;
  if (!dryRun && plan.deleteIds.length > 0) {
    deleted = await deleteDocs(plan.deleteIds);
  }
  const summary = {
    ok: true,
    dryRun: Boolean(dryRun),
    scanned: plan.scanned,
    eligible: plan.eligible,
    deleted,
    skippedUndated: plan.skippedUndated,
    retained: plan.retained,
    retentionDays: HANDOFF_RETENTION_DAYS,
  };
  log(
    `[shift-handoff-cleanup] dryRun=${summary.dryRun} scanned=${summary.scanned} eligible=${summary.eligible} deleted=${summary.deleted} skippedUndated=${summary.skippedUndated}`,
  );
  return summary;
}
