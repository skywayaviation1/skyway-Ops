// Ops actions on coverage records: list, correct uncertain fields, link an
// unmatched checkout to a trip, and resend the offer or the CFS bind email.

import { classifyCheckout, paymentStatusLabel } from '../src/aog-recovery.js';
import {
  COLLECTION,
  assertMutable,
  authorizeOps,
  dispatchCoverageEmails,
  loadSettings,
  publicBaseUrl,
  readJson,
  recoveryDb,
  recomputeOffer,
  serializeCoverage,
} from './_aog-recovery.js';

export const config = { runtime: 'nodejs' };

const EDITABLE = [
  'tripId', 'brokerCompany', 'checkoutEmail', 'tail', 'aircraftType',
  'route', 'routeFrom', 'routeTo', 'departDate', 'returnDate', 'datesLabel', 'tripTotal',
];

function clean(record, key, value) {
  if (key === 'tripTotal') {
    if (value === '' || value == null) return null;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      const error = new Error('Trip total must be a number');
      error.status = 400;
      throw error;
    }
    return Math.round(amount * 100) / 100;
  }
  if (key === 'checkoutEmail') return String(value || '').trim().toLowerCase().slice(0, 160);
  if (key === 'tail' || key === 'routeFrom' || key === 'routeTo') return String(value || '').trim().toUpperCase().slice(0, 16);
  return String(value || '').trim().slice(0, 160);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  try {
    const body = readJson(req);
    await authorizeOps(body.idToken);
    const db = recoveryDb();
    const action = String(body.action || 'list');

    if (action === 'list') {
      const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(500).get();
      res.status(200).json({
        ok: true,
        records: snap.docs.map((docSnap) => serializeCoverage(docSnap.id, docSnap.data())),
      });
      return;
    }

    const id = String(body.coverageId || '').trim();
    if (!id) {
      res.status(400).json({ error: 'coverageId is required' });
      return;
    }
    const ref = db.collection(COLLECTION).doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Coverage record not found' });
      return;
    }
    let record = { id, ...snap.data() };

    if (action === 'link') {
      const tripUid = String(body.tripUid || '').trim();
      if (!tripUid) {
        res.status(400).json({ error: 'tripUid is required' });
        return;
      }
      await ref.set({
        linkedTripUid: tripUid,
        linkedTripUids: [tripUid],
        matchStatus: 'linked',
        matchAmbiguous: false,
        needsReview: (record.uncertainFields || []).length > 0,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'correct') {
      assertMutable(record);
      const patch = { updatedAt: new Date().toISOString() };
      for (const key of EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(body.fields || {}, key)) {
          patch[key] = clean(record, key, body.fields[key]);
        }
      }
      const next = { ...record, ...patch };
      if (!next.route && (next.routeFrom || next.routeTo)) {
        patch.route = [next.routeFrom, next.routeTo].filter(Boolean).join(' → ');
        next.route = patch.route;
      }
      if (!next.datesLabel && (next.departDate || next.returnDate)) {
        patch.datesLabel = [next.departDate, next.returnDate].filter(Boolean).join(' – ');
      }
      const settings = await loadSettings(db);
      if (record.coverageLevel === 'included_50') {
        const actionPlan = classifyCheckout({
          aircraftType: next.aircraftType,
          tripTotal: next.tripTotal,
          checkoutEmail: next.checkoutEmail,
        }, settings);
        if (actionPlan.coverageLevel === 'complimentary_100') {
          Object.assign(patch, {
            coverageLevel: 'complimentary_100',
            paymentStatus: 'complimentary',
            premium: 0,
            premiumCents: 0,
            upgradeAvailable: false,
            electedBy: actionPlan.electedBy,
            emailsToSend: actionPlan.emails,
            stripeAmountCents: null,
            stripeCheckoutSessionId: '',
          });
        } else {
          Object.assign(patch, recomputeOffer(next, settings));
          patch.emailsToSend = patch.upgradeAvailable ? ['broker_offer'] : ['broker_included_only'];
          if (patch.premiumCents !== record.premiumCents) {
            patch.stripeAmountCents = null;
            patch.stripeCheckoutSessionId = '';
          }
        }
      }
      const stillUncertain = (record.uncertainFields || []).filter((field) => {
        if (field === 'tripId') return !next.tripId;
        if (field === 'tail') return !next.tail;
        if (field === 'aircraftType') return !next.aircraftType;
        if (field === 'route') return !next.route;
        if (field === 'dates') return !next.departDate;
        if (field === 'tripTotal') return next.tripTotal == null;
        if (field === 'checkoutEmail') return !next.checkoutEmail;
        return true;
      });
      patch.uncertainFields = stillUncertain;
      patch.needsReview = stillUncertain.length > 0 || next.matchStatus !== 'linked';
      await ref.set(patch, { merge: true });
      const saved = { ...next, ...patch };
      if (patch.coverageLevel === 'complimentary_100') {
        await dispatchCoverageEmails(db, id, { ...saved, coveredNoticeSentAt: '', bindEmailSentAt: record.bindEmailSentAt || '' }, {
          baseUrl: publicBaseUrl(req),
        });
      }
      res.status(200).json({ ok: true, record: serializeCoverage(id, saved) });
      return;
    }

    if (action === 'resend-offer') {
      if (record.upgradeAvailable !== true || !record.checkoutEmail) {
        res.status(400).json({ error: 'There is no payable offer to resend' });
        return;
      }
      const settings = await loadSettings(db);
      const quote = recomputeOffer(record, settings);
      await ref.set({ ...quote, updatedAt: new Date().toISOString() }, { merge: true });
      const sent = await dispatchCoverageEmails(db, id, {
        ...record,
        ...quote,
        emailsToSend: ['broker_offer'],
        offerSentAt: '',
      }, { baseUrl: publicBaseUrl(req), force: true });
      res.status(200).json({ ok: sent.ok, error: sent.error || '', paymentStatus: paymentStatusLabel('offer_pending') });
      return;
    }

    if (action === 'resend-bind') {
      if (!['purchased_100', 'gifted_100', 'complimentary_100'].includes(record.coverageLevel)) {
        res.status(400).json({ error: 'CFS is only notified for 100% coverage' });
        return;
      }
      const sent = await dispatchCoverageEmails(db, id, {
        ...record,
        emailsToSend: ['cfs_bind'],
        bindEmailSentAt: '',
      }, { baseUrl: publicBaseUrl(req), force: true });
      res.status(200).json({ ok: sent.ok, error: sent.error || '' });
      return;
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Request failed' });
  }
}
