// api/stream-token.js
//
// Mints a Stream Chat user token from a Firebase idToken. The Stream API
// secret never leaves the server — clients call this proxy endpoint
// instead, then use the returned token to initialize the Stream client.
//
// Stream users are keyed by Firebase UID, so a single account system flows
// from Firebase Auth into Stream Chat — no duplicate user records.
//
// Request:  POST { idToken: "<firebase-id-token>" }
// Response: { ok, token, apiKey, user: { id, name } }
//
// Env vars required on Vercel:
//   STREAM_API_KEY     — from Stream dashboard, safe to ship to clients
//   STREAM_API_SECRET  — from Stream dashboard, SERVER ONLY
//   FIREBASE_SERVICE_ACCOUNT_JSON — already exists for other endpoints

import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { StreamChat } from 'stream-chat';

let _adminApp = null;
let _db = null;
let _streamClient = null;

function getAdmin() {
  if (_adminApp) return _adminApp;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured');
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  _adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return _adminApp;
}

function getDb() {
  if (_db) return _db;
  _db = getFirestore(getAdmin(), 'appusers');
  return _db;
}

function getStream() {
  if (_streamClient) return _streamClient;
  const apiKey = process.env.STREAM_API_KEY;
  const apiSecret = process.env.STREAM_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('Stream Chat API key/secret not configured');
  }
  _streamClient = StreamChat.getInstance(apiKey, apiSecret);
  return _streamClient;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      res.status(400).json({ error: 'idToken required' });
      return;
    }

    // Verify Firebase auth
    getAdmin();
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      res.status(401).json({ error: 'Invalid idToken: ' + err.message });
      return;
    }
    const uid = decoded.uid;

    // Pull profile for name/role — Stream user object mirrors Firebase profile
    const db = getDb();
    const profileSnap = await db.collection('users').doc(uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};

    // Approval gate — same as the rest of the app. Unapproved users get no
    // Stream token, so they can't lurk in chat before an admin lets them in.
    if (profile && profile.approved === false) {
      res.status(403).json({ error: 'Account pending approval' });
      return;
    }

    // Upsert the Stream user. Stream needs name/image to display in lists;
    // we sync from Firebase profile each call so a name change in Firebase
    // propagates to Stream automatically on the next sign-in.
    const stream = getStream();
    await stream.upsertUser({
      id: uid,
      name: profile.name || decoded.email || uid,
      email: profile.email || decoded.email || '',
      // Stream's built-in role used for permissions on default channel types.
      // Anyone with Firebase role admin gets Stream admin (can edit/delete
      // any message, manage members). Everyone else is a regular user.
      role: profile.role === 'admin' ? 'admin' : 'user',
      // Skyway-specific role exposed as custom field — used in CommsStream
      // to gate certain UI bits (e.g. only ops/admin see the team channel
      // configuration controls).
      skyway_role: profile.role || 'crew',
    });

    // Bulk-upsert all approved Skyway users into Stream. Without this, DMs
    // and group channels fail when a recipient hasn't signed into chat yet
    // because Stream rejects channel creation with users that don't exist
    // ("StreamChat error code 4: GetOrCreateChannel failed with error: The
    // following users are involved in channel create operation, but don't
    // exist"). One Stream API call covers up to 100 users, idempotent —
    // updates names if they changed, no-ops otherwise. ~30 users for
    // Skyway, ~200ms total overhead per token mint. Non-fatal if it
    // fails; the caller still gets their token.
    try {
      const allUsersSnap = await db.collection('users').get();
      const streamUsers = [];
      allUsersSnap.forEach((doc) => {
        const u = doc.data() || {};
        const otherUid = u.uid || doc.id;
        if (!otherUid) return;
        if (u.approved === false) return;        // skip explicitly unapproved
        if (otherUid === uid) return;            // already upserted above
        streamUsers.push({
          id: otherUid,
          name: u.name || u.email || otherUid,
          email: u.email || '',
          role: u.role === 'admin' ? 'admin' : 'user',
          skyway_role: u.role || 'crew',
        });
      });
      const BATCH_SIZE = 100;
      for (let i = 0; i < streamUsers.length; i += BATCH_SIZE) {
        await stream.upsertUsers(streamUsers.slice(i, i + BATCH_SIZE));
      }
      console.log(`[stream-token] bulk-upserted ${streamUsers.length} approved users`);
    } catch (err) {
      // Failure here doesn't block the caller's token. They just may hit
      // the DM-create error again until the next successful sync.
      console.warn('[stream-token] bulk user sync failed (non-fatal):', err.message);
    }

    // Keep the token short-lived. Firebase remains the source of truth; an
    // account disabled there should not retain a permanently valid Stream
    // credential captured from an old browser session.
    const expiresAt = Math.floor(Date.now() / 1000) + (12 * 60 * 60);
    const token = stream.createToken(uid, expiresAt);

    res.status(200).json({
      ok: true,
      token,
      apiKey: process.env.STREAM_API_KEY,
      user: {
        id: uid,
        name: profile.name || decoded.email || uid,
        role: profile.role || 'crew',
      },
    });
  } catch (err) {
    console.error('[stream-token] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
