// Ops actions on coverage records: list, correct uncertain fields, link an
// unmatched checkout to a trip, and resend the offer or the CFS bind email.

import { classifyCheckout, paymentStatusLabel } from '../src/aog-recovery.js';
import { decideInvoice, findInvoiceForTrip, invoiceOpsPayload, markInvoicePaid } from './_aog-invoice.js';
import { createAogIncident, listAogIncidents, postAogUpdate } from './_aog-incident.js';
import {
  COLLECTION,
  assertMutable,
  authorizeOps,
  dispatchCoverageEmails,
  listCoverageEvents,
  listCoverageRecords,
  listScheduleLegs,
  loadSettings,
  pdfBufferFromBody,
  previewUploadedContract,
  publicBaseUrl,
  readJson,
  readPdf,
  recoveryDb,
  recomputeOffer,
  reportingPatch,
  resolveTripLegs,
  saveUploadedContract,
  serializeCoverage,
  syncConfirmedCoverageValue,
  writeCharterContract,
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
    const actor = await authorizeOps(body.idToken);
    const db = recoveryDb();
    const action = String(body.action || 'list');

    if (action === 'list') {
      const records = await listCoverageRecords(db);
      res.status(200).json({ ok: true, records });
      return;
    }

    if (action === 'report-aog') {
      const result = await createAogIncident(db, body, {
        actor: actor.email,
        baseUrl: publicBaseUrl(req),
      });
      res.status(200).json({
        ok: true,
        duplicate: result.duplicate === true,
        notified: result.notified === true,
        reason: result.reason || '',
        message: result.notified
          ? 'Charter Flight Support was notified.'
          : `Recorded for Charter Flight Support. Mail: ${result.emailError || 'not sent'}`,
        incident: {
          id: result.incident.id,
          tripId: result.incident.tripId,
          status: result.incident.status,
          location: result.incident.location,
        },
      });
      return;
    }

    if (action === 'aog-update' || action === 'aog-resolve') {
      const incident = await postAogUpdate(db, {
        id: body.incidentId,
        text: body.text,
        actor: actor.email,
        resolve: action === 'aog-resolve',
      });
      res.status(200).json({ ok: true, status: incident.status });
      return;
    }

    if (action === 'aog-list') {
      const incidents = await listAogIncidents(db);
      res.status(200).json({
        ok: true,
        incidents: incidents.map((row) => ({
          id: row.id,
          tripId: row.tripId,
          status: row.status,
          location: row.location,
          aogAt: row.aogAt,
          issue: row.issue,
          notified: row.cfsNotified === true,
          reason: row.notifyBlockReason || '',
          createdAt: row.createdAt || '',
        })),
      });
      return;
    }

    if (action === 'schedule') {
      const schedule = await listScheduleLegs(db);
      res.status(200).json({ ok: true, ...schedule });
      return;
    }

    if (action === 'preview-contract') {
      const pdfBuffer = pdfBufferFromBody(body);
      const parsed = previewUploadedContract({
        pdfBuffer,
        filename: String(body.filename || 'charter-contract.pdf'),
        text: String(body.text || ''),
      });
      const settings = await loadSettings(db);
      const proposal = classifyCheckout(parsed, settings);
      res.status(200).json({
        ok: true,
        parsed: {
          tripId: parsed.tripId || '',
          brokerCompany: parsed.brokerCompany || '',
          checkoutEmail: parsed.checkoutEmail || '',
          tail: parsed.tail || '',
          aircraftType: parsed.aircraftType || '',
          route: parsed.route || '',
          routeFrom: parsed.routeFrom || '',
          routeTo: parsed.routeTo || '',
          departDate: parsed.departDate || '',
          returnDate: parsed.returnDate || '',
          datesLabel: parsed.datesLabel || '',
          passengerCount: parsed.passengerCount ?? null,
          legs: parsed.legs || [],
          contractSignedAt: parsed.signedAt || '',
          tripTotal: parsed.tripTotal ?? null,
          uncertainFields: parsed.uncertainFields || [],
          notes: parsed.notes || [],
          isCheckout: parsed.isCheckout === true,
        },
        proposal: {
          coverageLevel: proposal.coverageLevel,
          paymentStatus: proposal.paymentStatus,
          premium: proposal.premium,
          emails: proposal.emails,
        },
      });
      return;
    }

    if (action === 'save-contract') {
      const pdfBuffer = pdfBufferFromBody(body);
      const saved = await saveUploadedContract(db, {
        pdfBuffer,
        filename: String(body.filename || 'charter-contract.pdf').slice(0, 180),
        tripId: body.tripId,
        legUids: Array.isArray(body.legUids) ? body.legUids : [],
        fields: body.fields || {},
        actor,
        baseUrl: publicBaseUrl(req),
      });
      res.status(200).json({ ok: true, ...saved });
      return;
    }

    if (action === 'invoice-for-trip') {
      const found = await findInvoiceForTrip(db, body.tripId);
      const invoice = found && (found.data.invoiceRequestStatus || found.data.paymentMethod === 'invoice')
        ? invoiceOpsPayload({ id: found.id, ...found.data })
        : null;
      res.status(200).json({
        ok: true,
        invoice: invoice ? { ...invoice, paymentLabel: paymentStatusLabel(found.data.paymentStatus) } : null,
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

    if (action === 'events') {
      const events = await listCoverageEvents(db, id);
      res.status(200).json({ ok: true, events });
      return;
    }

    if (action === 'link' || action === 'attach-contract') {
      const tripUid = String(body.tripUid || '').trim();
      if (!tripUid) {
        res.status(400).json({ error: 'tripUid is required' });
        return;
      }
      const legs = await resolveTripLegs(db, tripUid);
      if (legs.length === 0) {
        res.status(404).json({ error: 'No trip found for that id. Open the trip once so the leg exists, then paste the leg uid or the trip id.' });
        return;
      }
      const patch = {
        linkedTripUid: legs[0].id,
        linkedTripUids: legs.map((leg) => leg.id),
        matchStatus: 'linked',
        matchAmbiguous: false,
        needsReview: (record.uncertainFields || []).length > 0,
        updatedAt: new Date().toISOString(),
      };
      if (record.charterContractPath) {
        const pdfBuffer = await readPdf(record.charterContractPath);
        const attached = await writeCharterContract(db, {
          legs,
          pdfBuffer,
          filename: record.charterContractFilename || 'charter-contract.pdf',
          source: record.contractSource || {
            messageId: record.graphMessageId || '',
            receivedAt: record.createdAt || '',
            sender: record.checkoutEmail || '',
          },
          tripKey: legs.find((leg) => leg.tripCode)?.tripCode || record.tripId || tripUid,
          facts: { ...record, legCount: legs.length },
        });
        Object.assign(patch, {
          contractAttachStatus: attached.contractAttachStatus,
          contractLegIds: attached.contractLegIds || [],
          contractFingerprint: attached.contractFingerprint || record.contractFingerprint || '',
          contractCandidateTripUids: [],
          contractAmbiguous: false,
          contractAttachError: '',
        });
      } else if (action === 'attach-contract') {
        res.status(400).json({ error: 'This record has no charter contract PDF' });
        return;
      }
      await ref.set(patch, { merge: true });
      res.status(200).json({
        ok: true,
        contractAttachStatus: patch.contractAttachStatus || '',
        contractLegIds: patch.contractLegIds || [],
      });
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
      Object.assign(patch, reportingPatch({
        ...record,
        ...next,
        ...patch,
        includedMultiplier: settings.includedMultiplier,
        includedMultiplierExplicit: settings.includedMultiplierExplicit === true,
        upgradeMultiplier: settings.upgradeMultiplier,
        brokerEmail: patch.checkoutEmail || next.checkoutEmail || '',
        createdAt: record.createdAt,
      }));
      await ref.set(patch, { merge: true });
      const saved = { ...next, ...patch };
      await syncConfirmedCoverageValue(db, saved);
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

    if (action === 'invoice-decide') {
      const decision = String(body.decision || '');
      const result = await decideInvoice(db, ref, record, {
        decision,
        actor: actor.email,
        baseUrl: publicBaseUrl(req),
      });
      res.status(200).json({
        ok: true,
        duplicate: result.duplicate === true,
        invoice: { ...invoiceOpsPayload(result.record), paymentLabel: paymentStatusLabel(result.record.paymentStatus) },
      });
      return;
    }

    if (action === 'invoice-paid') {
      const result = await markInvoicePaid(db, ref, record, { actor: actor.email });
      res.status(200).json({
        ok: true,
        duplicate: result.duplicate === true,
        invoice: { ...invoiceOpsPayload(result.record), paymentLabel: paymentStatusLabel(result.record.paymentStatus) },
      });
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
