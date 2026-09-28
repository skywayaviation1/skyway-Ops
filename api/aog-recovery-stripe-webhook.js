// Stripe webhook. Verifies the signature against the raw body, then records
// a paid premium and sends the CFS bind email plus the broker confirmation.
// Checkout success URLs are not treated as payment.

import { stripeClient } from './_aog-stripe.js';
import { paymentDecision } from '../src/aog-recovery.js';
import {
  COLLECTION,
  appendCoverageEvent,
  dispatchCoverageEmails,
  publicBaseUrl,
  recoveryDb,
  reportingPatch,
} from './_aog-recovery.js';

export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'STRIPE_WEBHOOK_SECRET is not configured' });
    return;
  }

  let event;
  try {
    const raw = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripeClient().webhooks.constructEvent(raw, signature, secret);
  } catch (err) {
    res.status(400).json({ error: `Webhook signature failed: ${err.message}` });
    return;
  }

  if (event.type === 'charge.refunded') {
    try {
      const charge = event.data?.object || {};
      const paymentIntentId = String(charge.payment_intent || '');
      const refundId = charge.refunds?.data?.[0]?.id || '';
      if (!paymentIntentId) {
        res.status(200).json({ ok: true, ignored: 'refund without payment intent' });
        return;
      }
      const db = recoveryDb();
      const snap = await db.collection(COLLECTION).where('stripePaymentIntentId', '==', paymentIntentId).limit(1).get();
      if (snap.empty) {
        res.status(200).json({ ok: true, ignored: 'refund for unknown coverage' });
        return;
      }
      const docSnap = snap.docs[0];
      const record = { id: docSnap.id, ...docSnap.data() };
      const atUtc = new Date().toISOString();
      await docSnap.ref.set({
        ...reportingPatch({
          ...record,
          paymentStatus: 'refunded',
          stripeRefundId: refundId,
          stripeEventId: event.id,
          createdAt: record.createdAt,
        }),
      }, { merge: true });
      await appendCoverageEvent(db, docSnap.id, {
        type: 'refunded',
        atUtc,
        ...record,
        paymentStatus: 'refunded',
        stripeRefundId: refundId,
        stripeEventId: event.id,
        amountCents: charge.amount_refunded,
        actor: 'stripe',
      });
      res.status(200).json({ ok: true, action: 'refunded' });
    } catch (err) {
      console.error('[aog-recovery] refund handling failed', err.message);
      res.status(500).json({ error: 'Webhook handling failed' });
    }
    return;
  }

  if (event.type !== 'checkout.session.completed') {
    res.status(200).json({ ok: true, ignored: event.type });
    return;
  }

  try {
    const session = event.data?.object || {};
    const coverageId = session.metadata?.coverageId || session.client_reference_id;
    if (!coverageId) {
      res.status(200).json({ ok: true, ignored: 'no coverage id' });
      return;
    }
    const db = recoveryDb();
    const ref = db.collection(COLLECTION).doc(String(coverageId));
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(200).json({ ok: true, ignored: 'unknown coverage' });
      return;
    }
    const record = { id: snap.id, ...snap.data() };
    const decision = paymentDecision({ record, session });
    if (decision.action === 'duplicate' || decision.action === 'ignore') {
      res.status(200).json({ ok: true, action: decision.action, reason: decision.reason || '' });
      return;
    }
    if (decision.action === 'reject') {
      await ref.set({
        paymentMismatch: true,
        paymentMismatchReason: decision.reason,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
      res.status(200).json({ ok: true, action: 'reject', reason: decision.reason });
      return;
    }

    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : '';
    const paidAt = new Date().toISOString();
    const paid = {
      ...record,
      coverageLevel: 'purchased_100',
      electionSource: 'purchased',
      paymentStatus: 'paid',
      premiumCents: decision.amountCents,
      premium: decision.amountCents / 100,
      stripeReference: decision.stripeReference,
      stripePaymentIntentId: paymentIntentId,
      stripeCheckoutSessionId: session.id || record.stripeCheckoutSessionId || '',
      stripeEventId: event.id,
      electedBy: record.signedName
        ? `${record.signedName} <${record.checkoutEmail || ''}>`.trim()
        : (record.checkoutEmail || 'Broker'),
      emailsToSend: ['cfs_bind', 'broker_paid'],
    };
    await ref.set({
      ...reportingPatch({ ...paid, createdAt: record.createdAt }),
      stripeReference: paid.stripeReference,
      electedBy: paid.electedBy,
      paidAt,
      paymentMismatch: false,
      paymentMethod: 'card',
      invoiceRequestStatus: record.invoiceRequestStatus === 'pending' ? 'withdrawn' : (record.invoiceRequestStatus || ''),
    }, { merge: true });
    await appendCoverageEvent(db, snap.id, {
      type: 'paid',
      atUtc: paidAt,
      ...paid,
      amountCents: decision.amountCents,
      actor: paid.electedBy,
    });
    await dispatchCoverageEmails(db, snap.id, paid, { baseUrl: publicBaseUrl(req) });
    res.status(200).json({ ok: true, action: 'capture' });
  } catch (err) {
    console.error('[aog-recovery] webhook handling failed', err.message);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
}
