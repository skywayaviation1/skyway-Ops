import { next, rewrite } from '@vercel/edge';

/* The marketing site and the operations app ship in one deployment, and the
 * host-based rewrites in vercel.json route every marketing sub-path. They
 * cannot route "/" though: Vercel evaluates `rewrites` only after the
 * filesystem, and the app's own index.html already matches "/", so the
 * marketing domain fell through to the app's login screen.
 *
 * Middleware runs before the filesystem, so this is the one place the
 * marketing homepage can win that path. The matcher is deliberately limited to
 * the root document — no other application route is affected.
 */
export const config = { matcher: ['/', '/index.html'] };

const MARKETING_HOSTS = new Set([
  '135ops.app',
  'www.135ops.app',
  // TEMPORARY: proving middleware claims "/" on Vercel. Removed after testing.
  'skyway-ops-wv8r-git-cursor-mar-617c69-skywayaviation1s-projects.vercel.app',
]);

export default function middleware(request) {
  try {
    const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
    if (MARKETING_HOSTS.has(host)) {
      return rewrite(new URL('/marketing/index.html', request.url));
    }
  } catch {
    // A routing preference must never take down the app's entry point.
  }
  return next();
}
