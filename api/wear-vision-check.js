// /api/wear-vision-check.js
//
// AI vision assessment for wear inspections.
//
// Called fire-and-forget after a pilot saves a wear inspection. We:
//   1. Look up the inspection record
//   2. Pull the reference photos for that aircraft type + item type
//   3. Send everything to Claude vision with the labeled buckets
//   4. Write the result back to the inspection record + wear-items current state
//   5. If AI thinks the status should be WORSE than what the pilot picked
//      AND confidence is high, email MX.
//
// Two operating modes depending on training-library state:
//
//   COLD START (no reference photos uploaded yet):
//     We still run the model but prompt it generically using FAA + tire
//     manufacturer guidance. Confidence is capped at "medium" and we
//     skip the MX alert. Use this as a sanity-pass while building the
//     reference set.
//
//   WARM (≥1 reference photo per status bucket for the aircraft type + item):
//     We include the labeled references in the prompt. Full confidence
//     range and MX alerts on high-confidence disagreement.
//
// Request body:
//   { idToken, inspectionId }
//
// Response:
//   { ok: true, assessment: { status, reasoning, confidence,
//                              agrees_with_pilot, mode: 'cold'|'warm' } }

import admin from 'firebase-admin';

export const config = { runtime: 'nodejs' };

let adminApp = null;
function getAdmin() {
  if (adminApp) return adminApp;
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  adminApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(sa) });
  return adminApp;
}

async function authorize(req, body) {
  const idToken =
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') || body?.idToken;
  if (!idToken) return null;
  try {
    return await admin.auth(getAdmin()).verifyIdToken(idToken);
  } catch {
    return null;
  }
}

// Status priority for "is AI worse than pilot" comparison.
const PRI = { good: 0, monitor: 1, replace_soon: 2, grounded: 3 };

// Fetch an image URL and return base64 + media type for Claude vision.
async function fetchAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  const ct = r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  return { data: buf.toString('base64'), mediaType: ct.split(';')[0].trim() };
}

const SYSTEM_PROMPT = `You are an aviation maintenance assistant assessing wear on Part 135 aircraft tires and brakes. You compare a new inspection photo against labeled reference photos and decide which status category the new photo most closely matches.

Output ONLY a JSON object with this exact shape — no markdown fences, no commentary:
{
  "status": "good" | "monitor" | "replace_soon" | "grounded",
  "reasoning": "one or two short sentences",
  "confidence": "low" | "medium" | "high",
  "agrees_with_pilot": true | false,
  "specific_observations": ["..."]
}

Rules:
- For tires: assess tread depth, wear pattern (even/uneven/cupping), sidewall cracks, flat spots, cuts, exposed cord, weather checking. Aircraft tires don't have wear bars like car tires — judge against the references.
- For brakes: assess wear pin extension (less protruding = more worn), disc condition, lining thickness if visible, hydraulic leakage, scoring.
- If you cannot see the item clearly enough to assess, output status "monitor" and confidence "low" with reasoning explaining the visibility issue.
- "agrees_with_pilot" is true if your status is the SAME OR BETTER than the pilot's status; false if you think it's worse.
- Be conservative: a borderline case between two buckets should go to the WORSE bucket. Safety of flight prefers caution.
- If no labeled references were provided (cold start), use general aviation tire/brake guidance and cap confidence at "medium".`;

async function callClaude({ photoB64, photoMediaType, referenceImages, aircraftType, itemType, position, pilotStatus, pilotNotes }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const isWarm = referenceImages.length > 0;

  // Build the user message content blocks:
  // [reference images with labels] + [the new photo] + [text instructions]
  const content = [];
  if (isWarm) {
    content.push({
      type: 'text',
      text: `Below are ${referenceImages.length} reference photo(s) for ${aircraftType.toUpperCase()} ${itemType}s, labeled by wear status.`,
    });
    for (const ref of referenceImages) {
      content.push({
        type: 'text',
        text: `Reference — labeled ${ref.status.toUpperCase()}${ref.notes ? ` (${ref.notes})` : ''}:`,
      });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: ref.mediaType, data: ref.data },
      });
    }
    content.push({ type: 'text', text: '---' });
  } else {
    content.push({
      type: 'text',
      text: `No labeled reference photos available for ${aircraftType.toUpperCase()} ${itemType}s yet. Use general aviation guidance and cap confidence at "medium".`,
    });
  }
  content.push({
    type: 'text',
    text: `NEW INSPECTION PHOTO\nAircraft type: ${aircraftType}\nPosition: ${position}\nItem: ${itemType}\nPilot assessment: ${pilotStatus || 'unknown'}${pilotNotes ? `\nPilot notes: ${pilotNotes}` : ''}\n\nWhich labeled bucket does this match? Return only the JSON.`,
  });
  content.push({
    type: 'image',
    source: { type: 'base64', media_type: photoMediaType, data: photoB64 },
  });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  const j = await resp.json();
  if (!resp.ok) throw new Error(`Anthropic: ${j?.error?.message || resp.status}`);
  const block = (j.content || []).find((c) => c.type === 'text');
  const raw = (block?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`AI returned unparseable JSON: ${raw.slice(0, 200)}`); }
  parsed.mode = isWarm ? 'warm' : 'cold';
  return parsed;
}

async function maybeEmailMx({ inspection, assessment, db }) {
  // Email MX when AI confidence is HIGH and AI says worse than pilot. Cold-
  // start mode skips this since confidence is capped at medium.
  if (assessment.mode === 'cold') return;
  if (assessment.confidence !== 'high') return;
  if ((PRI[assessment.status] || 0) <= (PRI[inspection.pilotStatus] || 0)) return;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[wear-vision] RESEND_API_KEY not configured; skipping email');
    return;
  }

  const subject = `[Skyway WEAR] AI flag — ${inspection.tail} ${inspection.position}/${inspection.itemType}: AI says ${assessment.status.toUpperCase()} (pilot picked ${(inspection.pilotStatus || '—').toUpperCase()})`;
  const body =
    `Tail:     ${inspection.tail}\n` +
    `Item:     ${inspection.position} ${inspection.itemType}\n` +
    `Pilot:    ${inspection.inspectedByName || inspection.inspectedBy || '—'}\n` +
    `Pilot Rx: ${(inspection.pilotStatus || '').toUpperCase()}\n` +
    `AI Rx:    ${assessment.status.toUpperCase()} (${assessment.confidence})\n` +
    `Notes:    ${assessment.reasoning}\n\n` +
    `Observations:\n  ${(assessment.specific_observations || []).map((s) => `• ${s}`).join('\n  ')}\n\n` +
    `Photo: ${inspection.photoUrl || '(none)'}\n` +
    `When:  ${new Date(inspection.inspectedAtMs).toISOString()}\n`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Skyway Ops <ops@send.flyskyway.com>',
        to: ['mx@flyskyway.com'],
        cc: ['jake@flyskyway.com'],
        subject,
        text: body,
      }),
    });
  } catch (e) {
    console.warn('[wear-vision] email send failed:', e?.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
  }
  const decoded = await authorize(req, body);
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

  const inspectionId = body?.inspectionId;
  if (!inspectionId) return res.status(400).json({ error: 'inspectionId required' });

  try {
    const a = getAdmin();
    const db = admin.firestore(a, 'appusers');

    // Fetch inspection
    const insSnap = await db.collection('wear-inspections').doc(inspectionId).get();
    if (!insSnap.exists) return res.status(404).json({ error: 'Inspection not found' });
    const inspection = { id: insSnap.id, ...insSnap.data() };
    if (inspection.isDeferred) return res.status(200).json({ ok: true, skipped: 'deferred' });
    if (!inspection.photoUrl) return res.status(200).json({ ok: true, skipped: 'no photo' });

    // Reference photos for this aircraft type + item
    const refSnap = await db.collection('wear-training')
      .where('aircraftType', '==', inspection.aircraftType)
      .where('itemType', '==', inspection.itemType)
      .get();
    const refs = [];
    refSnap.forEach((d) => refs.push({ id: d.id, ...d.data() }));

    // Bound to 24 reference images max (Claude vision input limit + cost)
    const capped = refs.slice(0, 24);
    const refImages = [];
    for (const r of capped) {
      if (!r.photoUrl) continue;
      try {
        const { data, mediaType } = await fetchAsBase64(r.photoUrl);
        refImages.push({ status: r.status, notes: r.notes, data, mediaType });
      } catch (e) {
        console.warn('[wear-vision] could not fetch reference', r.id, e?.message);
      }
    }

    // The new photo
    const { data: photoB64, mediaType: photoMediaType } = await fetchAsBase64(inspection.photoUrl);

    const assessment = await callClaude({
      photoB64, photoMediaType, referenceImages: refImages,
      aircraftType: inspection.aircraftType,
      itemType: inspection.itemType,
      position: inspection.position,
      pilotStatus: inspection.pilotStatus,
      pilotNotes: inspection.notes,
    });

    const discrepancy = !!(
      assessment.status &&
      inspection.pilotStatus &&
      (PRI[assessment.status] || 0) > (PRI[inspection.pilotStatus] || 0)
    );
    const finalAssessment = { ...assessment, discrepancy };

    // Write back to the inspection record
    await db.collection('wear-inspections').doc(inspectionId).set({
      aiAssessment: finalAssessment,
      aiCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      aiCheckedAtMs: Date.now(),
    }, { merge: true });

    // Also bubble onto the current wear-items row so the dashboard surfaces it.
    const wearItemId = `${inspection.tail}-${inspection.position}-${inspection.itemType}`;
    await db.collection('wear-items').doc(wearItemId).set({
      aiAssessment: finalAssessment,
    }, { merge: true });

    // Maybe email MX
    await maybeEmailMx({ inspection, assessment: finalAssessment, db });

    return res.status(200).json({ ok: true, assessment: finalAssessment });
  } catch (e) {
    console.error('[wear-vision] error:', e);
    return res.status(500).json({ error: e?.message || 'vision check failed' });
  }
}
