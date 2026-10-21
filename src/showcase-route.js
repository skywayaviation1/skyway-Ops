// Route check for the public trade-show TV. Kept out of showcase-replay.js
// so the signed-in app can decide the route without evaluating the replay
// scheduler or the map toolkit.

/** `/showcase` and `/showcase/<token>` are the public TV route. Anything else is null. */
export function parseShowcasePath(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  if (path !== '/showcase' && !path.startsWith('/showcase/')) return null;
  if (path === '/showcase') return { token: '' };
  let token = path.slice('/showcase/'.length);
  try { token = decodeURIComponent(token); } catch { /* keep the raw segment */ }
  if (token.includes('/')) return { token: '' };
  return { token };
}
