// Vercel serverless function: ingest an FAA-approved MEL PDF into a DRAFT
// revision in Firestore (collection `mel-revisions`), to be reviewed by a
// qualified person and then activated.
//
// AUTH: idToken in body -> verifyIdToken (firebase-admin) -> caller must be
// role 'maint' or 'admin' (looked up in the named `appusers` DB, same as
// api/delete-user.js). Mirrors the gate added to api/parse-receipt.js.
//
// PIPELINE (no new dependency — uses pdfjs-dist, already in package.json):
//   1. Download the uploaded PDF from Firebase Storage (admin SDK).
//   2. pdfjs-dist extracts per-page text and the ATA system -> page-range
//      map from the page footers ("DATE: ...  NN-x"). Deterministic.
//   3. For each ATA system, send ONLY that section's text to the Anthropic
//      API with a strict schema (small context per call => far more reliable
//      than one 144-page blob; the regex parser proved a whole-doc parse
//      drops items).
//   4. Structural sanity checks (all expected ATA systems present, valid
//      categories, integer counts). Anything off is FLAGGED, never silently
//      dropped.
//   5. Write a DRAFT revision doc. A qualified person reviews it against the
//      source PDF and activates it — that human review is the compliance
//      gate. Nothing here decides deferrability.
//
// Body: { idToken, storagePath, tail, revisionLabel, revisionDate, basedOn,
//         bucket? }

export const config = { runtime: 'nodejs', maxDuration: 300 };

const EXPECTED_SYSTEMS = {
  '21': 'Air Conditioning', '22': 'Autoflight', '23': 'Communications',
  '24': 'Electrical Power', '25': 'Equipment/Furnishings', '26': 'Fire Protection',
  '27': 'Flight Controls', '28': 'Fuel', '29': 'Hydraulic Power',
  '30': 'Ice and Rain Protection', '31': 'Indicating/Recording Systems',
  '32': 'Landing Gear', '33': 'Lights', '34': 'Navigation', '35': 'Oxygen',
  '38': 'Water/Waste', '45': 'Central Maintenance System', '46': 'Information Systems',
  '49': 'Airborne Auxiliary Power', '52': 'Doors', '74': 'Ignition',
  '76': 'Engine Control', '77': 'Engine Indicating', '78': 'Engine Exhaust',
};

const SYS_PROMPT = `You extract data from ONE section of an FAA-approved Minimum Equipment List (MEL) for a Learjet 60. Output ONLY valid JSON, no markdown, no commentary.

MEL columns: (1) REPAIR CATEGORY (A,B,C,D) (2) NUMBER INSTALLED (3) NUMBER REQUIRED FOR DISPATCH (4) REMARKS AND EXCEPTIONS.

Schema: {"items":[{
"sequence":"item number as printed",
"item":"item name exactly as printed, wrapped lines joined with single spaces",
"subitem":"A/B/C letter if a lettered sub-item, else null",
"subitem_name":"sub-item name if subitem present else null",
"category":"A|B|C|D exactly from column 1; null if the row grants no relief",
"installed": integer or null,
"required": integer or null,
"remarks":"column 4 VERBATIM — preserve wording, provisos a) b) c), NOTE: lines; join wrapped lines with single spaces; do NOT summarize",
"maint_required": boolean (remarks contain a leading (M)),
"ops_required": boolean (remarks contain (O)),
"non_relief": boolean (row grants no relief e.g. 'Relief separated', 'Deleted', no category),
"procedures":[{"kind":"MAINTENANCE (M)|OPERATIONS (O)|OPERATIONS NOTE","title":"the NN-N ... Inoperative. line or null","text":"full procedure text VERBATIM, newlines as \\n"}]
}]}

Rules: one object per distinct category/installed/required row; capture EVERY item incl. short ones; remarks VERBATIM (safety-critical, never invent/soften); null when genuinely absent; never guess a category.`;

let cachedAdmin = null;
async function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const admin = await import('firebase-admin');
  if (!admin.apps || admin.apps.length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured on server');
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
    admin.default.initializeApp({ credential: admin.default.credential.cert(parsed) });
  }
  cachedAdmin = admin.default;
  return cachedAdmin;
}

// Extract per-page text using pdfjs-dist (already a dependency). Returns
// [{page, text}]. The page footer carries "DATE: <d>  <ATA>-<n>".
async function extractPages(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true });
  const pdf = await task.promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    // eslint-disable-next-line no-await-in-loop
    const page = await pdf.getPage(i);
    // eslint-disable-next-line no-await-in-loop
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => (it.str || '')).join(' ').replace(/\s+/g, ' ');
    pages.push({ page: i, text });
  }
  return pages;
}

// Map ATA system -> contiguous page numbers, from the footer "<ATA>-<n>".
export function mapSections(pages) {
  const map = {};
  const re = /\b(\d{2})-\d+\b/;
  for (const { page, text } of pages) {
    // Footer pattern appears with the revision date nearby; restrict to the
    // known ATA numbers to avoid false hits in body text.
    const m = text.match(/DATE:\s*\d{2}\/\d{2}\/\d{4}\s+(\d{2})-\d+/) || text.match(re);
    if (m && EXPECTED_SYSTEMS[m[1]]) {
      const s = m[1];
      if (!map[s]) map[s] = { first: page, last: page };
      map[s].last = page;
    }
  }
  return map;
}

async function callClaude(apiKey, sysNo, sysName, text) {
  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    system: SYS_PROMPT,
    messages: [{ role: 'user', content:
      `ATA system ${sysNo} (${sysName}). Extract ALL items to the JSON schema. ` +
      `Output ONLY the JSON object.\n\n--- SECTION TEXT ---\n${text}` }],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { if (attempt < 2) { await new Promise(z => setTimeout(z, 3000 * (attempt + 1))); continue; } return { error: d?.error?.message || `Claude ${r.status}` }; }
      let t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      return { items: JSON.parse(t).items || [] };
    } catch (e) {
      if (attempt < 2) { await new Promise(z => setTimeout(z, 3000 * (attempt + 1))); continue; }
      return { error: e.message };
    }
  }
  return { error: 'exhausted retries' };
}

// Pure: structural sanity over merged items. Flags, never drops.
export function sanityReport(items, sectionMap) {
  const present = new Set(items.map(i => String(i.system)));
  const missing = Object.keys(EXPECTED_SYSTEMS).filter(s => sectionMap[s] && !present.has(s));
  const badCat = items.filter(i => i.category != null && !['A', 'B', 'C', 'D'].includes(i.category)).length;
  const badNums = items.filter(i =>
    (i.installed != null && !Number.isInteger(i.installed)) ||
    (i.required != null && !Number.isInteger(i.required))).length;
  const noRemarks = items.filter(i => !i.non_relief && !String(i.remarks || '').trim()).length;
  const counts = {};
  items.forEach(i => { counts[i.system] = (counts[i.system] || 0) + 1; });
  return {
    sectionsExpected: Object.keys(sectionMap).length,
    sectionsWithItems: Object.keys(counts).length,
    missingSections: missing,
    invalidCategory: badCat,
    nonIntegerCounts: badNums,
    itemsMissingRemarks: noRemarks,
    perSection: counts,
    clean: missing.length === 0 && badCat === 0 && badNums === 0 && noRemarks === 0,
  };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid request body' });

  const { idToken, storagePath, tail, revisionLabel, revisionDate, basedOn, bucket } = body;
  if (!idToken) return res.status(401).json({ error: 'Authentication required' });
  if (!storagePath || !tail) return res.status(400).json({ error: 'storagePath and tail are required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  let admin;
  try {
    admin = await getAdmin();
    const decoded = await admin.auth().verifyIdToken(idToken);
    const fdb = admin.firestore();
    fdb.settings({ databaseId: 'appusers' });
    const callerDoc = await fdb.collection('users').doc(decoded.uid).get();
    const role = callerDoc.exists ? callerDoc.data()?.role : null;
    if (!['maint', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions — maint or admin only' });
    }
  } catch (err) {
    if (/FIREBASE_SERVICE_ACCOUNT_JSON/.test(err.message)) return res.status(500).json({ error: 'Auth not configured on server' });
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  try {
    // 1. Download the uploaded MEL PDF from Firebase Storage.
    const bkt = admin.storage().bucket(bucket || 'skyway-ops-app.firebasestorage.app');
    const [buf] = await bkt.file(storagePath).download();

    // 2. Per-page text + ATA section map.
    const pages = await extractPages(buf);
    const sectionMap = mapSections(pages);
    const sysNos = Object.keys(sectionMap).sort((a, b) => Number(a) - Number(b));
    if (sysNos.length === 0) {
      return res.status(422).json({ error: 'No ATA sections detected — is this the MEL PDF?' });
    }

    // 3. Per-section extraction.
    const items = [];
    const sectionErrors = {};
    for (const s of sysNos) {
      const { first, last } = sectionMap[s];
      const text = pages.filter(p => p.page >= first && p.page <= last).map(p => p.text).join('\n');
      // eslint-disable-next-line no-await-in-loop
      const out = await callClaude(apiKey, s, EXPECTED_SYSTEMS[s], text);
      if (out.error) { sectionErrors[s] = out.error; continue; }
      for (const it of out.items) {
        it.system = s;
        it.system_name = EXPECTED_SYSTEMS[s];
        const seq = String(it.sequence || '').trim();
        it.ref = `ATA ${s}-${seq}` + (it.subitem ? ` ${it.subitem}` : '');
      }
      items.push(...out.items);
    }

    // 4. Sanity (flags, never drops).
    const report = sanityReport(items, sectionMap);
    report.sectionErrors = sectionErrors;

    // 5. Write DRAFT revision (same doc shape firebase-mel.saveDraftRevision
    //    produces, so the client subscribe/activate path reads it correctly).
    const fdb = admin.firestore();
    fdb.settings({ databaseId: 'appusers' });
    const tnorm = String(tail).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const id = `${tnorm}_${String(revisionLabel || 'rev').replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}_${Date.now()}`;
    const now = Date.now();
    const doc = {
      id, tail: tnorm,
      revisionLabel: String(revisionLabel || 'ORIGINAL'),
      revisionDate: String(revisionDate || ''),
      basedOn: basedOn ? String(basedOn) : null,
      sourceFile: storagePath,
      status: 'draft',
      items, itemCount: items.length,
      sectionCounts: report.perSection,
      ingestReport: report,
      createdAt: now, createdByName: 'MEL Ingest',
      activatedAt: null, activatedByName: null, supersededAt: null,
    };
    const approx = JSON.stringify(doc).length;
    if (approx > 950 * 1024) {
      return res.status(413).json({ error: `Parsed MEL ~${Math.round(approx / 1024)}KB exceeds the single-document limit; sharding required (not truncating).`, report });
    }
    await fdb.collection('mel-revisions').doc(id).set(doc);

    return res.status(200).json({ ok: true, revisionId: id, itemCount: items.length, report });
  } catch (err) {
    console.error('[mel-ingest]', err);
    return res.status(500).json({ error: `Ingest failed: ${err.message}` });
  }
}
