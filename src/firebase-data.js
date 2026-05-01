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
        });
      } else {
        // No state yet — emit empty defaults
        onUpdate({ statuses: {}, passengers: [], brokerEmail: '', autoNotify: false, completed: false, completedAt: null, archived: false, archivedAt: null, hasCatering: true, paxOverride: null });
      }
    },
    (err) => {
      console.error('Trip state subscription error:', err);
    }
  );
}

/**
 * Save the entire trip state. Overwrites the document — required so deleted
 * status keys actually disappear (merge:true would leave them).
 */
export async function saveTripState(tripId, state) {
  const safeId = sanitizeKey(tripId);
  await setDoc(
    doc(db, 'trip-state', safeId),
    {
      statuses: state.statuses || {},
      passengers: state.passengers || [],
      brokerEmail: state.brokerEmail || '',
      autoNotify: state.autoNotify === true,
      completed: state.completed === true,
      completedAt: state.completedAt || null,
      archived: state.archived === true,
      archivedAt: state.archivedAt || null,
      hasCatering: state.hasCatering !== false,
      paxOverride: typeof state.paxOverride === 'number' ? state.paxOverride : null,
      updatedAt: Date.now(),
    }
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
