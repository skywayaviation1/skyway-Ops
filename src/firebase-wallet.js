// Firebase helpers for the WALLET — fleet credit/fuel cards.
//
// Cards are visible to all authenticated users. Only ops + admin can add,
// edit, or delete. This is enforced in the UI; for stronger guarantees,
// add Firestore rules.
//
// Document shape:
//   {
//     id, nickname, type, cardNumber, last4, expiration, billingZip,
//     pin, notes, color, createdAt, createdBy, updatedAt
//   }
// Type: 'credit' | 'avfuel' | 'multi-service' | 'colt' | 'phillips66' |
//       'epic' | 'shell' | 'fbo' | 'other'

import { db } from './firebase.js';
import {
  doc, setDoc, getDoc, deleteDoc, collection, query, orderBy, onSnapshot,
} from 'firebase/firestore';

export function newCardId() {
  return `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function saveCard(card) {
  if (!card.id) throw new Error('Card must have an id');
  const safeId = String(card.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  // Always derive last4 from cardNumber so the visible-everywhere field
  // stays in sync with the underlying number.
  const cardNumber = String(card.cardNumber || '').replace(/\s+/g, '');
  const last4 = cardNumber.length >= 4 ? cardNumber.slice(-4) : '';
  await setDoc(
    doc(db, 'wallet-cards', safeId),
    {
      ...card,
      cardNumber,
      last4,
      updatedAt: Date.now(),
      createdAt: card.createdAt || Date.now(),
    },
    { merge: true }
  );
}

export async function deleteCard(id) {
  if (!id) throw new Error('Missing card id');
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  await deleteDoc(doc(db, 'wallet-cards', safeId));
}

export function subscribeToAllCards(onUpdate) {
  const q = query(collection(db, 'wallet-cards'), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ ...d.data(), id: d.id }));
      onUpdate(list);
    },
    (err) => {
      console.error('[wallet] subscribe error:', err);
      onUpdate([]);
    }
  );
}
