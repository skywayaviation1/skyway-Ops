// Minimal Firestore shim for the preview harness.
//
// Several screens call the Firestore SDK directly with the `db` handle rather
// than going through a firebase-*.js module, so stubbing those modules alone
// leaves `collection(db, ...)` throwing and the screen stuck on a spinner. This
// shim satisfies the API surface src/ imports and returns empty results, which
// lets those screens finish rendering. Data that matters for imagery still comes
// from the sample-data stubs.

class Ref {
  constructor(path) {
    this.path = path;
    this.id = String(path).split('/').filter(Boolean).pop() || 'preview';
  }
}

const pathOf = (parent, segments) => [
  parent && parent.path ? parent.path : '',
  ...segments.map(String),
].filter(Boolean).join('/');

export const collection = (parent, ...segments) => new Ref(pathOf(parent, segments));
export const doc = (parent, ...segments) => new Ref(pathOf(parent, segments));

const emptySnapshot = {
  empty: true,
  size: 0,
  docs: [],
  forEach() {},
};

const missingDoc = (ref) => ({
  id: ref?.id || 'preview',
  exists: () => false,
  data: () => undefined,
  ref,
});

export const getDocs = async () => emptySnapshot;
export const getDoc = async (ref) => missingDoc(ref);

export function onSnapshot(target, next) {
  const handler = typeof next === 'function' ? next : next?.next;
  if (typeof handler === 'function') {
    // A document listener expects a document snapshot; a collection listener
    // expects a query snapshot. Collection paths have an odd segment count.
    const segments = String(target?.path || '').split('/').filter(Boolean);
    handler(segments.length % 2 === 1 ? emptySnapshot : missingDoc(target));
  }
  return () => {};
}

export const setDoc = async () => {};
export const addDoc = async () => new Ref('preview/created');
export const updateDoc = async () => {};
export const deleteDoc = async () => {};

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
