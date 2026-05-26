// /api/gif-search.js
//
// Proxies GIF search requests to the KLIPY API so the API key stays
// server-side and isn't shipped in the client bundle.
//
// Why KLIPY (May 2026): Google announced January 2026 that the Tenor API
// is being discontinued — new registrations stopped Jan 13, 2026; the
// API goes dark June 30, 2026. KLIPY is the recommended migration path,
// built by ex-Tenor employees with a near-identical API surface.
//
// KLIPY base URL pattern (note: API key is in the path, not a query):
//   https://api.klipy.com/api/v1/{API_KEY}/gifs/search?q=...&per_page=...
//   https://api.klipy.com/api/v1/{API_KEY}/gifs/trending?per_page=...
//
// Endpoints (selected via ?action=...):
//   ?action=search&q=happy&limit=24     → search results for query "happy"
//   ?action=trending&limit=24           → trending GIFs (shown before user types)
//
// Auth: requires Firebase idToken (same pattern as other internal APIs).
// Without the KLIPY_API_KEY env var, returns 503 with an actionable error.
//
// Response shape (consistent for both actions):
//   {
//     ok: true,
//     gifs: [
//       {
//         id:        string,           // KLIPY ID, used as React key
//         name:      string,           // text description for alt/screen readers
//         url:       string,           // full-size GIF URL (the one to send)
//         previewUrl:string,           // smaller preview for the picker grid
//         width:     number,
//         height:    number,
//       },
//       ...
//     ]
//   }

import admin from 'firebase-admin';

export const config = { runtime: 'nodejs' };

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}

async function authorize(req) {
  // Internal secret bypass for cron / server-to-server calls (not used here
  // but kept for consistency with other endpoints).
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) return true;
  const idToken = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.idToken;
  if (idToken) {
    try { await admin.auth(getAdmin()).verifyIdToken(idToken); return true; }
    catch (_) { return false; }
  }
  return false;
}

// KLIPY's media live at `item.file.{size}.{format}` where:
//   size   = 'hd' | 'md' | 'sm' | 'xs'   (largest to smallest)
//   format = 'gif' | 'webp' | 'jpg' | 'mp4' | 'webm'
//   each leaf = { url, width, height, size }
//
// We pick by walking preferred sizes, then preferred formats within each
// size, and return the first { url, width, height } we find. The field is
// `file` (singular) — earlier guesses at `files` were wrong.
//
// Why prefer webp over gif for browser embed:
//   - webp is roughly 1/10th the byte size of gif (see real numbers in the
//     KLIPY response: 576KB gif vs 60KB webp for the same content)
//   - all browsers we care about support webp animation
//   - the chat embeds <img> tags which handle webp natively
// We DO use gif as a fallback in case any future content lacks webp.
function pickFile(fileObj, sizesPrefer, formatsPrefer) {
  if (!fileObj || typeof fileObj !== 'object') return null;
  for (const size of sizesPrefer) {
    const sizeObj = fileObj[size];
    if (!sizeObj || typeof sizeObj !== 'object') continue;
    for (const fmt of formatsPrefer) {
      const leaf = sizeObj[fmt];
      if (leaf && typeof leaf === 'object' && leaf.url) {
        return {
          url: String(leaf.url),
          width: Number(leaf.width) || 0,
          height: Number(leaf.height) || 0,
        };
      }
    }
  }
  // Last-ditch: walk any size/format combination for any url
  for (const size of Object.keys(fileObj)) {
    const sizeObj = fileObj[size];
    if (!sizeObj || typeof sizeObj !== 'object') continue;
    for (const fmt of Object.keys(sizeObj)) {
      const leaf = sizeObj[fmt];
      if (leaf && typeof leaf === 'object' && leaf.url) {
        return {
          url: String(leaf.url),
          width: Number(leaf.width) || 0,
          height: Number(leaf.height) || 0,
        };
      }
    }
  }
  return null;
}

// Reshape KLIPY's response into our consistent client-facing shape.
function normalize(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    // Filter ad placements — chat composer doesn't surface ads.
    if (item.ad === true || item.is_ad === true) continue;
    // Full-size for embedding in the chat: prefer webp (much smaller),
    // fall back to gif. Use hd→md size since the grid renders at most
    // ~320px wide; even md is plenty for a chat bubble.
    const full = pickFile(item.file, ['hd', 'md', 'sm', 'xs'], ['webp', 'gif']);
    // Preview for the picker grid: prefer smallest size for fast loading.
    // The grid shows lots of GIFs at once; using `xs` keeps the picker
    // snappy. Same format preference.
    const preview = pickFile(item.file, ['xs', 'sm', 'md', 'hd'], ['webp', 'gif']) || full;
    if (!full?.url) continue;
    out.push({
      id: String(item.id || item.slug || `${out.length}-${full.url.slice(-12)}`),
      name: String(item.title || item.alt || item.description || 'GIF').slice(0, 120),
      url: full.url,
      previewUrl: preview?.url || full.url,
      width: full.width,
      height: full.height,
    });
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'GET only' });
    return;
  }

  const ok = await authorize(req);
  if (!ok) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  // Accept either KLIPY_API_KEY (new) or TENOR_API_KEY (legacy from earlier
  // setup) so an in-progress migration doesn't break. Prefer KLIPY.
  const apiKey = process.env.KLIPY_API_KEY || process.env.TENOR_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      ok: false,
      error: 'GIFs are not configured on this deployment. An admin needs to set KLIPY_API_KEY in Vercel env vars (get a key at https://klipy.com/developers).',
      code: 'klipy-not-configured',
    });
    return;
  }

  const action = String(req.query.action || 'search');
  const limit = Math.max(8, Math.min(50, Number(req.query.limit) || 24)); // KLIPY: min 8, max 50

  let klipyUrl;
  if (action === 'trending') {
    klipyUrl = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/gifs/trending`);
  } else if (action === 'search') {
    const q = String(req.query.q || '').slice(0, 100);
    if (!q.trim()) {
      res.status(400).json({ ok: false, error: 'Query (q) required for search' });
      return;
    }
    klipyUrl = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/gifs/search`);
    klipyUrl.searchParams.set('q', q);
  } else {
    res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    return;
  }
  klipyUrl.searchParams.set('per_page', String(limit));
  // SFW filter — KLIPY uses g, pg, pg-13, r. 'g' is strictest, appropriate for a work app.
  klipyUrl.searchParams.set('rating', 'pg-13');

  try {
    const r = await fetch(klipyUrl.toString());
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[gif-search] KLIPY error:', r.status, body.slice(0, 500));
      if (r.status === 401 || r.status === 403) {
        res.status(503).json({
          ok: false,
          error: 'KLIPY rejected the API key. Verify KLIPY_API_KEY is correct in Vercel env vars.',
          code: 'klipy-key-invalid',
        });
        return;
      }
      if (r.status === 429) {
        res.status(503).json({
          ok: false,
          error: 'KLIPY rate limit hit (test keys: 100/min). Wait a moment and try again, or request production access at klipy.com/developers.',
          code: 'klipy-rate-limit',
        });
        return;
      }
      res.status(502).json({ ok: false, error: `KLIPY returned ${r.status}` });
      return;
    }
    const data = await r.json();
    // KLIPY response shape: { result: true, data: { data: [...], current_page, per_page, has_next } }
    // We accept a few shape variations defensively in case the API evolves.
    let items = null;
    if (Array.isArray(data?.data?.data)) items = data.data.data;
    else if (Array.isArray(data?.data)) items = data.data;
    else if (Array.isArray(data?.results)) items = data.results;
    else if (Array.isArray(data)) items = data;
    if (!items) {
      console.error('[gif-search] Unexpected KLIPY response shape:', JSON.stringify(data).slice(0, 500));
      res.status(502).json({ ok: false, error: 'Unexpected GIF service response shape' });
      return;
    }
    const gifs = normalize(items);
    // If KLIPY returned items but normalize dropped them all, log the first
    // raw item so we can fix the `pickFormat` logic in a future deploy.
    if (items.length > 0 && gifs.length === 0) {
      console.warn('[gif-search] KLIPY items found but none normalized. First raw item:', JSON.stringify(items[0]).slice(0, 800));
    }
    res.status(200).json({ ok: true, gifs });
  } catch (e) {
    console.error('[gif-search] fetch failed:', e);
    res.status(502).json({ ok: false, error: 'Could not reach GIF service' });
  }
}
