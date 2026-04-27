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
        });
      } else {
        // No state yet — emit empty defaults
        onUpdate({ statuses: {}, passengers: [], brokerEmail: '', autoNotify: false });
      }
    },
    (err) => {
      console.error('Trip state subscription error:', err);
    }
  );
}

/**
 * Save the entire trip state. Uses merge: true so partial updates work.
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
