import { auth } from './firebase.js';

async function post(path) {
  if (!auth.currentUser) throw new Error('Must be signed in');
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ idToken }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export async function buildUserMailOAuthUrl() {
  const data = await post('/api/user-mail-oauth-start');
  if (!data.authUrl) throw new Error('Microsoft did not return an authorization URL');
  return data.authUrl;
}

export function disconnectUserMailbox() {
  return post('/api/user-mail-disconnect');
}
