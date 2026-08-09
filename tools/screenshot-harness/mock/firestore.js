/* Stand-in for the `firebase/firestore` module.
 *
 * The screenshot harness aliases this over the real SDK so every data module in
 * src/ runs unmodified against an in-memory dataset. Only the surface the app
 * actually imports is implemented.
 */

import {
  addListener, docId, patchDoc, readCollection, readDoc, removeDoc, writeDoc,
} from './store.js';

const DB = { __mockDb: true };

export function initializeApp() { return { name: 'mock' }; }
export function initializeFirestore() { return DB; }
export function getFirestore() { return DB; }

export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  static fromDate(date) { return Timestamp.fromMillis(date.getTime()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  valueOf() { return this.toMillis(); }
}

export function serverTimestamp() { return Timestamp.now(); }
export function arrayUnion(...items) { return { __arrayUnion: items }; }
export function arrayRemove(...items) { return { __arrayRemove: items }; }
export function deleteField() { return { __delete: true }; }
export function increment(amount) { return { __increment: amount }; }

function joinSegments(root, segments) {
  const base = typeof root === 'string' ? root : (root && root.__path) || '';
  const parts = [base, ...segments]
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map(String)
    .join('/')
    .split('/')
    .filter(Boolean);
  return parts.join('/');
}

function autoId() {
  return `mock-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function collection(root, ...segments) {
  const base = root && root.__mockDb ? '' : root;
  return { __type: 'collection', __path: joinSegments(base, segments) };
}

export function collectionGroup(_db, name) {
  return { __type: 'collectionGroup', __path: name };
}

export function doc(root, ...segments) {
  const base = root && root.__mockDb ? '' : root;
  const path = segments.length
    ? joinSegments(base, segments)
    : joinSegments(base, [autoId()]);
  return { __type: 'doc', __path: path, id: docId(path) };
}

export function query(ref, ...constraints) {
  return { __type: 'query', __ref: ref, __constraints: constraints.filter(Boolean) };
}

export function where(field, op, value) { return { __c: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc') { return { __c: 'orderBy', field, dir }; }
export function limit(count) { return { __c: 'limit', count }; }
export function startAfter() { return { __c: 'noop' }; }
export function endBefore() { return { __c: 'noop' }; }

function fieldValue(data, field) {
  return String(field).split('.').reduce(
    (cursor, part) => (cursor === undefined || cursor === null ? undefined : cursor[part]),
    data,
  );
}

function comparable(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return value;
}

function matches(data, { field, op, value }) {
  const actual = comparable(fieldValue(data, field));
  const expected = comparable(value);
  switch (op) {
    case '==': return actual === expected;
    case '!=': return actual !== expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case 'in': return Array.isArray(expected) && expected.map(comparable).includes(actual);
    case 'not-in': return Array.isArray(expected) && !expected.map(comparable).includes(actual);
    case 'array-contains':
      return Array.isArray(actual) && actual.map(comparable).includes(expected);
    case 'array-contains-any':
      return Array.isArray(actual) && Array.isArray(expected)
        && expected.map(comparable).some((item) => actual.map(comparable).includes(item));
    default: return true;
  }
}

function resolve(target) {
  if (target.__type === 'query') {
    const { rows, path } = resolve(target.__ref);
    let out = rows;
    const orders = [];
    let cap = null;
    for (const constraint of target.__constraints) {
      if (constraint.__c === 'where') out = out.filter((row) => matches(row.data, constraint));
      else if (constraint.__c === 'orderBy') orders.push(constraint);
      else if (constraint.__c === 'limit') cap = constraint.count;
    }
    for (const order of orders.slice().reverse()) {
      out = out.slice().sort((a, b) => {
        const left = comparable(fieldValue(a.data, order.field));
        const right = comparable(fieldValue(b.data, order.field));
        if (left === right) return 0;
        if (left === undefined || left === null) return 1;
        if (right === undefined || right === null) return -1;
        return (left > right ? 1 : -1) * (order.dir === 'desc' ? -1 : 1);
      });
    }
    if (cap != null) out = out.slice(0, cap);
    return { rows: out, path };
  }
  if (target.__type === 'collectionGroup') {
    // Subcollection scans are rare in this app; match on the trailing segment.
    const rows = [];
    for (const row of readCollection('')) rows.push(row);
    return { rows, path: target.__path };
  }
  return { rows: readCollection(target.__path), path: target.__path };
}

function docSnapshot(path, data) {
  return {
    id: docId(path),
    ref: { __type: 'doc', __path: path, id: docId(path) },
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : data),
    get: (field) => fieldValue(data, field),
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}

function querySnapshot(rows) {
  const snaps = rows.map((row) => docSnapshot(row.path, row.data));
  return {
    docs: snaps,
    size: snaps.length,
    empty: snaps.length === 0,
    forEach: (fn) => snaps.forEach(fn),
    docChanges: () => snaps.map((snap) => ({ type: 'added', doc: snap })),
    metadata: { fromCache: false, hasPendingWrites: false },
  };
}

export async function getDoc(ref) {
  return docSnapshot(ref.__path, readDoc(ref.__path));
}

export async function getDocs(target) {
  return querySnapshot(resolve(target).rows);
}

export function onSnapshot(target, ...rest) {
  const next = typeof rest[0] === 'function' ? rest[0] : rest[0]?.next;
  const emit = () => {
    if (!next) return;
    if (target.__type === 'doc') next(docSnapshot(target.__path, readDoc(target.__path)));
    else next(querySnapshot(resolve(target).rows));
  };
  emit();
  return addListener(emit);
}

export async function setDoc(ref, data, options = {}) {
  writeDoc(ref.__path, data, { merge: !!options.merge });
}

export async function addDoc(ref, data) {
  const path = `${ref.__path}/${autoId()}`;
  writeDoc(path, data);
  return { __type: 'doc', __path: path, id: docId(path) };
}

export async function updateDoc(ref, patch) {
  patchDoc(ref.__path, patch);
}

export async function deleteDoc(ref) {
  removeDoc(ref.__path);
}

export function writeBatch() {
  const ops = [];
  return {
    set: (ref, data, options) => { ops.push(() => setDoc(ref, data, options)); },
    update: (ref, patch) => { ops.push(() => updateDoc(ref, patch)); },
    delete: (ref) => { ops.push(() => deleteDoc(ref)); },
    commit: async () => { for (const op of ops) await op(); },
  };
}

export async function runTransaction(_db, fn) {
  return fn({
    get: (ref) => getDoc(ref),
    set: (ref, data, options) => setDoc(ref, data, options),
    update: (ref, patch) => updateDoc(ref, patch),
    delete: (ref) => deleteDoc(ref),
  });
}

export function enableIndexedDbPersistence() { return Promise.resolve(); }
export function connectFirestoreEmulator() {}
export const documentId = () => '__name__';
