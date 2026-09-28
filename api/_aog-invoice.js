// Invoice-request writes. The planners live in src/aog-invoice.js.
// A second request while one is pending does not send another ops email.
// Approving binds 100% the same way a captured card payment does.

import {
  invoiceApprovalPatch,
  invoiceAutoApproves,
  invoiceDeclinePatch,
  invoiceDecisionView,
  invoicePaidPatch,
  opsInvoiceLetter,
  planInvoiceDecision,
  planInvoiceRequest,
} from '../src/aog-invoice.js';
import { OPS_ACK_TO } from '../src/aog-cfs.js';
import { normalizeTripId } from '../src/trip-id.js';
import {
  COLLECTION,
  appendCoverageEvent,
  dispatchCoverageEmails,
  hashOfferToken,
  newOfferToken,
  reportingPatch,
  sendRecoveryEmail,
} from './_aog-recovery.js';

function fail(plan) {
  const error = new Error(plan.error || 'Invoice request failed');
  error.status = plan.status || 400;
  throw error;
}

export async function findByInvoiceToken(db, token) {
  const hash = hashOfferToken(token);
  if (!hash) return null;
  const snap = await db.collection(COLLECTION).where('invoiceDecisionTokenHash', '==', hash).limit(1).get();
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { id: docSnap.id, ref: docSnap.ref, data: docSnap.data() || {} };
}

export async function findInvoiceForTrip(db, tripId) {
  const code = normalizeTripId(tripId);
  if (!code) return null;
  const snap = await db.collection(COLLECTION).where('tripId', '==', code).limit(8).get();
  const rows = snap.docs.map((docSnap) => ({ id: docSnap.id, ref: docSnap.ref, data: docSnap.data() || {} }));
  const ranked = rows.sort((a, b) => {
    const score = (row) => (row.data.invoiceRequestStatus ? 2 : 0) + (row.data.paymentMethod === 'invoice' ? 1 : 0);
    return score(b) - score(a);
  });
  return ranked[0] || null;
}

export async function requestInvoice(db, ref, record, { name, email, settings, baseUrl } = {}) {
  const atUtc = new Date().toISOString();
  let created = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = { id: ref.id, ...(snap.data() || {}) };
    const plan = planInvoiceRequest({ ...record, ...current }, { name, email, atUtc });
    if (!plan.ok) fail(plan);
    if (plan.kind === 'duplicate') {
      created = { duplicate: true, current };
      return;
    }
    const token = newOfferToken();
    const patch = {
      ...plan.request,
      invoiceDecisionTokenHash: hashOfferToken(token),
      updatedAt: atUtc,
      updatedAtUtc: atUtc,
    };
    tx.set(ref, patch, { merge: true });
    created = { duplicate: false, token, current: { ...current, ...patch }, generation: plan.generation };
  });
  if (created.duplicate) return { duplicate: true, record: created.current, autoApproved: false };

  await appendCoverageEvent(db, ref.id, {
    type: 'invoice_requested',
    generation: created.generation,
    atUtc,
    ...created.current,
    actor: `${created.current.invoiceRequestedByName} <${created.current.invoiceRequestedByEmail}>`,
    amountCents: created.current.invoicePremiumCents,
    detail: created.current.invoiceLineItem,
  });

  const auto = invoiceAutoApproves(settings, created.current.invoiceRequestedByEmail);
  if (auto) {
    const decided = await decideInvoice(db, ref, created.current, {
      decision: 'approve',
      actor: 'auto',
      baseUrl,
      autoApproved: true,
    });
    return { duplicate: false, autoApproved: true, record: decided.record };
  }

  const origin = String(baseUrl || '').replace(/\/$/, '');
  const approveUrl = `${origin}/aog-invoice?token=${encodeURIComponent(created.token)}&decision=approve`;
  const declineUrl = `${origin}/aog-invoice?token=${encodeURIComponent(created.token)}&decision=decline`;
  const letter = opsInvoiceLetter(created.current, { approveUrl, declineUrl });
  await sendRecoveryEmail({
    to: OPS_ACK_TO,
    subject: letter.subject,
    html: letter.html,
    text: letter.text,
  });
  return { duplicate: false, autoApproved: false, record: created.current };
}

export async function decideInvoice(db, ref, record, { decision, actor, baseUrl, autoApproved = false } = {}) {
  const atUtc = new Date().toISOString();
  let outcome = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = { id: ref.id, ...(snap.data() || {}) };
    const plan = planInvoiceDecision(current, decision);
    if (!plan.ok) fail(plan);
    if (plan.kind === 'duplicate') {
      outcome = { duplicate: true, current, decision };
      return;
    }
    const patch = decision === 'approve'
      ? invoiceApprovalPatch(current, { atUtc, actor, autoApproved })
      : invoiceDeclinePatch(current, { atUtc, actor });
    const stored = decision === 'approve'
      ? {
        ...reportingPatch({ ...current, ...patch, createdAt: current.createdAt }),
        paymentMethod: 'invoice',
        invoiceRequestStatus: 'approved',
        invoiceApprovedAt: atUtc,
        invoiceApprovedBy: patch.invoiceApprovedBy,
        invoiceAutoApproved: autoApproved === true,
        invoiceLineItem: patch.invoiceLineItem,
        electedBy: patch.electedBy,
        emailsToSend: patch.emailsToSend,
      }
      : { ...patch, updatedAt: atUtc, updatedAtUtc: atUtc };
    tx.set(ref, stored, { merge: true });
    outcome = { duplicate: false, current: { ...current, ...stored }, patch, generation: plan.generation, decision };
  });

  if (outcome.duplicate) {
    if (decision === 'approve' && (!outcome.current.bindEmailSentAt || !outcome.current.brokerConfirmSentAt)) {
      await dispatchCoverageEmails(db, ref.id, {
        ...outcome.current,
        emailsToSend: ['cfs_bind', 'broker_invoice'],
      }, { baseUrl });
    }
    if (decision === 'decline' && !outcome.current.invoiceDeclineMailAt) {
      await dispatchCoverageEmails(db, ref.id, {
        ...outcome.current,
        emailsToSend: ['broker_invoice_declined'],
      }, { baseUrl });
    }
    return { duplicate: true, record: outcome.current };
  }

  await appendCoverageEvent(db, ref.id, {
    type: decision === 'approve' ? 'invoice_approved' : 'invoice_declined',
    generation: outcome.generation,
    atUtc,
    ...outcome.current,
    actor: actor || '',
    amountCents: outcome.current.invoicePremiumCents || outcome.current.premiumCents,
    detail: decision === 'approve' ? (outcome.current.invoiceLineItem || '') : 'Invoice request declined. Card payment is still open.',
  });

  if (decision === 'approve') {
    await dispatchCoverageEmails(db, ref.id, outcome.current, { baseUrl });
    if (autoApproved) {
      const letter = opsInvoiceLetter(outcome.current, { autoApproved: true });
      await sendRecoveryEmail({
        to: OPS_ACK_TO,
        subject: letter.subject,
        html: letter.html,
        text: letter.text,
      });
    }
  } else {
    await dispatchCoverageEmails(db, ref.id, outcome.current, { baseUrl });
  }
  const fresh = await ref.get();
  return { duplicate: false, record: { id: ref.id, ...(fresh.data() || outcome.current) } };
}

export async function markInvoicePaid(db, ref, record, { actor } = {}) {
  const atUtc = new Date().toISOString();
  let outcome = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = { id: ref.id, ...(snap.data() || {}) };
    if (current.paymentStatus === 'invoice_paid') {
      outcome = { duplicate: true, current };
      return;
    }
    if (current.paymentStatus !== 'invoice_unpaid' || current.paymentMethod !== 'invoice') {
      fail({ status: 409, error: 'This premium is not waiting on an invoice' });
    }
    const patch = { ...invoicePaidPatch({ atUtc, actor }), updatedAt: atUtc, updatedAtUtc: atUtc };
    tx.set(ref, patch, { merge: true });
    outcome = { duplicate: false, current: { ...current, ...patch } };
  });
  if (outcome.duplicate) return { duplicate: true, record: outcome.current };
  await appendCoverageEvent(db, ref.id, {
    type: 'invoice_paid',
    atUtc,
    ...outcome.current,
    actor: actor || '',
    amountCents: outcome.current.invoicePremiumCents || outcome.current.premiumCents,
    detail: 'Premium marked paid on the charter invoice.',
  });
  return { duplicate: false, record: outcome.current };
}

export function invoiceOpsPayload(record) {
  if (!record) return null;
  return invoiceDecisionView(record);
}
