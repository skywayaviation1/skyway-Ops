// Firestore rejects `undefined` anywhere in a write. A missing field must be
// omitted (or stored as null). This walks plain objects and arrays only, so
// Timestamp, FieldValue, and Date instances pass through unchanged.

export function omitUndefined(value) {
  if (Array.isArray(value)) return value.map((item) => omitUndefined(item));
  if (!value || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    out[key] = omitUndefined(child);
  }
  return out;
}

export function hasUndefined(value, path = '') {
  if (value === undefined) return path || '(root)';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = hasUndefined(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      const found = hasUndefined(child, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Arrival fields the departure cron copies forward after a schedule send.
 * `timeChangeForEnd` is absent on legs that have never had a time-change
 * mail. Copying that absence through as `undefined` is what made
 * api/fbo-departure-cron throw in production.
 */
const scrubbedDbs = new WeakSet();

/** Strip undefined on every set() issued through this Firestore instance. */
export function scrubFirestoreWrites(db) {
  if (!db || typeof db !== 'object' || scrubbedDbs.has(db)) return db;
  scrubbedDbs.add(db);
  const wrapSet = (target, positional) => {
    if (!target || typeof target.set !== 'function' || target.__scrubbedSet) return target;
    const original = target.set.bind(target);
    target.set = (...args) => {
      if (positional) {
        const [ref, data, options] = args;
        return options === undefined ? original(ref, omitUndefined(data)) : original(ref, omitUndefined(data), options);
      }
      const [data, options] = args;
      return options === undefined ? original(omitUndefined(data)) : original(omitUndefined(data), options);
    };
    try { target.__scrubbedSet = true; } catch { /* frozen ref; the wrapper still replaced set */ }
    return target;
  };
  if (typeof db.collection === 'function') {
    const originalCollection = db.collection.bind(db);
    db.collection = (...args) => {
      const collection = originalCollection(...args);
      if (collection && typeof collection.doc === 'function' && !collection.__scrubbedDoc) {
        const originalDoc = collection.doc.bind(collection);
        collection.doc = (...docArgs) => wrapSet(originalDoc(...docArgs), false);
        try { collection.__scrubbedDoc = true; } catch { /* ignore */ }
      }
      return collection;
    };
  }
  if (typeof db.batch === 'function') {
    const originalBatch = db.batch.bind(db);
    db.batch = () => wrapSet(originalBatch(), true);
  }
  if (typeof db.runTransaction === 'function') {
    const originalRun = db.runTransaction.bind(db);
    db.runTransaction = (fn) => originalRun((tx) => fn(wrapSet(tx, true)));
  }
  return db;
}

export function cronArrivalFollowUp(leg, kind) {
  const previous = leg?.arrival && typeof leg.arrival === 'object' ? leg.arrival : {};
  return omitUndefined({
    ...previous,
    arrivalStatus: kind === 'time-change' ? 'needs_reconfirm' : 'sent',
    sentForEnd: leg?.end ?? null,
    timeChangeForEnd: kind === 'time-change'
      ? (leg?.end ?? null)
      : (previous.timeChangeForEnd ?? null),
  });
}
