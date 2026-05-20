// firebase-comms.js — Comms data layer (Slice 2 of the chat build).
//
// Designed up-front to support BOTH the new conversations collection AND
// legacy per-trip / per-AOG message subcollections, so the Comms inbox can
// merge them without a data migration.
//
// DATA MODEL
// ----------
// conversations/{convId}
//   kind             : 'dm' | 'group' | 'trip' | 'aog' | 'sr'
//   participants     : string[]  -- uids; for 'dm' always exactly 2
//   participantsKey  : string    -- sorted-joined uids for 'dm' lookup
//   title            : string    -- group name; auto for dm/trip/aog/sr
//   createdBy        : uid
//   createdAt        : ms
//   entityRef        : { kind, id } | null   -- back-link to trip/aog/sr
//   lastMessage      : { text, senderUid, senderName, at, kind }
//   lastAt           : ms        -- denormalized for inbox ordering
//   readAt           : { [uid]: ms }   -- per-participant last-read marker
//   mutedBy          : uid[]
//   archived         : boolean
//
// conversations/{convId}/messages/{msgId}
//   senderUid, author, text, timestamp, attachments?, readBy?, deletedAt?
//
// LEGACY trip threads live at trips/{tripId}/messages — the existing 55-line
// firebase-chat.js owns that path. This module bridges legacy threads as
// virtual conversations so the inbox can show them alongside new ones with
// NO data migration.
//
// PERMISSIONS (operator's explicit decisions)
// -------------------------------------------
//   - All users can DM all users.
//   - Only role==='admin' can create groups.
//   - DMs are STRICTLY PRIVATE: only the two participants can read them.
//     Nobody (including admins) can read another user's DMs. The
//     canReadAllDms() function is retained as the single hook point and
//     always returns false; if this policy ever changes, it's a one-line
//     edit here, plus disclosure to users.
//   - Group conversations are visible only to their members.

import { db } from './firebase.js';
import {
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  arrayUnion,
  arrayRemove,
} from 'firebase/firestore';

/* ============================================================
   PERMISSIONS  (single source of truth — change in ONE place)
   ============================================================ */

export const ROLES = ['crew', 'sales', 'ops', 'maint', 'accounting', 'admin'];

// Anyone can DM anyone (user decision). Hook here if it ever narrows.
export function canDm(_fromUser, _toUser) {
  return true;
}

// Only admins create groups (user decision).
export function canCreateGroup(user) {
  return !!(user && user.role === 'admin');
}

// Read all DMs/groups — INTENTIONALLY DISABLED.
//
// Per the operator's explicit decision: nobody (including admins) reads
// another user's DMs or groups they are not a member of. This function
// always returns false. The flag is retained as the single hook point so
// any future change is a one-line edit here, and so unit tests can prove
// the lockdown.
export function canReadAllDms(_user) {
  return false;
}

// Is this user a participant in the conversation?
export function isParticipant(conv, uid) {
  return !!(conv && Array.isArray(conv.participants) && uid && conv.participants.includes(uid));
}

// Can this user open this conversation?
// Participants always can. Non-participants only if they have canReadAllDms.
// Trip/AOG/SR conversations are visible to anyone with access to that entity
// (governed by app-level access already; here we permit by default).
export function canOpenConversation(user, conv) {
  if (!user || !conv) return false;
  if (conv.kind === 'trip' || conv.kind === 'aog' || conv.kind === 'sr') return true;
  const uid = user.uid || user.id;
  if (isParticipant(conv, uid)) return true;
  return canReadAllDms(user);
}

/* ============================================================
   UTILITIES
   ============================================================ */

export function dmKey(uidA, uidB) {
  if (!uidA || !uidB) return null;
  return [String(uidA), String(uidB)].sort().join('::');
}

function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

function tsToMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds) return v.seconds * 1000;
  return 0;
}

function normalizeMessage(d) {
  const data = d.data();
  return {
    id: d.id,
    senderUid: data.senderUid || null,
    author: data.author || data.senderName || 'Unknown',
    text: data.text || '',
    timestamp: tsToMs(data.timestamp),
    attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
    readBy: Array.isArray(data.readBy) ? data.readBy : undefined,
    deletedAt: data.deletedAt ? tsToMs(data.deletedAt) : null,
  };
}

/* ============================================================
   CREATE / FIND CONVERSATIONS
   ============================================================ */

// Open (or create) a DM between two users. Idempotent via participantsKey:
// two users can only have ONE dm conversation between them.
export async function openOrCreateDm(fromUser, toUser) {
  if (!fromUser || !toUser) throw new Error('openOrCreateDm: both users required');
  if (!canDm(fromUser, toUser)) throw new Error('Not permitted to DM that user');
  const a = fromUser.uid || fromUser.id;
  const b = toUser.uid || toUser.id;
  if (!a || !b) throw new Error('openOrCreateDm: missing uid');
  if (a === b) throw new Error('Cannot DM yourself');
  const key = dmKey(a, b);

  const qy = query(
    collection(db, 'conversations'),
    where('kind', '==', 'dm'),
    where('participantsKey', '==', key),
    limit(1),
  );
  const snap = await getDocs(qy);
  if (!snap.empty) {
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  }
  const now = Date.now();
  const docRef = await addDoc(collection(db, 'conversations'), {
    kind: 'dm',
    participants: [a, b],
    participantsKey: key,
    title: null, // DMs render by the other participant's name client-side
    createdBy: a,
    createdAt: now,
    entityRef: null,
    lastMessage: null,
    lastAt: now,
    readAt: { [a]: now },
    mutedBy: [],
    archived: false,
  });
  return { id: docRef.id, kind: 'dm', participants: [a, b], participantsKey: key, createdAt: now, lastAt: now };
}

// Create a named group (admin only).
export async function createGroup(creator, title, memberUids) {
  if (!canCreateGroup(creator)) throw new Error('Only admins can create groups');
  const t = String(title || '').trim();
  if (!t) throw new Error('Group title required');
  const me = creator.uid || creator.id;
  const members = Array.from(new Set([me, ...(memberUids || []).map(String)])).filter(Boolean);
  if (members.length < 2) throw new Error('Group needs at least 2 members');
  const now = Date.now();
  const ref = await addDoc(collection(db, 'conversations'), {
    kind: 'group',
    participants: members,
    participantsKey: null,           // groups don't dedupe by participants
    title: t.slice(0, 80),
    createdBy: me,
    createdAt: now,
    entityRef: null,
    lastMessage: null,
    lastAt: now,
    readAt: { [me]: now },
    mutedBy: [],
    archived: false,
  });
  return ref.id;
}

export async function addGroupMembers(conv, memberUids, byUser) {
  if (!conv || conv.kind !== 'group') throw new Error('Not a group');
  if (!canCreateGroup(byUser)) throw new Error('Only admins can modify groups');
  const adds = (memberUids || []).map(String).filter(Boolean);
  if (!adds.length) return;
  await updateDoc(doc(db, 'conversations', conv.id), {
    participants: arrayUnion(...adds),
  });
}

export async function removeGroupMember(conv, uid, byUser) {
  if (!conv || conv.kind !== 'group') throw new Error('Not a group');
  if (!canCreateGroup(byUser) && (byUser.uid || byUser.id) !== uid) {
    throw new Error('Only admins or the leaving member can remove a member');
  }
  await updateDoc(doc(db, 'conversations', conv.id), {
    participants: arrayRemove(uid),
  });
}

export async function renameGroup(conv, newTitle, byUser) {
  if (!conv || conv.kind !== 'group') throw new Error('Not a group');
  if (!canCreateGroup(byUser)) throw new Error('Only admins can rename groups');
  const t = String(newTitle || '').trim().slice(0, 80);
  if (!t) throw new Error('Title required');
  await updateDoc(doc(db, 'conversations', conv.id), { title: t });
}

/* ============================================================
   SEND / SUBSCRIBE MESSAGES  (new conversations collection)
   ============================================================ */

export function subscribeToConversation(convId, onMessages) {
  const id = safeId(convId);
  const qy = query(
    collection(db, 'conversations', id, 'messages'),
    orderBy('timestamp', 'asc'),
    limit(500),
  );
  return onSnapshot(
    qy,
    (snap) => {
      const out = [];
      snap.forEach((d) => out.push(normalizeMessage(d)));
      onMessages(out);
    },
    (err) => { console.error('[comms] subscribeToConversation:', err); onMessages([]); },
  );
}

export async function sendMessage(convId, sender, text, opts = {}) {
  const id = safeId(convId);
  const t = String(text || '').trim();
  if (!t && !(opts.attachments && opts.attachments.length)) return null;
  const senderUid = sender.uid || sender.id || null;
  const senderName = sender.name || sender.displayName || sender.email || 'Unknown';
  const now = Date.now();
  const msgRef = await addDoc(collection(db, 'conversations', id, 'messages'), {
    senderUid,
    author: senderName,
    text: t,
    timestamp: serverTimestamp(),
    attachments: opts.attachments || null,
    readBy: senderUid ? [senderUid] : [],
  });
  await updateDoc(doc(db, 'conversations', id), {
    lastMessage: { text: t.slice(0, 240), senderUid, senderName, at: now, kind: 'text' },
    lastAt: now,
    [`readAt.${senderUid || 'unknown'}`]: now,
  }).catch((e) => console.warn('[comms] lastMessage update failed:', e));

  // Fire push dispatch in the background. NEVER awaited — chat must stay
  // fast even if the push endpoint is slow or down. All filtering happens
  // server-side in api/send-push.js (quiet hours, mute, AOG override,
  // self-skip). Skipped entirely when an admin is impersonating another
  // user: the Firebase Auth token is still the admin's, while sender.uid
  // is the impersonated user's, so the server would (correctly) reject
  // the dispatch as a uid mismatch. The chat message itself still posts.
  if (!sender._impersonating) {
    (async () => {
      try {
        const { auth } = await import('./firebase.js');
        const currentAuthUser = auth.currentUser;
        if (!currentAuthUser) return;
        const idToken = await currentAuthUser.getIdToken();
        await fetch('/api/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            conversationId: id,
            message: { text: t, senderUid, senderName },
            isAog: opts.isAog || false,
          }),
        });
      } catch (e) {
        console.warn('[comms] push dispatch failed (non-fatal):', e);
      }
    })();
  }

  return msgRef.id;
}

export async function markRead(convId, userUid, lastSeenTs = Date.now()) {
  if (!convId || !userUid) return;
  await updateDoc(doc(db, 'conversations', safeId(convId)), {
    [`readAt.${userUid}`]: lastSeenTs,
  }).catch(() => { /* missing-conv is non-fatal */ });
}

// Soft-delete: keep the doc for the operational record (your aviation context
// argues against hard-delete in operational threads). UI hides the body.
export async function softDeleteMessage(convId, msgId, byUser) {
  await updateDoc(doc(db, 'conversations', safeId(convId), 'messages', safeId(msgId)), {
    deletedAt: serverTimestamp(),
    deletedBy: byUser?.uid || byUser?.id || null,
  });
}

/* ============================================================
   TYPING PRESENCE
   Each conversation has a `typing/{uid}` doc with an `at` ms
   timestamp. Clients write while the user is typing (debounced)
   and clear when they stop. Subscribers filter for entries newer
   than TYPING_FRESHNESS_MS so stale presence (closed tab, crashed
   client) ages out naturally without a server cleanup job.
   ============================================================ */

export const TYPING_FRESHNESS_MS = 6000;   // entries older than this are ignored

export async function setTyping(convId, user, isTyping) {
  if (!convId || !user) return;
  const uid = user.uid || user.id;
  if (!uid) return;
  const ref = doc(db, 'conversations', safeId(convId), 'typing', uid);
  if (isTyping) {
    try {
      await setDoc(ref, {
        uid,
        name: user.name || user.displayName || user.email || 'Someone',
        at: Date.now(),
      });
    } catch (e) { /* non-fatal */ }
  } else {
    // Best-effort clear; if the doc never existed, the delete failure is
    // ignored — we just don't want stale presence.
    try {
      await deleteDoc(ref);
    } catch (e) { /* non-fatal */ }
  }
}

export function subscribeTyping(convId, currentUid, onUpdate) {
  if (!convId) { onUpdate([]); return () => {}; }
  const qy = query(collection(db, 'conversations', safeId(convId), 'typing'));
  return onSnapshot(
    qy,
    (snap) => {
      const cutoff = Date.now() - TYPING_FRESHNESS_MS;
      const names = [];
      snap.forEach((d) => {
        const v = d.data();
        if (v.uid === currentUid) return;       // never show "I am typing"
        if ((v.at || 0) >= cutoff) names.push(v.name || 'Someone');
      });
      onUpdate(names);
    },
    (err) => { console.error('[comms] subscribeTyping:', err); onUpdate([]); },
  );
}

/* ============================================================
   READ RECEIPTS — per message
   When the viewer opens a conversation, every message they
   haven't acknowledged is marked read by appending their uid to
   readBy. BubbleChat already renders ✓✓ when readBy contains a
   non-self uid for "my" messages.
   ============================================================ */

export async function markMessagesRead(convId, messages, viewerUid) {
  if (!convId || !viewerUid || !Array.isArray(messages) || messages.length === 0) return;
  const writes = [];
  for (const m of messages) {
    if (!m || !m.id) continue;
    if (m.senderUid === viewerUid) continue;            // my own messages — skip
    if (Array.isArray(m.readBy) && m.readBy.includes(viewerUid)) continue; // already marked
    writes.push(
      updateDoc(
        doc(db, 'conversations', safeId(convId), 'messages', safeId(m.id)),
        { readBy: arrayUnion(viewerUid) },
      ).catch(() => { /* non-fatal: a missing/stale msg won't block the rest */ }),
    );
  }
  if (writes.length) await Promise.all(writes);
}

/* ============================================================
   INBOX: subscribe to all conversations the user can see.
   Merges:
     - new conversations/{} where participants contains uid
     - if canReadAllDms: ALSO every dm + group in the collection
       (and every such read is audit-logged on open, NOT on listing)
   ============================================================ */

export function subscribeInboxFor(user, onUpdate) {
  if (!user) { onUpdate([]); return () => {}; }
  const uid = user.uid || user.id;

  const myConvsQ = query(
    collection(db, 'conversations'),
    where('participants', 'array-contains', uid),
  );
  return onSnapshot(
    myConvsQ,
    (snap) => {
      const list = [];
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
      const out = list
        .filter((c) => !c.archived)
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      onUpdate(out);
    },
    (err) => { console.error('[comms] inbox:', err); onUpdate([]); },
  );
}

/* ============================================================
   LEGACY BRIDGE: existing trip/AOG threads as conversations
   The current 55-line firebase-chat.js stores trip messages at
   trips/{tripId}/messages. We expose them as virtual conversations
   so the Comms inbox can show them alongside new ones, NO data
   migration required.
   ============================================================ */

export function legacyTripConvId(tripId) { return `trip:${safeId(tripId)}`; }

export function subscribeLegacyTripThread(tripId, onMessages) {
  const id = safeId(tripId);
  const qy = query(
    collection(db, 'trips', id, 'messages'),
    orderBy('timestamp', 'asc'),
    limit(500),
  );
  return onSnapshot(
    qy,
    (snap) => {
      const out = [];
      snap.forEach((d) => {
        const data = d.data();
        out.push({
          id: d.id,
          senderUid: data.senderUid || null,
          author: data.author || 'Unknown',
          text: data.text || '',
          timestamp: tsToMs(data.timestamp),
          attachments: Array.isArray(data.attachments) ? data.attachments : undefined,
          deletedAt: data.deletedAt ? tsToMs(data.deletedAt) : null,
          deletedBy: data.deletedBy || null,
        });
      });
      onMessages(out);
    },
    (err) => { console.error('[comms] legacy trip thread:', err); onMessages([]); },
  );
}

// Write to the existing trips/{id}/messages path so legacy threads keep
// working unchanged after we drop BubbleChat in. Now accepts attachments
// via opts (storage upload happens at the call site).
export async function sendLegacyTripMessage(tripId, sender, text, opts = {}) {
  const id = safeId(tripId);
  const t = String(text || '').trim();
  if (!t && !(opts.attachments && opts.attachments.length)) return null;
  const senderUid = sender.uid || sender.id || null;
  const senderName = sender.name || sender.displayName || 'Unknown';
  const ref = await addDoc(collection(db, 'trips', id, 'messages'), {
    author: senderName,
    senderUid,
    text: t,
    timestamp: serverTimestamp(),
    attachments: opts.attachments || null,
  });

  // Fire push dispatch — same fire-and-forget pattern as sendMessage.
  // Skipped during impersonation (sender's auth token uid won't match
  // the impersonated sender.uid, so the server would reject; chat write
  // itself still posts). Server resolves PIC/SIC/ops recipients itself.
  if (!sender._impersonating) {
    (async () => {
      try {
        const { auth } = await import('./firebase.js');
        const currentAuthUser = auth.currentUser;
        if (!currentAuthUser) return;
        const idToken = await currentAuthUser.getIdToken();
        await fetch('/api/send-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            tripId: id,
            // pic/sic/tail are passed in so the server can resolve
            // recipients for iCal trips that have no Firestore doc.
            tripPicName: opts.tripPicName || '',
            tripSicName: opts.tripSicName || '',
            tripTail: opts.tripTail || '',
            message: { text: t, senderUid, senderName },
            isAog: opts.isAog || false,
          }),
        });
      } catch (e) {
        console.warn('[comms] trip push dispatch failed (non-fatal):', e);
      }
    })();
  }

  return ref.id;
}

// Soft-delete a trip message. Caller is responsible for permission check
// (sender or admin); the rules layer also enforces it.
export async function softDeleteLegacyTripMessage(tripId, msgId, byUser) {
  const tid = safeId(tripId);
  const mid = safeId(msgId);
  await updateDoc(doc(db, 'trips', tid, 'messages', mid), {
    deletedAt: serverTimestamp(),
    deletedBy: byUser?.uid || byUser?.id || null,
  });
}
