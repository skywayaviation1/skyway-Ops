// Ops gifts 100% AOG coverage from a trip page ("added by Skyway") and
// sends the CFS bind email. The broker is not charged.

import { quotePremium } from '../src/aog-recovery.js';
import {
  COLLECTION,
  authorizeOps,
  dispatchCoverageEmails,
  loadSettings,
  publicBaseUrl,
  readJson,
  recoveryDb,
  reportingPatch,
} from './_aog-recovery.js';

export const config = { runtime: 'nodejs' };

function text(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = readJson(req);
    const actor = await authorizeOps(body.idToken);
    const tripUid = text(body.tripUid, 200);
    if (!tripUid) {
      res.status(400).json({ error: 'tripUid is required' });
      return;
    }
    const db = recoveryDb();
    const settings = await loadSettings(db);
    let existing = null;
    const linked = await db.collection(COLLECTION).where('linkedTripUid', '==', tripUid).limit(5).get();
    if (!linked.empty) existing = linked.docs[0];
    if (!existing && body.tripId) {
      const byTrip = await db.collection(COLLECTION).where('tripId', '==', text(body.tripId, 80)).limit(5).get();
      existing = byTrip.docs.find((docSnap) => !docSnap.data().linkedTripUid || docSnap.data().linkedTripUid === tripUid) || null;
    }

    if (existing) {
      const data = existing.data() || {};
      if (data.paymentStatus === 'paid' || data.coverageLevel === 'purchased_100') {
        res.status(409).json({ error: 'This trip already has paid 100% coverage' });
        return;
      }
      if (data.coverageLevel === 'gifted_100' && data.bindEmailSentAt && body.force !== true) {
        res.status(200).json({ ok: true, alreadyGifted: true, coverageId: existing.id });
        return;
      }
    }

    const tripTotal = body.tripTotal === '' || body.tripTotal == null ? null : Number(body.tripTotal);
    const aircraftType = text(body.aircraftType, 80);
    const quote = quotePremium({ aircraftType, tripTotal, rates: settings.rates });
    const now = new Date().toISOString();
    const electedBy = `${actor.name || actor.email} (added by Skyway)`;
    const record = {
      source: existing?.data()?.source || 'gift',
      tripId: text(body.tripId, 80) || existing?.data()?.tripId || '',
      brokerCompany: text(body.brokerCompany, 120) || existing?.data()?.brokerCompany || '',
      checkoutEmail: text(body.checkoutEmail || body.brokerEmail, 160).toLowerCase() || existing?.data()?.checkoutEmail || '',
      tail: text(body.tail, 16).toUpperCase(),
      aircraftType: quote.aircraftType || aircraftType,
      routeFrom: text(body.routeFrom, 8).toUpperCase(),
      routeTo: text(body.routeTo, 8).toUpperCase(),
      route: [text(body.routeFrom, 8), text(body.routeTo, 8)].filter(Boolean).join(' → ').toUpperCase() || existing?.data()?.route || '',
      departDate: text(body.departDate, 40),
      returnDate: text(body.returnDate, 40),
      datesLabel: [text(body.departDate, 40), text(body.returnDate, 40)].filter(Boolean).join(' – '),
      tripTotal: Number.isFinite(tripTotal) ? Math.round(tripTotal * 100) / 100 : (existing?.data()?.tripTotal ?? null),
      coverageLevel: 'gifted_100',
      premium: 0,
      premiumCents: 0,
      ratePercent: quote.ratePercent ?? null,
      paymentStatus: 'gifted',
      upgradeAvailable: false,
      stripeReference: '',
      electedBy,
      addedBy: actor.email,
      matchStatus: 'linked',
      linkedTripUid: tripUid,
      linkedTripUids: [tripUid],
      needsReview: false,
      uncertainFields: [],
      emailsToSend: ['cfs_bind'],
      charterContractPath: existing?.data()?.charterContractPath || '',
      charterContractFilename: existing?.data()?.charterContractFilename || '',
      electionContractPath: existing?.data()?.electionContractPath || '',
      createdAt: existing?.data()?.createdAt || now,
    };
    Object.assign(record, reportingPatch({
      ...record,
      includedMultiplier: settings.includedMultiplier,
      includedMultiplierExplicit: settings.includedMultiplierExplicit === true,
      upgradeMultiplier: settings.upgradeMultiplier,
    }));
    if (!Number.isFinite(record.tripTotal)) record.needsReview = true;

    const ref = existing ? existing.ref : db.collection(COLLECTION).doc();
    await ref.set(record, { merge: true });
    const sent = await dispatchCoverageEmails(db, ref.id, { ...record, bindEmailSentAt: '' }, {
      baseUrl: publicBaseUrl(req),
      force: true,
    });
    res.status(200).json({ ok: true, coverageId: ref.id, emailError: sent.error || '' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Gift failed' });
  }
}
