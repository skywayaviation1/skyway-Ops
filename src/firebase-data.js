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
  getDoc,
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
 * in `state` get written; existing fields are preserved.
 *
 * IMPORTANT: For maps that need delete semantics (e.g. statuses where removing
 * a key must actually remove it from Firestore), the caller must pass the
 * complete map object — we write whatever was provided, including {}. We do
 * NOT use Firestore's `{ merge: true }` because that's deep-merge, which
 * leaves stale keys in nested maps.
 *
 * The reason this used to overwrite the whole document was the `statuses`
 * delete-key concern. We now solve that by always treating `statuses` (and
 * other map-shaped fields) as full-replace WHEN PROVIDED, and skipping them
 * entirely when the caller didn't pass them. This way calling
 * `saveTripState(uid, { archived: true })` doesn't blow away passengers,
 * statuses, or anything else.
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

  await setDoc(doc(db, 'trip-state', safeId), patch, { merge: true });
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
      updatedAt: Date.now(),
    },
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
