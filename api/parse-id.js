// Vercel serverless function: parse government-issued ID images using
// Anthropic Claude vision.
//
// Used as the AI fallback for the passenger ID scanner when the PDF417
// barcode either:
//   - couldn't be read (3-second timeout)
//   - doesn't exist (passport, international ID, paper documents)
//
// Body shape:
//   { imageBase64: '...', mediaType: 'image/jpeg' | 'image/png' }
//
// Returns:
//   {
//     ok: true,
//     parsed: {
//       documentType: 'us_drivers_license' | 'us_state_id' | 'passport' | 'international_id' | 'unknown',
//       firstName, middleName, lastName,
//       dob: 'YYYY-MM-DD' | null,
//       documentNumber,
//       expiration: 'YYYY-MM-DD' | null,
//       issuingAuthority,
//       confidence: 'high' | 'medium' | 'low',
//       notes
//     }
//   }
//
// SECURITY NOTE: ID images contain PII. The image is sent to Anthropic for
// processing per their API terms. The image is not retained by us beyond the
// request lifetime. The caller is responsible for storing the image in
// Firebase Storage if they want a retained record.

import { getFirestore } from 'firebase-admin/firestore';
import { verifyOperatorToken } from './_operator-token.js';

export const config = { runtime: 'nodejs' };

// Authentication is required before an ID image can spend the organization's
// Anthropic quota. Any approved Skyway user may check in a passenger; role
// authorization remains in the app and Firestore rules.
let cachedAdmin = null;
async function getAdmin() {
  if (cachedAdmin) return cachedAdmin;
  const mod = await import('firebase-admin');
  const admin = mod.default;
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not configured on server');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  cachedAdmin = admin;
  return cachedAdmin;
}

async function authorizeOperatorScan(admin, token) {
  const verified = verifyOperatorToken(token);
  if (!verified.ok) {
    const error = new Error('Invalid operator crew link');
    error.status = 401;
    throw error;
  }
  const database = getFirestore(admin.app(), 'appusers');
  const ref = database.collection('trip-state').doc(verified.tripId);
  await database.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      const error = new Error('Trip not found');
      error.status = 404;
      throw error;
    }
    const data = snap.data() || {};
    if (
      data.operatorLinkRevoked === true
      || !Number.isFinite(data.operatorLinkIssuedAt)
      || verified.issuedAt < data.operatorLinkIssuedAt
    ) {
      const error = new Error('Operator crew link is no longer active');
      error.status = 403;
      throw error;
    }
    if (data.operatorTrackingExpiresAt && data.operatorTrackingExpiresAt < Date.now()) {
      const error = new Error('Operator crew link has expired');
      error.status = 410;
      throw error;
    }
    const count = Number(data.operatorIdScanCount || 0);
    if (count >= 60) {
      const error = new Error('ID scan limit reached for this crew link; contact Skyway Operations');
      error.status = 429;
      throw error;
    }
    transaction.set(ref, {
      operatorIdScanCount: count + 1,
      operatorLastIdScanAt: Date.now(),
    }, { merge: true });
  });
  return true;
}

const SYSTEM_PROMPT = `You extract structured data from government-issued ID documents for a Part 135 charter aviation operator. Your output is used to verify passenger identity against trip manifests.

Output ONLY valid JSON matching this exact schema. No markdown. No commentary. No code fences.

{
  "documentType": "one of: us_drivers_license, us_state_id, passport, international_id, unknown",
  "firstName": "string — given/first name as printed",
  "middleName": "string or null — middle name or initial if present",
  "lastName": "string — family/surname as printed",
  "dob": "YYYY-MM-DD or null if unreadable",
  "documentNumber": "string — license number, passport number, or document ID",
  "expiration": "YYYY-MM-DD or null",
  "issuingAuthority": "string — issuing state, country, or authority (e.g., 'CA', 'USA', 'GBR')",
  "confidence": "high | medium | low",
  "notes": "any unusual details or extraction issues — short string or null"
}

Rules:
- Read names EXACTLY as printed on the document. Preserve hyphens, apostrophes, accented characters.
- For passports: read the MRZ (machine-readable zone at the bottom) for highest accuracy. The MRZ has standardized format.
- For US driver's licenses: read the printed name, not the signature.
- Dates: convert any format to YYYY-MM-DD. If you see "MAR 15, 1965" return "1965-03-15".
- If an ID has both English and another script, return the English/Latin version.
- Set confidence "high" only when text is clearly legible. Set "medium" if some characters are uncertain. Set "low" if you had to guess significant fields.
- If the image isn't a government ID at all, set documentType: "unknown" and put "Image does not appear to be a government ID" in notes.
- NEVER invent data. If a field is unreadable, return null for that field with a note.`;

const USER_PROMPT = 'Extract the data from this ID document and return only the JSON object per the schema. Do not include any other text.';

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
  const { idToken, operatorToken, imageBase64, mediaType } = body || {};
  if (
    (!idToken || typeof idToken !== 'string')
    && (!operatorToken || typeof operatorToken !== 'string')
  ) return res.status(401).json({ error: 'Authentication required' });
  try {
    const admin = await getAdmin();
    if (operatorToken) {
      await authorizeOperatorScan(admin, operatorToken);
    } else {
      const decoded = await admin.auth().verifyIdToken(idToken, true);
      const profileSnap = await getFirestore(admin.app(), 'appusers')
        .collection('users')
        .doc(decoded.uid)
        .get();
      const profile = profileSnap.exists ? profileSnap.data() : null;
      if (
        !profile
        || profile.approved !== true
        || profile.active === false
        || !['crew', 'ops', 'admin'].includes(profile.role)
      ) {
        return res.status(403).json({ error: 'Passenger check-in access required' });
      }
    }
  } catch (err) {
    if (/FIREBASE_SERVICE_ACCOUNT_JSON/.test(err?.message || '')) {
      console.error('[parse-id] admin init failed:', err.message);
      return res.status(500).json({ error: 'Auth not configured on server' });
    }
    return res.status(err.status || 401).json({ error: err.message || 'Invalid or expired auth token' });
  }
  if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

  // Validate media type — Claude vision supports jpeg, png, gif, webp
  const allowedMedia = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mt = mediaType || 'image/jpeg';
  if (!allowedMedia.includes(mt)) {
    return res.status(400).json({ error: `Unsupported mediaType: ${mt}` });
  }
  // Base64 is ~33% larger than binary. Keep the request below Vercel and
  // Anthropic limits and reject accidental full-resolution camera originals.
  if (imageBase64.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large for parsing' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mt,
                  data: imageBase64,
                },
              },
              { type: 'text', text: USER_PROMPT },
            ],
          },
        ],
      }),
    });

    const upstreamData = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('[parse-id] Anthropic error:', upstream.status, upstreamData);
      return res.status(502).json({
        error: `AI extraction failed: ${upstreamData?.error?.message || upstream.status}`,
      });
    }

    // Extract text from response
    const textBlock = (upstreamData.content || []).find(c => c.type === 'text');
    const rawText = textBlock?.text || '';

    // Strip any code fences if Claude added them despite instructions
    let cleaned = rawText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[parse-id] JSON parse failed. Raw text:', rawText);
      return res.status(502).json({
        error: 'AI returned unparseable response',
        rawText: rawText.slice(0, 500),
      });
    }

    return res.status(200).json({ ok: true, parsed });
  } catch (err) {
    console.error('[parse-id] exception:', err);
    return res.status(500).json({ error: err.message || 'AI extraction failed' });
  }
}
