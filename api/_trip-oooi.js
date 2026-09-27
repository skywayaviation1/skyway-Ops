// Merge FlightAware out/off/on/in onto a trip without erasing a time the
// latest event did not repeat. A wheels-up event often has off but not in;
// the landing event must not blank the earlier out/off.

const OOOI_KEYS = ['actualOut', 'actualOff', 'actualOn', 'actualIn', 'faFlightId'];

export function nextOooi(existing, incoming) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const next = { ...prev };
  let changed = false;
  for (const key of OOOI_KEYS) {
    const value = incoming?.[key];
    if (!value || value === prev[key]) continue;
    next[key] = value;
    changed = true;
  }
  if (!changed) return null;
  next.updatedAt = Date.now();
  return next;
}

export async function mergeTripOooi(db, tripUid, existingOooi, incoming) {
  const next = nextOooi(existingOooi, incoming);
  if (!next || !tripUid) return false;
  await db.collection('trip-state').doc(String(tripUid)).set({
    oooi: next,
    updatedAt: Date.now(),
  }, { merge: true });
  return true;
}
