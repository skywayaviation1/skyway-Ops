// Firebase helpers for expense receipts.
//
// Firestore collection: `expenses`
// Document shape:
//   {
//     id, uid (firebase auth uid of submitter),
//     authorName, authorEmail, authorRole,
//     receiptUrl, receiptPath, receiptFilename, receiptContentType,
//     parsedAt, parsedBy, // 'claude-vision' | 'manual'
//     vendor, transactionDate, totalAmount, currency,
//     subtotal, tax, tip,
//     category, // 'Fuel' | 'Catering' | 'FBO Fees' | 'Hangar' | ...
//     lineItems: [{ description, qty, unitPrice, amount }],
//     tripUid, // optional — link expense to a specific trip
//     notes,
//     status, // 'draft' | 'pending' | 'approved' | 'rejected' | 'synced'
//     submittedAt, approvedAt, approvedBy, rejectedAt, rejectedBy, rejectionReason,
//     syncedAt, qbTransactionId, // populated after QuickBooks sync (chunk 2)
//     createdAt, updatedAt,
//   }
//
// Storage layout: /expenses/{uid}/{filename}
//
// Permissions (handled in security rules, not enforced client-side):
//   crew: read/write own only
//   ops/admin: read all, write own, approve any
//
// IMPORTANT: this file assumes the caller has already verified the user is
// authenticated. We do not enforce permissions here.

import { initializeApp, getApps } from 'firebase/app';
import { db } from './firebase.js';
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';

// Initialize storage from existing app config — same project as Firestore
const firebaseConfig = {
  apiKey: 'AIzaSyBeF0B3h2yphkoxk5CSGmrNgboafb-zG6Y',
  authDomain: 'skyway-ops-app.firebaseapp.com',
  projectId: 'skyway-ops-app',
  storageBucket: 'skyway-ops-app.firebasestorage.app',
  messagingSenderId: '12464871520',
  appId: '1:12464871520:web:d637a1d986c09df5d2cb05',
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const storage = getStorage(app);

/**
 * Standard expense categories for charter operations.
 * Order matters — most common first. These are the values Claude will be
 * asked to choose from when categorizing receipts.
 */
export const EXPENSE_CATEGORIES = [
  'Fuel',
  'Catering',
  'FBO Fees',
  'Hangar',
  'Ground Transport',
  'Crew Meals',
  'Crew Lodging',
  'Supplies',
  'Maintenance',
  'Office',
  'Other',
];

/**
 * Upload a receipt image/PDF to Firebase Storage.
 * Returns { url, path, contentType } on success, throws on failure.
 *
 * file: a File or Blob from a file input or canvas.toBlob()
 * uid: the submitter's Firebase auth UID
 */
export async function uploadReceipt(file, uid) {
  if (!file) throw new Error('No file provided');
  if (!uid) throw new Error('Missing user UID');
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('File too large — limit is 10MB');
  }
  const isPdf = file.type === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf');
  const isImage = (file.type || '').startsWith('image/');
  if (!isPdf && !isImage) {
    throw new Error('Only image (JPEG/PNG/WebP/HEIC) and PDF receipts are accepted');
  }

  const ext = isPdf ? 'pdf' : (file.type?.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const filename = `receipt_${Date.now()}.${ext}`;
  const path = `expenses/${uid}/${filename}`;
  const storageRef = ref(storage, path);

  const snapshot = await uploadBytes(storageRef, file, {
    contentType: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'),
    cacheControl: 'private, max-age=3600',
  });

  const url = await getDownloadURL(snapshot.ref);
  return { url, path, contentType: file.type, sizeBytes: file.size };
}

/**
 * Delete a receipt file from storage.
 * Best-effort — silently ignores not-found errors.
 */
export async function deleteReceiptFile(path) {
  if (!path) return;
  try {
    await deleteObject(ref(storage, path));
  } catch (err) {
    if (err.code !== 'storage/object-not-found') {
      console.warn('[expenses] deleteReceiptFile failed:', err.message);
    }
  }
}

/**
 * Save (create or update) an expense doc in Firestore.
 */
export async function saveExpense(expense) {
  if (!expense.id) throw new Error('Expense must have an id');
  const safeId = String(expense.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const now = Date.now();
  await setDoc(
    doc(db, 'expenses', safeId),
    {
      ...expense,
      updatedAt: now,
      createdAt: expense.createdAt || now,
    },
    { merge: true }
  );
}

/**
 * Hard-delete an expense doc + its receipt file.
 * Use only for drafts the user wants to discard. Submitted/approved expenses
 * should be preserved for audit trail.
 */
export async function deleteExpense(expense) {
  if (!expense || !expense.id) return;
  const safeId = String(expense.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  if (expense.receiptPath) {
    await deleteReceiptFile(expense.receiptPath);
  }
  await deleteDoc(doc(db, 'expenses', safeId));
}

/**
 * Subscribe to expenses for a specific user (their own only).
 * Returns an unsubscribe function.
 */
export function subscribeToUserExpenses(uid, onUpdate) {
  if (!uid) return () => {};
  const q = query(
    collection(db, 'expenses'),
    where('uid', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      onUpdate(list);
    },
    (err) => {
      console.error('[expenses] subscribeToUserExpenses error:', err);
      onUpdate([]);
    }
  );
}

/**
 * Subscribe to ALL expenses (ops/admin only — caller is responsible for role check).
 * Returns an unsubscribe function.
 */
export function subscribeToAllExpenses(onUpdate) {
  const q = query(collection(db, 'expenses'), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      onUpdate(list);
    },
    (err) => {
      console.error('[expenses] subscribeToAllExpenses error:', err);
      onUpdate([]);
    }
  );
}

/**
 * Generate a simple unique ID for a new expense.
 */
export function newExpenseId() {
  return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
