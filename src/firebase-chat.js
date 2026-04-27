// Real-time chat backed by Firestore. Each trip has its own subcollection of
// messages, ordered by timestamp.
import { db } from './firebase.js';
import {
  collection,
  addDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from 'firebase/firestore';

function sanitizeKey(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

// Subscribe to chat messages for a trip. Calls `onUpdate` whenever messages
// change. Returns an unsubscribe function — call it on cleanup to stop
// listening.
export function subscribeToChat(tripId, onUpdate) {
  const safeId = sanitizeKey(tripId);
  const q = query(
    collection(db, 'trips', safeId, 'messages'),
    orderBy('timestamp', 'asc')
  );
  return onSnapshot(
    q,
    (snapshot) => {
      const messages = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          author: data.author,
          text: data.text,
          // serverTimestamp arrives as a Firestore Timestamp; convert to ms
          timestamp: data.timestamp?.toMillis?.() ?? Date.now(),
        };
      });
      onUpdate(messages);
    },
    (error) => {
      console.error('Chat subscription error:', error);
    }
  );
}

// Send a new chat message to a trip's message thread.
export async function sendChatMessage(tripId, author, text) {
  const safeId = sanitizeKey(tripId);
  await addDoc(collection(db, 'trips', safeId, 'messages'), {
    author,
    text: text.trim(),
    timestamp: serverTimestamp(),
  });
}
