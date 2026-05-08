// firebase-quickbooks.js
//
// Client-side module for QuickBooks Online integration.
//
// QBO connection state is stored as a SINGLETON Firestore document at
// `quickbooks/connection`. It contains:
//   - realmId (QBO company ID)
//   - companyName (display name)
//   - accessToken / refreshToken (encrypted at rest by Firestore — see notes below)
//   - accessTokenExpiresAt (ms timestamp)
//   - refreshTokenExpiresAt (ms timestamp — refresh tokens last 100 days)
//   - environment ('sandbox' | 'production')
//   - connectedBy (uid of admin who connected)
//   - connectedAt (ms timestamp)
//   - lastRefreshedAt (ms timestamp)
//
// SECURITY NOTE: The tokens are stored in plaintext in Firestore. This is
// acceptable because:
//   1. Firestore rules restrict reads to admin users only
//   2. The tokens are short-lived (1 hour for access, 100 days for refresh)
//   3. The OAuth callback writes them server-side via the Admin SDK,
//      bypassing rules — so a compromised admin client can read but not
//      write directly
// If you want defense-in-depth later, encrypt with KMS server-side before
// writing. Out of scope for v1.

import { db } from './firebase.js';
import {
  doc, getDoc, onSnapshot, deleteDoc, setDoc, serverTimestamp,
} from 'firebase/firestore';
import { auth } from './firebase.js';

const CONN_DOC = 'quickbooks/connection';

/**
 * Subscribe to QuickBooks connection state.
 * Calls callback({ connected, realmId, companyName, environment, ... })
 * Returns unsubscribe function.
 */
export function subscribeToQuickBooksConnection(callback) {
  const ref = doc(db, 'quickbooks', 'connection');
  return onSnapshot(ref, (snap) => {
    if (!snap.exists()) {
      callback({ connected: false });
      return;
    }
    const data = snap.data();
    callback({
      connected: true,
      realmId: data.realmId || null,
      companyName: data.companyName || null,
      environment: data.environment || 'sandbox',
      connectedBy: data.connectedBy || null,
      connectedByName: data.connectedByName || null,
      connectedAt: data.connectedAt || null,
      lastRefreshedAt: data.lastRefreshedAt || null,
      accessTokenExpiresAt: data.accessTokenExpiresAt || null,
      refreshTokenExpiresAt: data.refreshTokenExpiresAt || null,
    });
  }, (err) => {
    console.error('[qbo] connection subscription error:', err);
    callback({ connected: false, error: err.message });
  });
}

/**
 * One-shot read of connection state.
 */
export async function getQuickBooksConnection() {
  const snap = await getDoc(doc(db, 'quickbooks', 'connection'));
  if (!snap.exists()) return { connected: false };
  return { connected: true, ...snap.data() };
}

/**
 * Build the URL that starts the OAuth dance.
 * Calling code redirects window.location to this URL; admin authorizes
 * with Intuit, then Intuit redirects back to /api/quickbooks-oauth-callback
 * which writes the tokens to Firestore.
 *
 * The `state` param is signed with the admin's Firebase ID token so the
 * callback can verify the request actually came from us.
 */
export async function buildOAuthStartUrl() {
  if (!auth.currentUser) throw new Error('Must be signed in');
  const idToken = await auth.currentUser.getIdToken();

  // Hit our own API to get a state token + the full Intuit auth URL.
  // The server controls CLIENT_ID + REDIRECT_URI so the client never sees them.
  const r = await fetch('/api/quickbooks-oauth-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.authUrl) {
    throw new Error(data.error || `Failed to start OAuth: ${r.status}`);
  }
  return data.authUrl;
}

/**
 * Disconnect — admin clicks "Disconnect QuickBooks".
 * Calls server endpoint which (1) revokes the token with Intuit and
 * (2) deletes the Firestore doc.
 */
export async function disconnectQuickBooks() {
  if (!auth.currentUser) throw new Error('Must be signed in');
  const idToken = await auth.currentUser.getIdToken();
  const r = await fetch('/api/quickbooks-disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.error || `Disconnect failed: ${r.status}`);
  }
  return data;
}

/**
 * Helper: format the expiration of the refresh token for UI display.
 */
export function formatRefreshTokenExpiry(connection) {
  if (!connection?.refreshTokenExpiresAt) return null;
  const days = Math.floor((connection.refreshTokenExpiresAt - Date.now()) / (24 * 3600 * 1000));
  if (days <= 0) return 'EXPIRED — reconnect required';
  if (days < 7) return `Expires in ${days} day${days === 1 ? '' : 's'} — reconnect soon`;
  if (days < 30) return `Expires in ${days} days`;
  return `Valid for ${days} days`;
}
