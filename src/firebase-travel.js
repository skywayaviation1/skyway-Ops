// Firebase helpers for crew TRAVEL — hotel + commercial flight bookings.
//
// Each booking belongs to a specific user (uid). Users see their own bookings;
// ops + admin can view and add to any user's wallet. Storage is in
// `travel-bookings` keyed by booking id, with userUid as a queryable field.

import { db } from './firebase.js';
import {
  doc, setDoc, getDoc, deleteDoc, collection, query, where, orderBy, onSnapshot,
} from 'firebase/firestore';

export function newBookingId(type) {
  const prefix = type === 'flight' ? 'flt' : type === 'hotel' ? 'htl' : 'bkg';
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function saveBooking(booking) {
  if (!booking.id) throw new Error('Booking must have an id');
  if (!booking.userUid) throw new Error('Booking must have a userUid');
  const safeId = String(booking.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await setDoc(
    doc(db, 'travel-bookings', safeId),
    {
      ...booking,
      updatedAt: Date.now(),
      createdAt: booking.createdAt || Date.now(),
    },
    { merge: true }
  );
}

export async function deleteBooking(id) {
  if (!id) throw new Error('Missing booking id');
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await deleteDoc(doc(db, 'travel-bookings', safeId));
}

/**
 * Subscribe to bookings for a specific user.
 * Sorts by start date descending (most recent first) on the client side
 * to avoid needing a composite Firestore index.
 */
export function subscribeToUserBookings(userUid, onUpdate) {
  if (!userUid) { onUpdate([]); return () => {}; }
  const q = query(
    collection(db, 'travel-bookings'),
    where('userUid', '==', userUid)
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      list.sort((a, b) => {
        const aDate = a.startDate || a.createdAt || 0;
        const bDate = b.startDate || b.createdAt || 0;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      });
      onUpdate(list);
    },
    (err) => {
      console.error('[travel] subscribe error:', err);
      onUpdate([]);
    }
  );
}
