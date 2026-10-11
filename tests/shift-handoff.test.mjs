import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  addShiftNote,
  deleteShiftNote,
  listShiftNotes,
  updateShiftNote,
} from '../api/ops-control-action.js';
import {
  cleanupDryRun,
  createShiftHandoffCleanupHandler,
  cronRequestAuthorized,
  deleteHandoffDocs,
} from '../api/shift-handoff-cleanup.js';
import {
  HANDOFF_RETENTION_MS,
  buildHandoffEdit,
  buildSubmittedHandoff,
  chunkIds,
  classifyHandoffs,
  handoffTimestamp,
  isExpiredHandoff,
  isSubmittedHandoff,
  planHandoffCleanup,
  runShiftHandoffCleanup,
  visibleHandoffs,
} from '../src/shift-handoff.js';

const root = path.resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-11T09:15:00Z');
const DAY = 24 * 60 * 60 * 1000;

function note(overrides = {}) {
  return {
    id: 'note-1',
    text: 'Hold the TEB departure',
    category: 'handoff',
    pinned: false,
    status: 'submitted',
    authorUid: 'author',
    authorName: 'Jordan Vance',
    authorRole: 'ops',
    createdAt: NOW - 2 * DAY,
    submittedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

function createFakeDb(initial = []) {
  const docs = new Map(initial.map((doc) => [doc.id, { ...doc }]));
  let seq = 0;
  function collection() {
    const query = { limit: Infinity };
    return {
      doc(id) {
        const docId = id || `auto-${++seq}`;
        return {
          id: docId,
          async get() {
            const data = docs.get(docId);
            return {
              exists: data != null,
              data: () => (data ? { ...data } : undefined),
            };
          },
          async set(payload, options) {
            if (options?.merge && docs.has(docId)) docs.set(docId, { ...docs.get(docId), ...payload });
            else docs.set(docId, { ...payload });
          },
          async delete() {
            docs.delete(docId);
          },
        };
      },
      orderBy() { return this; },
      limit(count) { query.limit = count; return this; },
      async get() {
        const list = [...docs.entries()]
          .map(([id, data]) => ({ id, data: { ...data } }))
          .sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0))
          .slice(0, query.limit);
        return {
          empty: list.length === 0,
          size: list.length,
          docs: list.map((entry) => ({
            id: entry.id,
            data: () => ({ ...entry.data }),
          })),
        };
      },
    };
  }
  return {
    collection,
    batch() {
      const ids = [];
      return {
        delete(ref) { ids.push(ref.id); },
        async commit() { ids.forEach((id) => docs.delete(id)); },
      };
    },
    dump() {
      return [...docs.entries()].map(([id, data]) => ({ id, ...data }));
    },
  };
}

function caller(db, role = 'ops', uid = 'ops-2') {
  return { db, uid, name: 'Avery Chen', role };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('submitted handoffs are the only editable state', () => {
  assert.equal(isSubmittedHandoff(note()), true);
  assert.equal(isSubmittedHandoff(note({ status: undefined })), true);
  assert.equal(isSubmittedHandoff(note({ status: '' })), true);
  assert.equal(isSubmittedHandoff(note({ status: 'draft' })), false);
  assert.equal(isSubmittedHandoff(note({ status: 'draft', submittedAt: null, createdAt: NOW })), false);
  assert.equal(isSubmittedHandoff({ text: 'no time' }), false);
  assert.equal(isSubmittedHandoff(null), false);
});

test('retention uses submitted time, then created time, and ignores undated notes', () => {
  assert.equal(handoffTimestamp(note({ submittedAt: NOW - DAY, createdAt: NOW - 10 * DAY })), NOW - DAY);
  assert.equal(isExpiredHandoff(note({ submittedAt: NOW - 8 * DAY, createdAt: NOW - 8 * DAY }), NOW), true);
  assert.equal(isExpiredHandoff(note({ submittedAt: NOW - HANDOFF_RETENTION_MS, createdAt: NOW - 30 * DAY }), NOW), false);
  assert.equal(isExpiredHandoff(note({ submittedAt: NOW - HANDOFF_RETENTION_MS - 1 }), NOW), true);
  assert.equal(isExpiredHandoff(note({ submittedAt: null, createdAt: null }), NOW), false);
  assert.equal(isExpiredHandoff(note({
    submittedAt: NOW - DAY,
    createdAt: NOW - 20 * DAY,
  }), NOW), false);
});

test('visible handoffs drop anything older than 7 days and keep drafts that are still fresh', () => {
  const notes = [
    note({ id: 'fresh' }),
    note({ id: 'old', submittedAt: NOW - 9 * DAY, createdAt: NOW - 9 * DAY }),
    note({ id: 'draft', status: 'draft', createdAt: NOW - DAY, submittedAt: null }),
  ];
  assert.deepEqual(visibleHandoffs(notes, NOW).map((item) => item.id), ['fresh', 'draft']);
  const plan = planHandoffCleanup(notes, NOW);
  assert.deepEqual(plan.deleteIds, ['old']);
  assert.equal(plan.eligible, 1);
  assert.equal(plan.retained, 2);
});

test('cleanup plan skips undated documents instead of deleting them', () => {
  const grouped = classifyHandoffs([
    note({ id: 'dated', submittedAt: NOW - 9 * DAY, createdAt: NOW - 9 * DAY }),
    { id: 'blank', text: 'no clock' },
  ], NOW);
  assert.equal(grouped.expired.length, 1);
  assert.equal(grouped.undated.length, 1);
  const plan = planHandoffCleanup(grouped.expired.concat(grouped.undated), NOW);
  assert.deepEqual(plan.deleteIds, ['dated']);
  assert.equal(plan.skippedUndated, 1);
});

test('an edit does not move the retention clock or the original author', () => {
  const original = note();
  const patch = buildHandoffEdit(original, {
    text: 'Updated hold',
    category: 'risk',
    pinned: true,
    editor: { uid: 'admin-9', name: 'Jim Skyway', role: 'admin' },
    now: NOW,
  });
  assert.equal(patch.text, 'Updated hold');
  assert.equal(patch.updatedByUid, 'admin-9');
  assert.equal(Object.hasOwn(patch, 'createdAt'), false);
  assert.equal(Object.hasOwn(patch, 'submittedAt'), false);
  assert.equal(Object.hasOwn(patch, 'authorUid'), false);
  assert.equal(Object.hasOwn(patch, 'status'), false);
  assert.throws(() => buildHandoffEdit(note({ status: 'draft' }), {
    text: 'nope',
    editor: { uid: 'admin-9', name: 'Jim Skyway' },
  }), /Only submitted handoffs/);
});

test('new notes are stored as submitted', () => {
  const payload = buildSubmittedHandoff({
    text: '  Ramp is open  ',
    category: 'handoff',
    pinned: true,
    author: { uid: 'ops-1', name: 'Jordan Vance', role: 'ops' },
    now: NOW,
  });
  assert.equal(payload.status, 'submitted');
  assert.equal(payload.createdAt, NOW);
  assert.equal(payload.submittedAt, NOW);
  assert.equal(payload.text, 'Ramp is open');
  assert.equal(isSubmittedHandoff(payload), true);
});

test('any ops or admin user can edit and delete a submitted handoff, not a draft', async () => {
  const db = createFakeDb([
    note({ id: 'submitted-note' }),
    note({ id: 'legacy-note', status: undefined }),
    note({ id: 'draft-note', status: 'draft' }),
  ]);
  const editor = caller(db, 'admin', 'admin-9');

  const updated = await updateShiftNote(editor, {
    noteId: 'submitted-note',
    note: 'Revised by another controller',
    category: 'decision',
    pinned: false,
  });
  assert.equal(updated.text, 'Revised by another controller');
  assert.equal(updated.authorUid, 'author');
  assert.equal(updated.updatedByUid, 'admin-9');
  assert.equal(updated.status, 'submitted');
  assert.equal(updated.submittedAt, NOW - 2 * DAY);

  const legacy = await updateShiftNote(editor, {
    noteId: 'legacy-note',
    note: 'Legacy notes are submitted',
    category: 'update',
  });
  assert.equal(legacy.text, 'Legacy notes are submitted');
  assert.equal(db.dump().find((item) => item.id === 'legacy-note').authorUid, 'author');

  await assert.rejects(
    () => updateShiftNote(editor, { noteId: 'draft-note', note: 'should fail' }),
    (err) => err.status === 409,
  );
  await assert.rejects(
    () => deleteShiftNote(editor, { noteId: 'draft-note' }),
    (err) => err.status === 409,
  );
  assert.equal(db.dump().some((item) => item.id === 'draft-note'), true);

  const removed = await deleteShiftNote(caller(db, 'ops', 'someone-else'), { noteId: 'submitted-note' });
  assert.equal(removed.id, 'submitted-note');
  assert.equal(db.dump().some((item) => item.id === 'submitted-note'), false);
});

test('listing hides handoffs older than 7 days', async () => {
  const db = createFakeDb([
    note({ id: 'keep', createdAt: Date.now() - DAY, submittedAt: Date.now() - DAY }),
    note({ id: 'drop', createdAt: Date.now() - 9 * DAY, submittedAt: Date.now() - 9 * DAY }),
  ]);
  const notes = await listShiftNotes(caller(db));
  assert.deepEqual(notes.map((item) => item.id), ['keep']);
});

test('adding a handoff writes a submitted document', async () => {
  const db = createFakeDb();
  const created = await addShiftNote(caller(db), {
    note: 'Next controller owns the broker delay',
    category: 'handoff',
    pinned: true,
  });
  assert.equal(created.status, 'submitted');
  assert.equal(created.submittedAt, created.createdAt);
  assert.equal(created.authorUid, 'ops-2');
  assert.equal(db.dump()[0].pinned, true);
});

test('dry-run counts expired handoffs and does not delete them', async () => {
  const notes = [
    note({ id: 'old', submittedAt: NOW - 9 * DAY, createdAt: NOW - 9 * DAY }),
    note({ id: 'new', submittedAt: NOW - DAY, createdAt: NOW - DAY }),
    { id: 'undated', text: 'no time' },
  ];
  let deletedCalls = 0;
  const lines = [];
  const summary = await runShiftHandoffCleanup({
    now: NOW,
    dryRun: true,
    listDocs: async () => notes,
    deleteDocs: async () => { deletedCalls += 1; return 99; },
    log: (line) => lines.push(line),
  });
  assert.equal(deletedCalls, 0);
  assert.equal(summary.dryRun, true);
  assert.equal(summary.scanned, 3);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(summary.skippedUndated, 1);
  assert.equal(summary.retentionDays, 7);
  assert.match(lines[0], /dryRun=true/);
  assert.match(lines[0], /scanned=3/);
  assert.match(lines[0], /eligible=1/);
  assert.match(lines[0], /deleted=0/);
});

test('a live cleanup deletes only expired handoffs and logs the counts', async () => {
  const db = createFakeDb([
    note({ id: 'old-a', submittedAt: NOW - 8 * DAY, createdAt: NOW - 8 * DAY }),
    note({ id: 'old-b', submittedAt: NOW - 10 * DAY, createdAt: NOW - 10 * DAY }),
    note({ id: 'fresh', submittedAt: NOW - 2 * DAY, createdAt: NOW - 2 * DAY }),
    { id: 'undated', text: 'keep me' },
  ]);
  const lines = [];
  const summary = await runShiftHandoffCleanup({
    now: NOW,
    dryRun: false,
    listDocs: async () => db.dump(),
    deleteDocs: (ids) => deleteHandoffDocs(db, ids),
    log: (line) => lines.push(line),
  });
  assert.equal(summary.deleted, 2);
  assert.equal(summary.eligible, 2);
  assert.deepEqual(db.dump().map((item) => item.id).sort(), ['fresh', 'undated']);
  assert.match(lines[0], /deleted=2/);
  assert.match(lines[0], /eligible=2/);
});

test('delete batches stay within the Firestore batch limit', () => {
  const ids = Array.from({ length: 801 }, (_, index) => `n-${index}`);
  ids.push('n-0');
  const chunks = chunkIds(ids, 400);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [400, 400, 1]);
});

test('cron route requires CRON_SECRET and honors dry-run', async () => {
  assert.equal(cronRequestAuthorized({ headers: {} }, {}), false);
  assert.equal(cronRequestAuthorized({ headers: { authorization: 'Bearer secret' } }, {}), false);
  assert.equal(cronRequestAuthorized(
    { headers: { authorization: 'Bearer secret' } },
    { CRON_SECRET: 'secret' },
  ), true);
  assert.equal(cronRequestAuthorized(
    { headers: { authorization: 'Bearer wrong' } },
    { CRON_SECRET: 'secret' },
  ), false);
  assert.equal(cleanupDryRun({ url: '/api/shift-handoff-cleanup?dryRun=1' }), true);
  assert.equal(cleanupDryRun({ query: { dryRun: 'true' } }), true);
  assert.equal(cleanupDryRun({ body: { dryRun: true } }), true);
  assert.equal(cleanupDryRun({ url: '/api/shift-handoff-cleanup' }), false);

  const db = createFakeDb([
    note({ id: 'old', submittedAt: NOW - 9 * DAY, createdAt: NOW - 9 * DAY }),
    note({ id: 'fresh', submittedAt: Date.now() - DAY, createdAt: Date.now() - DAY }),
  ]);
  const logs = [];
  const handler = createShiftHandoffCleanupHandler({
    authorize: () => true,
    openDb: async () => db,
    log: (line) => logs.push(line),
  });

  const denied = mockRes();
  await createShiftHandoffCleanupHandler().call(null, {
    method: 'GET',
    headers: {},
    query: {},
  }, denied);
  assert.equal(denied.statusCode, 401);

  const wrongMethod = mockRes();
  await handler({ method: 'PUT', headers: {}, query: {} }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const dry = mockRes();
  await handler({ method: 'GET', headers: {}, query: { dryRun: '1' } }, dry);
  assert.equal(dry.statusCode, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.deleted, 0);
  assert.equal(dry.body.eligible, 1);
  assert.equal(db.dump().some((item) => item.id === 'old'), true);
  assert.match(logs.at(-1), /dryRun=true/);

  const live = mockRes();
  await handler({ method: 'POST', headers: {}, query: {} }, live);
  assert.equal(live.statusCode, 200);
  assert.equal(live.body.dryRun, false);
  assert.equal(live.body.deleted, 1);
  assert.equal(db.dump().some((item) => item.id === 'old'), false);
  assert.equal(db.dump().some((item) => item.id === 'fresh'), true);
  assert.match(logs.at(-1), /deleted=1/);
});

test('home screen owns shift handoff for ops and admin only', async () => {
  const dashboard = await readFile(path.join(root, 'src/OpsDashboard.jsx'), 'utf8');
  const command = await readFile(path.join(root, 'src/OpsCommandCenter.jsx'), 'utf8');
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  const panel = await readFile(path.join(root, 'src/OpsShiftLog.jsx'), 'utf8');
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const firebase = await readFile(path.join(root, 'firebase.json'), 'utf8');
  const rules = await readFile(path.join(root, 'firebase/appusers-ops-shift-log.rules'), 'utf8');

  assert.match(dashboard, /<OpsShiftLog currentUser=\{currentUser\} \/>/);
  assert.match(command, /<OpsShiftLog currentUser=\{currentUser\} \/>/);
  assert.doesNotMatch(app, /<OpsShiftLog/);
  assert.doesNotMatch(app, /id: 'handoff'/);
  assert.match(panel, /OPS_ROLES = \['ops', 'admin'\]/);
  assert.match(panel, /appReviewer !== true/);
  assert.match(panel, /if \(!canUse\) return null/);
  assert.match(panel, /isSubmittedHandoff\(note\)/);
  assert.match(panel, /visibleHandoffs\(notes\)/);
  assert.doesNotMatch(panel, /authorUid ===/);
  assert.match(panel, /min-h-11/);
  assert.match(panel, /text-base/);

  const cron = vercel.crons.find((entry) => entry.path === '/api/shift-handoff-cleanup');
  assert.equal(cron.schedule, '15 9 * * *');
  assert.doesNotMatch(firebase, /appusers-ops-shift-log/);
  assert.match(rules, /match \/ops-shift-log\/\{noteId\}/);
  assert.match(rules, /allow read, write: if false/);
  assert.match(rules, /DO NOT deploy this file by itself/);
});
