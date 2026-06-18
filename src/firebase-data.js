// Firebase trip state + manual trips sync.
//
// Two collections in Firestore:
//   trip-state/{tripId}  — { statuses: {...}, passengers: [...], brokerEmail, autoNotify }
//   manual-trips/{tripUid} — full manual trip object
//
// Both have real-time listeners so changes from any user appear instantly on
// every other user's device.

import { db } from './firebase.js';
import {
  doc,
  setDoc,
  updateDoc,
  getDoc,
  getDocs,
  deleteDoc,
  collection,
  onSnapshot,
} from 'firebase/firestore';

function sanitizeKey(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

/* ============================================================
   TRIP STATE — statuses, passengers, broker email per trip
   ============================================================ */

/**
 * One-shot fetch: get the preloadedPax array for a trip, if any.
 * Returns [] if no trip-state doc or no preloadedPax.
 * Used by Load Manifest pre-populate to grab pax names without subscribing.
 */
export async function fetchPreloadedPax(tripId) {
  if (!tripId) return [];
  const safeId = sanitizeKey(tripId);
  try {
    const snap = await getDoc(doc(db, 'trip-state', safeId));
    if (!snap.exists()) return [];
    const data = snap.data();
    return Array.isArray(data.preloadedPax) ? data.preloadedPax : [];
  } catch (err) {
    console.error('[firebase-data] fetchPreloadedPax failed:', tripId, err);
    return [];
  }
}

/**
 * One-shot fetch combining preloadedPax + statuses + scanned passengers
 * for a trip. Used by SHARE WITH BROKER to grab everything needed for
 * the broker snapshot in a single read per leg.
 *   { preloadedPax: [], passengers: [], statuses: {} }
 * Empty arrays/object if the doc doesn't exist or fields are missing.
 */
export async function fetchTripStateForShare(tripId) {
  if (!tripId) return { preloadedPax: [], passengers: [], statuses: {} };
  const safeId = sanitizeKey(tripId);
  try {
    const snap = await getDoc(doc(db, 'trip-state', safeId));
    if (!snap.exists()) return { preloadedPax: [], passengers: [], statuses: {} };
    const data = snap.data();
    return {
      preloadedPax: Array.isArray(data.preloadedPax) ? data.preloadedPax : [],
      passengers: Array.isArray(data.passengers) ? data.passengers : [],
      statuses: (data.statuses && typeof data.statuses === 'object') ? data.statuses : {},
    };
  } catch (err) {
    console.error('[firebase-data] fetchTripStateForShare failed:', tripId, err);
    return { preloadedPax: [], passengers: [], statuses: {} };
  }
}

/**
 * Subscribe to a trip's state. Calls onUpdate({statuses, passengers, brokerEmail, autoNotify})
 * whenever ANY user changes ANY field of this trip's state.
 * Returns unsubscribe function.
 */
export function subscribeToTripState(tripId, onUpdate) {
  const safeId = sanitizeKey(tripId);
  return onSnapshot(
    doc(db, 'trip-state', safeId),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        onUpdate({
          statuses: data.statuses || {},
          passengers: data.passengers || [],
          brokerEmail: data.brokerEmail || '',
          autoNotify: data.autoNotify === true,
          completed: data.completed === true,
          completedAt: data.completedAt || null,
          archived: data.archived === true,
          archivedAt: data.archivedAt || null,
          // Default to TRUE for existing trips that don't have this field —
          // catering is the historical default. Ops can toggle off per trip.
          hasCatering: data.hasCatering !== false,
          // null means "use iCal pax"; a number means crew has overridden it
          paxOverride: typeof data.paxOverride === 'number' ? data.paxOverride : null,
          // Trip sheet PDF (uploaded by ops/admin, viewable by crew)
          tripSheetUrl: data.tripSheetUrl || null,
          tripSheetPath: data.tripSheetPath || null,
          tripSheetUploadedAt: data.tripSheetUploadedAt || null,
          tripSheetUploadedBy: data.tripSheetUploadedBy || null,
          tripSheetFilename: data.tripSheetFilename || null,
          // Pre-loaded passengers parsed from the trip sheet — array of
          // { id, firstName, lastName, dob, weight, gender, primary, scannedPaxId }
          // scannedPaxId points to an entry in passengers[] once crew has scanned.
          preloadedPax: Array.isArray(data.preloadedPax) ? data.preloadedPax : [],
          // Notes parsed from trip sheet (crew/pax/customer/specialItems)
          tripSheetNotes: data.tripSheetNotes || null,
          tripSheetNotesEditedAt: data.tripSheetNotesEditedAt || null,
          tripSheetNotesEditedByName: data.tripSheetNotesEditedByName || null,
          // FBO names parsed from the trip sheet for THIS leg's two airports.
          fromFbo: data.fromFbo || null,
          toFbo: data.toFbo || null,
        });
      } else {
        // No state yet — emit empty defaults
        onUpdate({
          statuses: {}, passengers: [], brokerEmail: '', autoNotify: false,
          completed: false, completedAt: null, archived: false, archivedAt: null,
          hasCatering: true, paxOverride: null,
          tripSheetUrl: null, tripSheetPath: null, tripSheetUploadedAt: null,
          tripSheetUploadedBy: null, tripSheetFilename: null,
          preloadedPax: [],
          tripSheetNotes: null,
          tripSheetNotesEditedAt: null,
          tripSheetNotesEditedByName: null,
          fromFbo: null,
          toFbo: null,
        });
      }
    },
    (err) => {
      console.error('Trip state subscription error:', err);
    }
  );
}

/**
 * Save trip state. Performs a per-field merge: only fields explicitly present
 * in `state` get written; existing fields on the document are preserved.
 *
 * Critical subtlety with map-shaped fields like `statuses`:
 *   - We want PATCH semantics for top-level fields (don't blow away passengers
 *     when only archived changes)
 *   - We want REPLACE semantics for the map's contents (when crew removes a
 *     status, that key must actually disappear from Firestore)
 *
 * `setDoc({merge: true})` does deep-merge, which RETAINS stale keys inside
 * maps — exactly what we don't want for status undo.
 * `updateDoc()` does shallow-merge: top-level fields you don't pass are kept,
 * and top-level fields you DO pass replace the prior value entirely. That's
 * the behavior we want.
 *
 * `updateDoc` requires the doc to exist. For first writes we fall back to
 * `setDoc` with no merge flag (the patch IS the whole doc).
 */
export async function saveTripState(tripId, state) {
  const safeId = sanitizeKey(tripId);
  // Build the patch — only include fields the caller explicitly passed.
  // `hasOwnProperty` distinguishes "not passed" from "passed as undefined/null".
  const patch = { updatedAt: Date.now() };
  const has = (k) => Object.prototype.hasOwnProperty.call(state, k);

  if (has('statuses'))             patch.statuses = state.statuses || {};
  if (has('passengers'))           patch.passengers = state.passengers || [];
  if (has('brokerEmail'))          patch.brokerEmail = state.brokerEmail || '';
  if (has('autoNotify'))           patch.autoNotify = state.autoNotify === true;
  if (has('completed'))            patch.completed = state.completed === true;
  if (has('completedAt'))          patch.completedAt = state.completedAt || null;
  if (has('archived'))             patch.archived = state.archived === true;
  if (has('archivedAt'))           patch.archivedAt = state.archivedAt || null;
  if (has('hasCatering'))          patch.hasCatering = state.hasCatering !== false;
  if (has('paxOverride'))          patch.paxOverride = typeof state.paxOverride === 'number' ? state.paxOverride : null;
  if (has('tripSheetUrl'))         patch.tripSheetUrl = state.tripSheetUrl || null;
  if (has('tripSheetPath'))        patch.tripSheetPath = state.tripSheetPath || null;
  if (has('tripSheetUploadedAt'))  patch.tripSheetUploadedAt = state.tripSheetUploadedAt || null;
  if (has('tripSheetUploadedBy'))  patch.tripSheetUploadedBy = state.tripSheetUploadedBy || null;
  if (has('tripSheetFilename'))    patch.tripSheetFilename = state.tripSheetFilename || null;
  if (has('preloadedPax'))         patch.preloadedPax = Array.isArray(state.preloadedPax) ? state.preloadedPax : [];
  if (has('tripSheetNotes'))       patch.tripSheetNotes = state.tripSheetNotes || null;
  // Audit trail for in-place edits of the trip-sheet-parsed notes.
  // Set whenever the UI edits tripSheetNotes so the panel can show who
  // overrode the original parsed values and when.
  if (has('tripSheetNotesEditedAt'))     patch.tripSheetNotesEditedAt = state.tripSheetNotesEditedAt || null;
  if (has('tripSheetNotesEditedByName')) patch.tripSheetNotesEditedByName = state.tripSheetNotesEditedByName || null;
  if (has('fromFbo'))              patch.fromFbo = state.fromFbo || null;
  if (has('toFbo'))                patch.toFbo = state.toFbo || null;
  // tripMeta — route/tail/start info, used by the FlightAware webhook to match
  // incoming events to this trip. See PR 2c.
  if (has('tripMeta'))             patch.tripMeta = state.tripMeta || null;

  const ref = doc(db, 'trip-state', safeId);

  // Try updateDoc first — it does shallow-merge (replaces top-level fields you
  // pass, leaves the rest). That's the behavior we need for `statuses` undo.
  try {
    await updateDoc(ref, patch);
  } catch (err) {
    // updateDoc throws "not-found" when the doc doesn't exist yet. First-write
    // case — fall back to setDoc with the patch as the whole doc.
    if (err && (err.code === 'not-found' || /No document to update/i.test(String(err.message || '')))) {
      await setDoc(ref, patch);
    } else {
      throw err;
    }
  }
}

/**
 * Attach (or clear) trip-sheet metadata + pre-loaded pax to a single leg.
 * Uses merge:true so we don't clobber statuses, passengers, etc.
 *
 * legUpdate shape:
 *   { tripUid, preloadedPax, tripSheetUrl, tripSheetPath, tripSheetFilename, uploadedBy }
 * Or to clear:
 *   { tripUid, clear: true }
 */
export async function attachTripSheetToLeg(legUpdate) {
  const safeId = sanitizeKey(legUpdate.tripUid);
  if (legUpdate.clear) {
    await setDoc(
      doc(db, 'trip-state', safeId),
      {
        tripSheetUrl: null,
        tripSheetPath: null,
        tripSheetUploadedAt: null,
        tripSheetUploadedBy: null,
        tripSheetFilename: null,
        preloadedPax: [],
        tripSheetNotes: null,
        fromFbo: null,
        toFbo: null,
        // Also clear the rich per-leg JetInsight blob (added 2026-06).
        // null rather than deleteField() — null reads cleanly downstream
        // and keeps Firestore merge semantics simple.
        tripSheetData: null,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    return;
  }
  await setDoc(
    doc(db, 'trip-state', safeId),
    {
      tripSheetUrl: legUpdate.tripSheetUrl || null,
      tripSheetPath: legUpdate.tripSheetPath || null,
      tripSheetUploadedAt: Date.now(),
      tripSheetUploadedBy: legUpdate.uploadedBy || null,
      tripSheetFilename: legUpdate.tripSheetFilename || null,
      preloadedPax: Array.isArray(legUpdate.preloadedPax) ? legUpdate.preloadedPax : [],
      tripSheetNotes: legUpdate.tripSheetNotes || null,
      fromFbo: legUpdate.fromFbo || null,
      toFbo: legUpdate.toFbo || null,
      // Rich per-leg JetInsight data (added 2026-06): distance, block,
      // flight, fees, fuel tiers, airport phones/A2G, segment status,
      // transport arrangements, etc. Stored as a nested object so the
      // existing trip-card / detail UI can pull fields without further
      // Firestore queries. Pass-through only — if the caller didn't
      // include it (older client), leave Firestore field unchanged
      // (merge semantics).
      ...(legUpdate.tripSheetData ? { tripSheetData: legUpdate.tripSheetData } : {}),
      updatedAt: Date.now(),
    },
    { merge: true }
  );
}

/**
 * Subscribe to FlightAware fleet position data, written by the cron at
 * /api/flightaware-cron-poll.js to `flightaware-state/{tail}`. This is
 * how clients (FlightBoard, TRACKING tab) read live data WITHOUT making
 * their own FA API calls — cuts cost roughly in half by eliminating
 * client-initiated polling, and lets unlimited TV displays read the
 * same data at zero additional cost.
 *
 * The cron polls every 2 minutes; data freshness is bounded by that
 * cadence. For most operational use this is plenty — actual aircraft
 * positions don't update faster than ~30-60s on FA's side anyway.
 *
 * onUpdate(positionMap)  — { [tail]: { ident, airborne, latitude, ... } }
 * Returns the unsubscribe function.
 */
export function subscribeFleetPositions(onUpdate) {
  return onSnapshot(
    collection(db, 'flightaware-state'),
    (snap) => {
      const map = {};
      snap.forEach((d) => {
        const data = d.data() || {};
        // Key by tail (uppercase to match how consumers compare)
        map[d.id.toUpperCase()] = { ...data, ident: d.id };
      });
      onUpdate(map);
    },
    (err) => {
      console.error('[fleet-positions] subscribe error:', err);
      onUpdate({});
    },
  );
}

/**
 * Subscribe to the FlightAware-populated airport cache at
 * `flightaware-airports/{code}`. Each doc is `{ code, lat, lon, city }`.
 * Used by the FlightBoard to fill in coords for airports not in the
 * bundled static database — the cache grows organically as the cron
 * sees new airports.
 *
 * onUpdate(airportMap)  — { [code]: { lat, lng, city } }
 *   (note: 'lng' for the consumer side; FA stores 'lon')
 */
export function subscribeAirportCache(onUpdate) {
  return onSnapshot(
    collection(db, 'flightaware-airports'),
    (snap) => {
      const map = {};
      snap.forEach((d) => {
        const data = d.data() || {};
        if (Number.isFinite(data.lat) && Number.isFinite(data.lon)) {
          map[d.id.toUpperCase()] = {
            lat: data.lat,
            lng: data.lon,
            city: data.city || null,
          };
        }
      });
      onUpdate(map);
    },
    (err) => {
      console.error('[airport-cache] subscribe error:', err);
      onUpdate({});
    },
  );
}

/**
 * Subscribe to ALL trip-state docs in one listener. Returns a Map keyed
 * by tripId so callers can do O(1) lookups while iterating their own
 * trips list. Used by the Ops Console which renders many trips at once;
 * the per-trip subscribeToTripState pattern doesn't scale to dozens of
 * listeners (each chews a websocket message slot).
 *
 * onUpdate(stateMap)  — Map<tripId, stateObject>
 * Returns the unsubscribe function.
 */
export function subscribeAllTripStates(onUpdate) {
  return onSnapshot(
    collection(db, 'trip-state'),
    (snap) => {
      const map = new Map();
      snap.forEach((d) => {
        const data = d.data() || {};
        map.set(d.id, {
          tripId: d.id,
          statuses: data.statuses || {},
          passengers: Array.isArray(data.passengers) ? data.passengers : [],
          brokerEmail: data.brokerEmail || '',
          completed: data.completed === true,
          archived: data.archived === true,
          completedAt: data.completedAt || null,
          archivedAt: data.archivedAt || null,
          tripSheetUrl: data.tripSheetUrl || null,
          tripSheetFilename: data.tripSheetFilename || null,
          tripSheetUploadedAt: data.tripSheetUploadedAt || null,
          dispatcherUids: Array.isArray(data.dispatcherUids) ? data.dispatcherUids : [],
          hasCatering: data.hasCatering !== false,
          paxOverride: typeof data.paxOverride === 'number' ? data.paxOverride : null,
        });
      });
      onUpdate(map);
    },
    (err) => {
      console.error('[trip-state] subscribeAll error:', err);
      onUpdate(new Map());
    },
  );
}

/**
 * One-shot: return all trip-state docs that have a trip sheet PDF stored.
 * Used by the admin FBO backfill. Each item: { tripId, tripSheetUrl,
 * tripSheetFilename, hasFbo } so the caller can skip already-done ones.
 */
export async function getTripSheetsForBackfill() {
  const snap = await getDocs(collection(db, 'trip-state'));
  const out = [];
  snap.forEach((d) => {
    const data = d.data() || {};
    if (!data.tripSheetUrl) return; // no PDF to reparse
    out.push({
      tripId: d.id,
      tripSheetUrl: data.tripSheetUrl,
      tripSheetPath: data.tripSheetPath || null,
      tripSheetFilename: data.tripSheetFilename || '(unnamed)',
      hasFbo: !!(data.fromFbo || data.toFbo),
      from: (data.tripMeta && data.tripMeta.from) || null,
      to: (data.tripMeta && data.tripMeta.to) || null,
      start: (data.tripMeta && data.tripMeta.start) || null,
    });
  });
  return out;
}

/**
 * Write just the FBO fields onto a trip-state doc by its already-sanitized
 * doc id (used by the backfill — the id comes straight from getDocs).
 */
export async function setTripFboById(tripDocId, fromFbo, toFbo) {
  await setDoc(
    doc(db, 'trip-state', tripDocId),
    { fromFbo: fromFbo || null, toFbo: toFbo || null, updatedAt: Date.now() },
    { merge: true }
  );
}

/* ============================================================
   MANUAL TRIPS — created by ops, shared across all users
   ============================================================ */

/**
 * Subscribe to all manual trips. Calls onUpdate(array) whenever any user
 * adds/removes a manual trip.
 */
export function subscribeToManualTrips(onUpdate) {
  return onSnapshot(
    collection(db, 'manual-trips'),
    (snapshot) => {
      const trips = snapshot.docs.map((doc) => {
        const data = doc.data();
        // Rehydrate Date objects from stored ISO strings
        return {
          ...data,
          uid: doc.id,
          start: data.start ? new Date(data.start) : null,
          end: data.end ? new Date(data.end) : null,
        };
      });
      onUpdate(trips);
    },
    (err) => {
      console.error('Manual trips subscription error:', err);
    }
  );
}

/**
 * Save a manual trip. Stores Date objects as ISO strings.
 */
export async function saveManualTrip(trip) {
  const safeId = sanitizeKey(trip.uid);
  const serialized = {
    ...trip,
    uid: trip.uid,
    start: trip.start instanceof Date ? trip.start.toISOString() : trip.start,
    end: trip.end instanceof Date ? trip.end.toISOString() : trip.end,
    updatedAt: Date.now(),
  };
  await setDoc(doc(db, 'manual-trips', safeId), serialized);
}

/**
 * Delete a manual trip.
 */
export async function deleteManualTrip(tripUid) {
  const safeId = sanitizeKey(tripUid);
  await deleteDoc(doc(db, 'manual-trips', safeId));
}

