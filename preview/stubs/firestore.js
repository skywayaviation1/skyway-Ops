// Minimal Firestore shim for the preview harness.
//
// Several screens call the Firestore SDK directly with the `db` handle rather
// than going through a firebase-*.js module, so stubbing those modules alone
// leaves `collection(db, ...)` throwing and the screen stuck on a spinner. This
// shim satisfies the API surface src/ imports. Pilot logbooks, currency, and
// certificate scans are seeded so the safety-rating screens render; every
// other path still comes back empty.

import { pilotSafetySeed } from '../sample-data.js';

class Ref {
  constructor(path) {
    this.path = path;
    this.id = String(path).split('/').filter(Boolean).pop() || 'preview';
  }
}

const pathOf = (parent, segments) => [
  parent && parent.path ? parent.path : (typeof parent === 'string' ? parent : ''),
  ...segments.map(String),
].filter(Boolean).join('/');

const memory = new Map();
const listeners = [];
let seeded = false;

function ensureSeed() {
  if (seeded) return;
  seeded = true;
  const seed = pilotSafetySeed();
  for (const book of seed.logbooks) memory.set(`pilot-logbooks/${book.uid}`, { ...book });
  for (const currency of seed.currencies) memory.set(`pilot-currencies/${currency.uid}`, { ...currency });
  for (const docRecord of seed.pilotDocs) memory.set(`pilot-docs/${docRecord.id}`, { ...docRecord });
}

function documentSnapshot(path) {
  const data = memory.get(path);
  return {
    id: String(path).split('/').filter(Boolean).pop() || 'preview',
    exists: () => data != null,
    data: () => (data ? { ...data } : undefined),
    ref: new Ref(path),
  };
}

function collectionSnapshot(path) {
  const prefix = `${path}/`;
  const docs = [];
  for (const key of memory.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!rest || rest.includes('/')) continue;
    docs.push(documentSnapshot(key));
  }
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs,
    forEach(fn) { docs.forEach((entry) => fn(entry)); },
  };
}

function notify(path) {
  for (const entry of listeners) {
    if (entry.path === path) entry.fire();
    else if (entry.isCollection && (path === entry.path || path.startsWith(`${entry.path}/`))) entry.fire();
  }
}

export const collection = (parent, ...segments) => new Ref(pathOf(parent, segments));
export const doc = (parent, ...segments) => new Ref(pathOf(parent, segments));

export const getDocs = async (ref) => {
  ensureSeed();
  const path = ref?.path || '';
  const segments = String(path).split('/').filter(Boolean);
  return segments.length % 2 === 1 ? collectionSnapshot(path) : { empty: true, size: 0, docs: [], forEach() {} };
};

export const getDoc = async (ref) => {
  ensureSeed();
  return documentSnapshot(ref?.path || '');
};

export function onSnapshot(target, next) {
  ensureSeed();
  const handler = typeof next === 'function' ? next : next?.next;
  const path = String(target?.path || '');
  const segments = path.split('/').filter(Boolean);
  const isCollection = segments.length % 2 === 1;
  const fire = () => {
    if (typeof handler !== 'function') return;
    handler(isCollection ? collectionSnapshot(path) : documentSnapshot(path));
  };
  fire();
  const entry = { path, isCollection, fire };
  listeners.push(entry);
  return () => {
    const index = listeners.indexOf(entry);
    if (index >= 0) listeners.splice(index, 1);
  };
}

export const setDoc = async (ref, data, options) => {
  ensureSeed();
  const path = ref?.path;
  if (!path) return;
  const prev = memory.get(path) || {};
  memory.set(path, options?.merge ? { ...prev, ...data } : { ...(data || {}) });
  notify(path);
};

export const addDoc = async (ref) => {
  const created = new Ref(`${ref?.path || 'preview'}/created`);
  memory.set(created.path, {});
  notify(created.path);
  return created;
};

export const updateDoc = async (ref, data) => setDoc(ref, data, { merge: true });

export const deleteDoc = async (ref) => {
  if (ref?.path) {
    memory.delete(ref.path);
    notify(ref.path);
  }
};

export const query = (ref) => ref;
export const where = () => ({ type: 'where' });
export const orderBy = () => ({ type: 'orderBy' });
export const limit = () => ({ type: 'limit' });

export const serverTimestamp = () => Date.now();
export const arrayUnion = (...values) => values;
export const arrayRemove = (...values) => values;

export const Timestamp = {
  now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }),
  fromDate: (date) => ({ toMillis: () => date.getTime(), toDate: () => date }),
  fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) }),
};

export const writeBatch = () => ({
  set() { return this; },
  update() { return this; },
  delete() { return this; },
  commit: async () => {},
});

export const initializeFirestore = () => ({ type: 'preview-firestore' });
export const getFirestore = () => ({ type: 'preview-firestore' });
