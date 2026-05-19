// Vercel serverless function: AI MEL finder.
//
// Given a plain-language description of a discrepancy, returns a ranked list
// of CANDIDATE ATA item references from the aircraft's ACTIVE MEL revision.
// The model ONLY points at item references that already exist in the stored
// MEL — it never generates MEL text. The client then renders the verbatim
// stored items (via firebase-mel.resolveRefs) for a qualified person to
// read and decide. This is a finding aid, not a deferrability determination.
//
// AUTH: idToken -> verifyIdToken; any authenticated user may search (read
// only; no role gate — finding is not deciding). Mirrors parse-receipt gate.
//
// Body: { idToken, tail, query }

export const config = { runtime: 'nodejs' };

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

const SYS_PROMPT = `You help a maintenance technician FIND candidate items in an aircraft's approved MEL. You are given a discrepancy description and a compact index of MEL items (reference, system, item name only — NOT the provisos). Return ONLY the references most likely relevant, best first.

Output ONLY JSON: {"candidates":["<ref>", ...],"note":"one short sentence on how to interpret these"}

Rules:
- Use ONLY references that appear in the provided index. Never invent a reference.
- Return at most 8, ordered most-relevant first. Empty array if nothing plausible.
- You are SUGGESTING items to read. You are NOT determining deferrability — the technician must read the actual MEL provisos and decide. Reflect that in "note".`;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Invalid request body' });

  const { idToken, tail, query } = body;
  if (!idToken) return res.status(401).json({ error: 'Authentication required' });
  if (!tail || !query || !String(query).trim()) return res.status(400).json({ error: 'tail and query are required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  let admin;
  try {
    admin = await getAdmin();
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    if (/FIREBASE_SERVICE_ACCOUNT_JSON/.test(err.message)) return res.status(500).json({ error: 'Auth not configured on server' });
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }

  try {
    const fdb = admin.firestore();
    fdb.settings({ databaseId: 'appusers' });
    const tnorm = String(tail).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const snap = await fdb.collection('mel-revisions').where('tail', '==', tnorm).get();
    let active = null;
    snap.forEach((d) => { const v = d.data(); if (v.status === 'active') active = v; });
    if (!active) return res.status(404).json({ error: `No active MEL revision for ${tnorm}` });

    // Compact index only — refs + names, NOT provisos (keeps the prompt small
    // and prevents the model from paraphrasing regulatory text).
    const index = (active.items || []).map((it) =>
      `${it.ref} | ${it.system} ${it.system_name} | ${it.item}${it.subitem ? ' — ' + it.subitem + '. ' + (it.subitem_name || '') : ''}`
    ).join('\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SYS_PROMPT,
        messages: [{ role: 'user', content:
          `DISCREPANCY: ${String(query).slice(0, 1000)}\n\n--- MEL ITEM INDEX (${tnorm}, rev ${active.revisionLabel}) ---\n${index}` }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: d?.error?.message || `Claude ${r.status}` });
    let t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    let parsed;
    try { parsed = JSON.parse(t); } catch { return res.status(502).json({ error: 'AI returned unparseable response' }); }

    // Defense: only return refs that actually exist in the active revision.
    const valid = new Set((active.items || []).map(i => String(i.ref || '').toUpperCase().replace(/\s+/g, ' ').trim()));
    const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : [])
      .map(x => String(x || '').toUpperCase().replace(/\s+/g, ' ').trim())
      .filter(x => valid.has(x))
      .slice(0, 8);

    return res.status(200).json({
      ok: true,
      candidates,
      note: typeof parsed.note === 'string' ? parsed.note : 'Suggestions only — read the actual MEL provisos and decide.',
      revisionLabel: active.revisionLabel,
    });
  } catch (err) {
    console.error('[mel-search]', err);
    return res.status(500).json({ error: `Search failed: ${err.message}` });
  }
}
