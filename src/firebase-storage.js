// Firebase Storage helpers for trip-sheet PDFs.
//
// Storage layout: /trip-sheets/{tripGroupId}/{filename}.pdf
// Where tripGroupId = a hash of (tail + departure_date) shared across legs of
// the same multi-leg trip — so all legs of one charter point at the same PDF.
//
// IMPORTANT: this file assumes Firebase Storage rules have been configured
// to require authentication. If rules are open, any authenticated user
// (including future broker accounts) can read all trip sheets in the bucket.

import { initializeApp, getApps } from 'firebase/app';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// Initialize storage from the existing app config — same project as Firestore
const firebaseConfig = {
  apiKey: 'AIzaSyBeF0B3h2yphkoxk5CSGmrNgboafb-zG6Y',
  authDomain: 'skyway-ops-app.firebaseapp.com',
  projectId: 'skyway-ops-app',
  storageBucket: 'skyway-ops-app.firebasestorage.app',
  messagingSenderId: '12464871520',
  appId: '1:12464871520:web:d637a1d986c09df5d2cb05',
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const storage = getStorage(app);

/**
 * Compute a stable trip-group ID from a tail and date so all legs of one
 * multi-leg trip resolve to the same group. Format: TAIL_YYYYMMDD.
 * Uses departure DATE (not full timestamp) so leg 2 next morning still groups.
 *
 * NOTE: this won't group legs that span midnight UTC (rare but possible).
 * For now we accept that limitation — if the user reports it, we'll switch to
 * a manually-grouped approach.
 */
export function computeTripGroupId(tail, departureDate) {
  if (!tail || !departureDate) return null;
  const d = departureDate instanceof Date ? departureDate : new Date(departureDate);
  if (isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const safeTail = String(tail).replace(/[^a-zA-Z0-9]/g, '');
  return `${safeTail}_${yyyy}${mm}${dd}`;
}

/**
 * Upload a PDF file to Firebase Storage.
 * Returns { url, path, sizeBytes } on success, throws on failure.
 *
 * file: a File or Blob from a file input
 * tripGroupId: returned from computeTripGroupId
 */
export async function uploadTripSheet(file, tripGroupId) {
  if (!file) throw new Error('No file provided');
  if (!tripGroupId) throw new Error('Missing trip group ID');
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('File too large — limit is 10MB');
  }
  if (file.type && !file.type.includes('pdf')) {
    throw new Error('Only PDF files are accepted');
  }

  // Filename includes timestamp so re-uploads don't overwrite the previous one
  // (gives ops a way to roll back if they uploaded the wrong PDF)
  const filename = `tripsheet_${Date.now()}.pdf`;
  const path = `trip-sheets/${tripGroupId}/${filename}`;
  const storageRef = ref(storage, path);

  const snapshot = await uploadBytes(storageRef, file, {
    contentType: 'application/pdf',
    cacheControl: 'private, max-age=3600',
  });

  const url = await getDownloadURL(snapshot.ref);
  return { url, path, sizeBytes: file.size };
}

/**
 * Delete a trip sheet PDF from storage. Best-effort — silently ignores
 * not-found errors so a stale reference doesn't block trip-state updates.
 */
export async function deleteTripSheet(path) {
  if (!path) return;
  try {
    const storageRef = ref(storage, path);
    await deleteObject(storageRef);
  } catch (err) {
    // object-not-found is fine — already gone
    if (err.code !== 'storage/object-not-found') {
      console.warn('[storage] delete failed:', err.message);
    }
  }
}
