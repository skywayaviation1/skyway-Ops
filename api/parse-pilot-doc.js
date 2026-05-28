// /api/parse-pilot-doc.js
//
// Extracts structured data from a crew member's pilot document using
// Claude vision. Covers four document types:
//   - certificate      (FAA airman certificate)
//   - medical          (FAA medical certificate)
//   - passport
//   - drivers_license
//
// Body:
//   { idToken, docType, imageBase64, mediaType }   // images
//   { idToken, docType, pdfBase64 }                // PDFs (medicals/certs)
//
// Returns: { ok: true, parsed: { ...fields } }
//
// Auth: requires a valid Firebase ID token (this spends our Anthropic key
// and processes PII). Mirrors the gate used by api/parse-receipt.js.
//
// SECURITY NOTE: these documents contain PII. The file is sent to Anthropic
// for processing per their API terms and is not retained beyond the request.
// The caller stores the file in Firebase Storage for the retained copy.

import admin from 'firebase-admin';

export const config = { runtime: 'nodejs' };

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
    try { await admin.auth(getAdmin()).verifyIdToken(idToken); return true; }
    catch (_) { return false; }
  }
  return false;
}

// One schema covering the union of fields. The model fills only what's
// relevant to the document and nulls the rest. We tell it the docType so
// it knows what to look for, but it should still self-correct if the user
// uploaded the wrong type.
const SYSTEM_PROMPT = `You extract structured data from pilot/crew documents for a Part 135 charter aviation operator. The document is one of: FAA airman certificate, FAA medical certificate, passport, or driver's license.

Output ONLY valid JSON matching this exact schema. No markdown, no commentary, no code fences.

{
  "detectedType": "one of: certificate, medical, passport, drivers_license, unknown",
  "holderName": "full name as printed, or null",
  "documentNumber": "certificate number / passport number / license number, or null",
  "issuingAuthority": "FAA, issuing country (e.g. USA, GBR), or issuing US state (e.g. FL), or null",
  "issueDate": "YYYY-MM-DD or null",
  "expiration": "YYYY-MM-DD or null — see rules",
  "dob": "YYYY-MM-DD or null",
  "certType": "for airman certificates: ATP, Commercial, Private, Student, Sport, Recreational, Flight Instructor, or null",
  "ratings": "for airman/medical: short text of ratings, limitations, or type ratings as printed, or null",
  "medicalClass": "for medical certificates: 1, 2, or 3 (first/second/third class), or null",
  "confidence": "high | medium | low",
  "notes": "any unusual details or extraction issues — short string or null"
}

Rules:
- Read text EXACTLY as printed. Preserve hyphens, apostrophes, accents.
- Dates: convert any format to YYYY-MM-DD. "MAR 15 2027" -> "2027-03-15".
- FAA AIRMAN CERTIFICATES DO NOT EXPIRE. For detectedType "certificate", set expiration to null even if you see other dates. Put the certificate level in certType.
- FAA MEDICAL CERTIFICATES: the expiration depends on class and age and is often not printed explicitly. If an explicit expiration date is printed, use it. Otherwise set expiration null and note "medical expiry depends on class/age — verify manually". Put 1/2/3 in medicalClass.
- PASSPORTS: read the MRZ (machine-readable zone) at the bottom for highest accuracy. Use the expiration from the passport.
- DRIVER'S LICENSES: use the printed expiration date.
- Set confidence "high" only when text is clearly legible; "medium" if some characters are uncertain; "low" if you guessed significant fields.
- If the image is not one of these documents, set detectedType "unknown" and explain in notes.
- NEVER invent data. Unreadable field -> null with a note.`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }

  const ok = await authorize(req, body);
  if (!ok) return res.status(401).json({ error: 'Unauthorized' });

  const { imageBase64, pdfBase64, mediaType, docType } = body || {};
  if (!imageBase64 && !pdfBase64) {
    return res.status(400).json({ error: 'Missing imageBase64 or pdfBase64' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  // Build the content block — image vs PDF (document) source.
  let sourceBlock;
  if (pdfBase64) {
    sourceBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
    };
  } else {
    const allowedMedia = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const mt = mediaType || 'image/jpeg';
    if (!allowedMedia.includes(mt)) {
      return res.status(400).json({ error: `Unsupported mediaType: ${mt}` });
    }
    sourceBlock = {
      type: 'image',
      source: { type: 'base64', media_type: mt, data: imageBase64 },
    };
  }

  const hint = docType
    ? `The user labeled this as: ${docType}. Extract the data and return only the JSON object per the schema.`
    : 'Extract the data and return only the JSON object per the schema.';

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 55000);
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      signal: ac.signal,
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: [ sourceBlock, { type: 'text', text: hint } ] },
        ],
      }),
    });
    clearTimeout(timeout);

    const upstreamData = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[parse-pilot-doc] Anthropic error:', upstream.status, upstreamData?.error?.message || '');
      return res.status(502).json({
        error: `AI extraction failed: ${upstreamData?.error?.message || upstream.status}`,
      });
    }

    const textBlock = (upstreamData.content || []).find((c) => c.type === 'text');
    const rawText = textBlock?.text || '';
    let cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[parse-pilot-doc] JSON parse failed. Raw:', rawText.slice(0, 300));
      return res.status(502).json({ error: 'AI returned unparseable response', rawText: rawText.slice(0, 500) });
    }
    return res.status(200).json({ ok: true, parsed });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI extraction timed out' });
    }
    console.error('[parse-pilot-doc] exception:', err);
    return res.status(500).json({ error: err.message || 'AI extraction failed' });
  }
}
