// /api/bulk-download-pilot-docs.js
//
// Server-side ZIP builder for pilot documents. The client lists the
// files (fetched from Firestore) and we fetch + zip them server-side
// because Firebase Storage URLs don't have CORS configured for direct
// browser fetch() — Safari rejects with "Failed to download: Load
// failed" and Chrome with "TypeError: Failed to fetch".
//
// Body:
//   {
//     idToken: string,            // Firebase ID token for auth
//     crewName: string,           // for filename + folder
//     files: [
//       {
//         url:      string,       // Firebase Storage download URL
//         folder:   string,       // e.g. "certificate", "passport"
//         filename: string,       // suggested filename in the ZIP
//       },
//       ...
//     ]
//   }
//
// Returns: application/zip stream attachment.
//
// REQUIRES: jszip ^3.10.1 in package.json. Already used client-side
// via CDN; add the npm dep to ship server-side.

import admin from 'firebase-admin';
import JSZip from 'jszip';

export const config = {
  runtime: 'nodejs',
  // Bigger bodies allowed because the response is a ZIP. The request
  // body itself is just JSON manifest, small.
  api: { responseLimit: false },
};

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}

async function authorize(req, body) {
  const internalSecret = req.headers['x-internal-secret'];
  if (internalSecret && internalSecret === process.env.INTERNAL_API_SECRET) return true;
  const idToken =
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    body?.idToken ||
    req.query?.idToken;
  if (idToken) {
    try {
      const decoded = await admin.auth(getAdmin()).verifyIdToken(idToken);
      return decoded;
    }
    catch (_) { return false; }
  }
  return false;
}

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9 ._-]/g, '_').trim().slice(0, 80) || 'doc';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const auth = await authorize(req, body);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const { crewName, files } = body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'No files supplied' });
  }
  if (files.length > 200) {
    return res.status(400).json({ error: 'Too many files (max 200 per request)' });
  }

  const zip = new JSZip();
  const rootName = safeName(crewName || 'crew');
  const root = zip.folder(rootName);

  // Fetch in parallel — node-fetch has no CORS, so this Just Works.
  // Bound concurrency to avoid hammering Storage.
  const CONCURRENCY = 5;
  let cursor = 0;
  let okCount = 0;
  let errCount = 0;

  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const f = files[idx];
      const folderName = safeName(f.folder || 'misc');
      const fileName = safeName(f.filename || `file-${idx + 1}`);
      const folder = root.folder(folderName);
      if (!f.url) {
        folder.file(`MISSING_${fileName}.txt`, 'No file URL supplied — skipped.');
        errCount++;
        continue;
      }
      try {
        const r = await fetch(f.url);
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        const ab = await r.arrayBuffer();
        folder.file(fileName, Buffer.from(ab));
        okCount++;
      } catch (e) {
        console.warn('[bulk-download] fetch failed:', f.url, e?.message);
        folder.file(
          `ERROR_${fileName}.txt`,
          `Failed to download from Firebase Storage.\nURL: ${f.url}\nError: ${e?.message || 'unknown'}`,
        );
        errCount++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));

  // Drop a manifest so the recipient knows what was supposed to be there.
  const manifest = [
    `Skyway Pilot Documents — Bulk Download`,
    `Crew: ${crewName || '(unknown)'}`,
    `Generated: ${new Date().toISOString()}`,
    `Requested: ${files.length}   OK: ${okCount}   Errors: ${errCount}`,
    '',
    'Files:',
    ...files.map((f, i) => `  [${i + 1}] ${safeName(f.folder)}/${safeName(f.filename)}`),
  ].join('\n');
  root.file('_manifest.txt', manifest);

  try {
    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${rootName} - skyway docs.zip"`,
    );
    res.setHeader('Content-Length', buf.length);
    res.status(200).send(buf);
  } catch (e) {
    console.error('[bulk-download] zip generate failed:', e);
    res.status(500).json({ error: 'Failed to build ZIP', detail: e?.message });
  }
}
