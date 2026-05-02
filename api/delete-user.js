// Vercel serverless function: delete a user from Firebase Auth + Firestore.
//
// This requires the Firebase Admin SDK with privileged credentials (a service
// account key). The client SDK cannot delete other users' Auth accounts —
// only the user themselves can self-delete. So this endpoint exists.
//
// Required environment variables (all set in Vercel project settings):
//   FIREBASE_SERVICE_ACCOUNT_JSON — full JSON of service account key
//
// To generate the service account key:
//   1. Firebase Console → Project Settings → Service Accounts tab
//   2. Click "Generate new private key" → confirm
//   3. JSON file downloads. Open it.
//   4. Copy the ENTIRE JSON content (starts with { "type": "service_account", ... })
//   5. In Vercel: Settings → Environment Variables → Add new
//        Name:  FIREBASE_SERVICE_ACCOUNT_JSON
//        Value: paste the full JSON
//        Apply to: Production, Preview, Development
//   6. Redeploy
//
// Body shape:
//   { idToken: '...', targetUid: '...' }
//
// idToken is the Firebase ID token of the CALLER (admin/ops). Frontend gets it
// via auth.currentUser.getIdToken(). This proves the caller is who they say.
//
// targetUid is the UID of the user to delete.
//
// Returns { ok: true } on success, error otherwise.

export const config = { runtime: 'nodejs' };

let cachedAdmin = null;

async function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const admin = await import('firebase-admin');
  if (!admin.apps || admin.apps.length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured on server');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    admin.default.initializeApp({
      credential: admin.default.credential.cert(parsed),
    });
  }
  cachedAdmin = admin.default;
  return cachedAdmin;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { idToken, targetUid } = body;
  if (!idToken || !targetUid) {
    return res.status(400).json({ error: 'Missing idToken or targetUid' });
  }

  try {
    const admin = await getAdmin();

    // 1. Verify the caller's ID token — this confirms they're authenticated
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid auth token' });
    }
    const callerUid = decoded.uid;

    // 2. Look up the caller's profile in Firestore to verify they have
    //    permission to delete users. Required role: 'ops' or 'admin'.
    //    Database is named `appusers` (NOT default), users collection is `users`.
    const db = admin.firestore();
    // Use the named database
    db.settings({ databaseId: 'appusers' });
    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists) {
      return res.status(403).json({ error: 'Caller has no profile' });
    }
    const callerRole = callerDoc.data()?.role;
    if (!['ops', 'admin'].includes(callerRole)) {
      return res.status(403).json({ error: 'Insufficient permissions — ops or admin only' });
    }

    // 3. Prevent self-delete (admins shouldn't accidentally lock themselves out)
    if (callerUid === targetUid) {
      return res.status(400).json({ error: 'Cannot delete your own account from this endpoint' });
    }

    // 4. Delete from Firebase Auth (best-effort — if user is already gone there,
    //    we still want to delete the Firestore profile)
    let authDeleted = true;
    let authError = null;
    try {
      await admin.auth().deleteUser(targetUid);
    } catch (err) {
      authDeleted = false;
      authError = err.message;
      // user-not-found is fine — already gone
      if (err.code !== 'auth/user-not-found') {
        console.warn('[delete-user] Auth delete failed:', err.code, err.message);
      }
    }

    // 5. Delete from Firestore users collection
    let firestoreDeleted = true;
    let firestoreError = null;
    try {
      await db.collection('users').doc(targetUid).delete();
    } catch (err) {
      firestoreDeleted = false;
      firestoreError = err.message;
      console.warn('[delete-user] Firestore delete failed:', err.message);
    }

    console.log(`[delete-user] caller=${callerUid} target=${targetUid} auth=${authDeleted} firestore=${firestoreDeleted}`);

    return res.status(200).json({
      ok: authDeleted && firestoreDeleted,
      authDeleted,
      firestoreDeleted,
      authError,
      firestoreError,
    });
  } catch (err) {
    console.error('[delete-user] Server error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
