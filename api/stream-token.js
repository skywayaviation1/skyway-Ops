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

    // BULK SYNC ALL APPROVED USERS to Stream so they can be channel members.
    //
    // Stream requires every user added to a channel to exist as a Stream
    // user first. Without this, the first person who hasn't signed into
    // chat yet would 404 the channel-create call ("users don't exist:
    // [uid]"). Symptoms: "Could not start DM" errors when picking certain
    // teammates, and silent failures in useEnsureTripChannels for trips
    // whose PIC/SIC haven't joined chat.
    //
    // Running this on every token fetch means any new user added to
    // Skyway gets synced to Stream as soon as ANYONE signs into chat
    // next. Cheap (<30 users for Skyway, batched up to 100 per call).
    // Wrapped in try/catch so a sync failure doesn't block the caller
    // from getting their token — degraded experience > total outage.
    try {
      const allUsersSnap = await db.collection('users').get();
      const toSync = [];
      allUsersSnap.forEach((doc) => {
        const d = doc.data();
        const otherUid = d.uid || doc.id;
        if (!otherUid) return;
        if (otherUid === uid) return;     // already upserted above
        if (d.approved === false) return; // explicitly unapproved — skip
        toSync.push({
          id: otherUid,
          name: d.name || d.email || otherUid,
          email: d.email || '',
          role: d.role === 'admin' ? 'admin' : 'user',
          skyway_role: d.role || 'crew',
        });
      });
      // Stream's upsertUsers takes up to 100 users per call
      const BATCH_SIZE = 100;
      for (let i = 0; i < toSync.length; i += BATCH_SIZE) {
        const batch = toSync.slice(i, i + BATCH_SIZE);
        await stream.upsertUsers(batch);
      }
      console.log(`[stream-token] bulk-synced ${toSync.length} users to Stream`);
    } catch (err) {
      // Non-fatal — log it and continue. Caller still gets their token.
      // Worst case: some channel creations will fail with "users don't
      // exist" until the next successful sync.
      console.warn('[stream-token] bulk user sync failed (non-fatal):', err?.message || err);
    }

    // Bulk-upsert every OTHER approved Skyway user so DMs and trip
    // channels can reference them without "user doesn't exist" errors
    // from Stream. Before this, the only Stream user that existed was
    // whoever had signed in to the chat themselves — meaning the first
    // person to try DMing anyone got the GetOrCreateChannel error.
    //
    // For Skyway's scale (~25 users) this is one Firestore read + one
    // Stream API call per token mint. Negligible cost, and Stream's
    // upsertUsers is idempotent so syncing the full roster every time
    // is safe — name changes in Firebase propagate automatically.
    try {
      const rosterSnap = await db.collection('users').get();
      const otherUsers = rosterSnap.docs
        .filter(d => d.id !== uid)
        .map(d => {
          const data = d.data() || {};
          // Skip not-yet-approved signups — they shouldn't show up in the
          // user picker for new DMs. We sync them on their own first
          // token mint once approved.
          if (data.approved === false) return null;
          // Skip docs missing required fields (defensive — shouldn't
          // happen in production but a malformed row would 400 the whole
          // batch and that's worse than excluding one user).
          if (!data.name && !data.email) return null;
          return {
            id: d.id,
            name: data.name || data.email || d.id,
            email: data.email || '',
            role: data.role === 'admin' ? 'admin' : 'user',
            skyway_role: data.role || 'crew',
          };
        })
        .filter(Boolean);

      if (otherUsers.length > 0) {
        // Stream's bulk upsert accepts up to 100 users per call; Skyway is
        // well under that. If the roster ever exceeds 100, batch this loop.
        await stream.upsertUsers(otherUsers);
        console.log(`[stream-token] synced ${otherUsers.length} other users to Stream`);
      }
    } catch (rosterErr) {
      // Roster sync failure shouldn't block the caller's own token mint —
      // they can still see their own channels. Log and continue.
      console.warn('[stream-token] roster sync failed (non-fatal):', rosterErr.message);
    }

    // Bulk-upsert ALL approved Skyway users into Stream. Without this, DMs
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
      if (streamUsers.length > 0) {
        await stream.upsertUsers(streamUsers);
        console.log(`[stream-token] bulk-upserted ${streamUsers.length} approved users`);
      }
    } catch (err) {
      // Failure here doesn't block the caller's token. They just may hit
      // the DM-create error again until the next successful sync.
      console.warn('[stream-token] bulk user sync failed (non-fatal):', err.message);
    }

    // Mint a long-lived token. Default no expiry — frontend stores it in
    // memory only (not localStorage) so it's lost on tab close anyway.
    const token = stream.createToken(uid);

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
