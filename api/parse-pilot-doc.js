// /api/parse-pilot-doc.js
//
// Extracts structured data from a crew member's pilot document using
// Claude vision. Covers four document types:
//   - certificate      (FAA airman certificate)
//   - medical          (FAA medical certificate)
//   - passport
//   - drivers_license
//
// v2 — EXPANDED SCHEMA. We now ask the model to extract every field
// printed on the document, not just the regulatory minimums. This
// powers the realistic document-style card visualizations in
// src/PilotDocs.jsx.
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

// Expanded schema: every field visible on the document. Older callers
// that only used the original 11 fields will keep working because we
// only ADD fields. The model is told to use null for anything not
// printed/applicable.
const SYSTEM_PROMPT = `You extract structured data from pilot/crew documents for a Part 135 charter aviation operator. The document is one of: FAA airman certificate, FAA medical certificate, passport, or driver's license.

Output ONLY valid JSON matching this exact schema. No markdown, no commentary, no code fences. Every field must appear in the response; use null when not present/applicable.

{
  "detectedType": "one of: certificate, medical, passport, drivers_license, unknown",

  "// --- IDENTITY (all doc types) ---": "",
  "holderName": "full name as printed (line 1 of name area), or null",
  "surname": "last name only as printed in caps, or null",
  "givenNames": "first + middle name(s) as printed in caps, or null",
  "middleName": "middle name(s) only, or null",
  "dob": "YYYY-MM-DD or null",
  "sex": "M, F, or X — exactly as printed, or null",
  "height": "as printed including units (e.g. '5'-11\\"' or '180 cm'), or null",
  "weight": "as printed including units (e.g. '175 lb' or '79 kg'), or null",
  "eyeColor": "as printed (BRN, BLU, HZL, GRN, BLK, GRY), or null",
  "hairColor": "as printed (BRN, BLK, BLN, GRY, RED), or null",
  "nationality": "country/state/citizenship as printed (USA, GBR, etc.), or null",

  "// --- ADDRESS (cert / DL) ---": "",
  "addressLine1": "street address as printed, or null",
  "addressLine2": "apt/unit/suite line, or null",
  "addressCity": "city as printed, or null",
  "addressState": "state/province 2-letter code, or null",
  "addressZip": "ZIP/postal code as printed, or null",

  "// --- DOCUMENT IDENTIFIERS ---": "",
  "documentNumber": "certificate number / passport number / license number, or null",
  "issuingAuthority": "FAA, issuing country (e.g. USA, GBR), or issuing US state (e.g. FL), or null",
  "issueDate": "YYYY-MM-DD or null",
  "expiration": "YYYY-MM-DD or null — see rules",

  "// --- AIRMAN CERTIFICATE-specific ---": "",
  "certType": "for airman certificates: ATP, Commercial, Private, Student, Sport, Recreational, Flight Instructor, or null",
  "ratings": "for airman/medical: short text of ratings, limitations, or type ratings as printed, or null",
  "limitations": "limitations section text (e.g. 'Limited to private pilot privileges'), or null",

  "// --- MEDICAL-specific ---": "",
  "medicalClass": "for medical certificates: 1, 2, or 3 (first/second/third class), or null",
  "examinationDate": "YYYY-MM-DD — date of physical exam if printed separately from issue date, or null",
  "medicalRestrictions": "exact restrictions/limitations text (e.g. 'Holder shall wear corrective lenses'), or null",
  "ameName": "name of Aviation Medical Examiner who signed, or null",
  "ameNumber": "AME serial number / designation number, or null",

  "// --- PASSPORT-specific ---": "",
  "passportType": "the 'Type' field (usually 'P'), or null",
  "passportCountryCode": "3-letter country code (USA, GBR, CAN), or null",
  "placeOfBirth": "as printed (e.g. 'NEW YORK, U.S.A.'), or null",
  "issuingAuthorityFull": "full authority text (e.g. 'United States Department of State'), or null",
  "mrzLine1": "first MRZ line exactly as printed including < fillers, or null",
  "mrzLine2": "second MRZ line exactly as printed including < fillers, or null",

  "// --- DRIVER'S LICENSE-specific ---": "",
  "licenseClass": "DL class (A, B, C, CDL-A, M, etc.), or null",
  "licenseRestrictions": "DL restrictions text or codes as printed (e.g. 'CORR LENS', 'B'), or null",
  "licenseEndorsements": "DL endorsements text or codes (e.g. 'H', 'N', 'T'), or null",
  "organDonor": "true if 'DONOR' or organ donor heart icon is shown, false if explicitly not, null if not visible",
  "veteran": "true if 'VETERAN' is printed, false/null otherwise",

  "// --- QUALITY/METADATA ---": "",
  "photoPresent": "true if document has a photo, false otherwise",
  "signaturePresent": "true if document has a signature, false otherwise",
  "confidence": "high | medium | low",
  "notes": "any unusual details or extraction issues — short string or null"
}

Rules:
- Read text EXACTLY as printed. Preserve hyphens, apostrophes, accents, capitalization where meaningful.
- Dates: convert any format to YYYY-MM-DD. "MAR 15 2027" -> "2027-03-15".
- Names: if the document shows "SMITH, JOHN ROBERT", set surname="SMITH", givenNames="JOHN ROBERT", middleName="ROBERT", holderName="JOHN ROBERT SMITH".
- ADDRESS: extract every line. If the printed format is "123 MAIN ST APT 4 / NAPLES FL 34102", set addressLine1="123 MAIN ST", addressLine2="APT 4", addressCity="NAPLES", addressState="FL", addressZip="34102". Omit unit/apt as line2 if not present.
- FAA AIRMAN CERTIFICATES DO NOT EXPIRE. For detectedType "certificate", set expiration to null even if you see other dates. Put the certificate level in certType.
- FAA MEDICAL CERTIFICATES: the expiration depends on class and age and is often not printed explicitly. If an explicit expiration date is printed, use it. Otherwise set expiration null. Put 1/2/3 in medicalClass. Look for the AME's printed name + AME number/serial near the signature block.
- PASSPORTS: read the MRZ (machine-readable zone) at the bottom. Capture both lines verbatim including '<' fill characters. The MRZ has the most reliable data.
- DRIVER'S LICENSES: use the printed expiration date. Read the full address block. Note all restriction/endorsement codes.
- HEIGHT/WEIGHT: preserve units. If shown as "5-11" preserve as "5'-11"" (5 feet 11 inches). Metric stays metric.
- Set confidence "high" only when text is clearly legible; "medium" if some characters are uncertain; "low" if you guessed significant fields.
- If the image is not one of these documents, set detectedType "unknown" and explain in notes.
- NEVER invent data. Unreadable field -> null with a note. If a field doesn't exist for this doc type (e.g. passportType on a DL), set null silently — don't note it.
- The "//" keys in the schema are documentation only — do NOT include them in your output. Output only real data keys.`;

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
    ? `The user labeled this as: ${docType}. Extract the data and return only the JSON object per the schema. Remember: exclude the // documentation keys from your output.`
    : 'Extract the data and return only the JSON object per the schema. Exclude the // documentation keys from your output.';

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
        max_tokens: 2048, // expanded schema -> more output
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

    // Strip out any "//"-prefixed keys the model leaked into output
    if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(parsed)) {
        if (k.startsWith('//')) delete parsed[k];
      }
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
