/* In-memory document store backing the Firestore mock.
 *
 * Documents are keyed by full path ("duty-periods-v2/abc"), so a collection
 * read is "every key whose parent path matches". Listeners are re-run on any
 * write: the dataset is a few hundred documents, so precision buys nothing.
 */

const docs = new Map();
const listeners = new Set();

let notifyScheduled = false;

function scheduleNotify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  Promise.resolve().then(() => {
    notifyScheduled = false;
    for (const fn of Array.from(listeners)) {
      try { fn(); } catch (err) { console.warn('[mock-store] listener failed', err); }
    }
  });
}

export function parentPath(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function docId(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

export function readDoc(path) {
  return docs.has(path) ? docs.get(path) : undefined;
}

export function readCollection(path) {
  const out = [];
  for (const [key, value] of docs) {
    if (parentPath(key) === path) out.push({ path: key, id: docId(key), data: value });
  }
  return out;
}

export function writeDoc(path, data, { merge = false } = {}) {
  const next = merge && docs.has(path)
    ? deepMerge(docs.get(path), data)
    : clone(data);
  docs.set(path, next);
  scheduleNotify();
  return next;
}

export function patchDoc(path, patch) {
  const base = docs.get(path) || {};
  const next = clone(base);
  // Firestore update() takes dotted field paths; expand them so nested writes
  // land where the read path expects them.
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let cursor = next;
      for (const part of parts.slice(0, -1)) {
        if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
        cursor = cursor[part];
      }
      cursor[parts[parts.length - 1]] = applySentinel(cursor[parts[parts.length - 1]], value);
    } else {
      next[key] = applySentinel(next[key], value);
    }
  }
  docs.set(path, next);
  scheduleNotify();
  return next;
}

export function removeDoc(path) {
  docs.delete(path);
  scheduleNotify();
}

export function addListener(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function seedDoc(path, data) {
  docs.set(path, clone(data));
}

export function allPaths() {
  return Array.from(docs.keys());
}

function applySentinel(current, value) {
  if (value && value.__arrayUnion) {
    const base = Array.isArray(current) ? current.slice() : [];
    for (const item of value.__arrayUnion) {
      if (!base.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) base.push(item);
    }
    return base;
  }
  if (value && value.__arrayRemove) {
    const base = Array.isArray(current) ? current.slice() : [];
    return base.filter((existing) => !value.__arrayRemove
      .some((item) => JSON.stringify(existing) === JSON.stringify(item)));
  }
  if (value && value.__delete) return undefined;
  return clone(value);
}

function deepMerge(base, patch) {
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && !(value instanceof Date) && typeof value.toMillis !== 'function'
        && !value.__arrayUnion && !value.__arrayRemove) {
      out[key] = deepMerge(out[key] && typeof out[key] === 'object' ? out[key] : {}, value);
    } else {
      out[key] = applySentinel(out[key], value);
    }
  }
  return out;
}

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value.toMillis === 'function') return value;
  if (Array.isArray(value)) return value.map(clone);
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clone(item);
  return out;
}
