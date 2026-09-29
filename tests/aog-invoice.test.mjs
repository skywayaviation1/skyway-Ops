import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bindLetterContent } from '../src/aog-cfs.js';
import {
  brokerInvoiceDeclinedLetter,
  brokerInvoiceLetter,
  coverageChoiceUrl,
  invoiceApprovalPatch,
  invoiceAutoApproves,
  invoiceDeclinePatch,
  invoiceLineLabel,
  opsInvoiceLetter,
  planInvoiceDecision,
  planInvoiceRequest,
} from '../src/aog-invoice.js';
import { brokerPaidLetter, offerLetter } from '../api/_aog-recovery.js';
import { incidentCfsLetter } from '../src/aog-incident.js';
import { eventDocId } from '../src/aog-reporting.js';
import { cfsTripProjection, projectionLeaks } from '../src/cfs-portal.js';
import { paymentStatusLabel } from '../src/aog-recovery.js';

const root = path.resolve(import.meta.dirname, '..');

const openRecord = {
  tripId: 'TBAE0L',
  coverageLevel: 'included_50',
  upgradeAvailable: true,
  premium: 225,
  premiumCents: 22500,
  tripTotal: 15000,
  tripTotalCents: 1500000,
  signedAt: '2026-09-25T13:27:52Z',
  signedName: 'Andrius Butkus',
  checkoutEmail: 'andrius.butkus@surfair.com',
  brokerCompany: 'Andrius Butkus',
  tail: 'N525CR',
  aircraftType: 'Citation CJ3',
  route: 'DSM → IAD',
  datesLabel: '2026-09-28',
  offerSentAt: '2026-09-25T14:00:00.000Z',
  upgradeMultiplier: 2,
  includedMultiplier: 1.5,
};

test('an invoice request records who asked, the premium, and the trip', () => {
  const plan = planInvoiceRequest(openRecord, {
    name: 'Andrius Butkus',
    email: 'Andrius.Butkus@SurfAir.com',
    atUtc: '2026-09-28T12:00:00.000Z',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.kind, 'create');
  assert.equal(plan.generation, 1);
  assert.equal(plan.request.paymentMethod, 'invoice');
  assert.equal(plan.request.paymentStatus, 'invoice_pending');
  assert.equal(plan.request.invoiceRequestedByName, 'Andrius Butkus');
  assert.equal(plan.request.invoiceRequestedByEmail, 'andrius.butkus@surfair.com');
  assert.equal(plan.request.invoiceRequestedAt, '2026-09-28T12:00:00.000Z');
  assert.equal(plan.request.invoicePremiumCents, 22500);
  assert.equal(plan.request.invoiceTripId, 'TBAE0L');
  assert.equal(plan.request.invoiceLineItem, 'AOG Recovery Coverage, 100% (trip TBAE0L)');
  assert.equal(eventDocId('invoice_requested', { generation: 1 }), 'invoice_requested');
});

test('a second invoice request while one is pending does not create another', () => {
  const pending = {
    ...openRecord,
    ...planInvoiceRequest(openRecord, { name: 'Andrius Butkus', email: 'andrius.butkus@surfair.com' }).request,
  };
  const again = planInvoiceRequest(pending, { name: 'Someone Else', email: 'other@example.test' });
  assert.equal(again.kind, 'duplicate');
  assert.equal(again.generation, 1);
  assert.equal(eventDocId('invoice_requested', { generation: again.generation }), 'invoice_requested');
});

test('approve binds 100% as on invoice unpaid, and a second approve is a no-op', () => {
  const pending = {
    ...openRecord,
    invoiceRequestStatus: 'pending',
    invoiceRequestGeneration: 1,
    invoiceRequestedByName: 'Andrius Butkus',
    invoiceRequestedByEmail: 'andrius.butkus@surfair.com',
    invoicePremiumCents: 22500,
    paymentMethod: 'invoice',
    paymentStatus: 'invoice_pending',
  };
  const decision = planInvoiceDecision(pending, 'approve');
  assert.equal(decision.kind, 'approve');
  const patch = invoiceApprovalPatch(pending, { atUtc: '2026-09-28T13:00:00.000Z', actor: 'jake@flyskyway.com' });
  assert.equal(patch.coverageLevel, 'purchased_100');
  assert.equal(patch.paymentStatus, 'invoice_unpaid');
  assert.equal(patch.paymentMethod, 'invoice');
  assert.deepEqual(patch.emailsToSend, ['cfs_bind', 'broker_invoice']);
  assert.equal(patch.invoiceLineItem, invoiceLineLabel('TBAE0L'));
  assert.equal(paymentStatusLabel(patch.paymentStatus), 'On invoice, unpaid');
  const bound = { ...pending, ...patch };
  assert.equal(planInvoiceDecision(bound, 'approve').kind, 'duplicate');
  assert.equal(eventDocId('invoice_approved', { generation: 1 }), 'invoice_approved');
  const letter = brokerInvoiceLetter(bound);
  const body = `${letter.html}\n${letter.text}`;
  assert.match(body, /will appear on your charter invoice/);
  assert.match(body, /\$225\.00/);
  assert.match(body, /On invoice, unpaid/);
  const bind = bindLetterContent(bound, { ackUrl: 'https://example.test/cfs?ack=token' });
  const bindBody = `${bind.html}\n${bind.text}`;
  assert.equal(/premium/i.test(bindBody), false);
  assert.equal(/invoice/i.test(bindBody), false);
  assert.match(bindBody, /Coverage: 100%/);
});

test('decline leaves card payment open and can be requested again', () => {
  const pending = {
    ...openRecord,
    invoiceRequestStatus: 'pending',
    invoiceRequestGeneration: 1,
    paymentStatus: 'invoice_pending',
    paymentMethod: 'invoice',
  };
  const decision = planInvoiceDecision(pending, 'decline');
  assert.equal(decision.kind, 'decline');
  const patch = invoiceDeclinePatch(pending, { atUtc: '2026-09-28T13:00:00.000Z', actor: 'ops@example-charter.test' });
  assert.equal(patch.invoiceRequestStatus, 'declined');
  assert.equal(patch.paymentStatus, 'offer_pending');
  assert.equal(patch.paymentMethod, '');
  assert.deepEqual(patch.emailsToSend, ['broker_invoice_declined']);
  const letter = brokerInvoiceDeclinedLetter({ ...pending, premium: 225, premiumCents: 22500 });
  assert.match(`${letter.html}\n${letter.text}`, /still pay that premium by card/);
  assert.equal(planInvoiceDecision({ ...pending, ...patch }, 'decline').kind, 'duplicate');
  const again = planInvoiceRequest({ ...pending, ...patch }, {
    name: 'Andrius Butkus',
    email: 'andrius.butkus@surfair.com',
  });
  assert.equal(again.kind, 'create');
  assert.equal(again.generation, 2);
  assert.equal(eventDocId('invoice_requested', { generation: 2 }), 'invoice_requested_2');
});

test('auto-approve is off unless the setting or the broker domain says otherwise', () => {
  assert.equal(invoiceAutoApproves({}, 'andrius.butkus@surfair.com'), false);
  assert.equal(invoiceAutoApproves({ invoiceAutoApprove: false }, 'andrius.butkus@surfair.com'), false);
  assert.equal(invoiceAutoApproves({ invoiceAutoApprove: true }, 'andrius.butkus@surfair.com'), true);
  assert.equal(invoiceAutoApproves({ invoiceAutoApproveDomains: ['surfair.com'] }, 'andrius.butkus@surfair.com'), true);
  assert.equal(invoiceAutoApproves({ invoiceAutoApproveDomains: ['example-charter.test'] }, 'andrius.butkus@surfair.com'), false);
});

test('ops approval email names the trip, broker, and premium with both decisions', () => {
  const letter = opsInvoiceLetter({
    ...openRecord,
    invoiceRequestedByName: 'Andrius Butkus',
    invoiceRequestedByEmail: 'andrius.butkus@surfair.com',
    invoicePremiumCents: 22500,
    invoiceLineItem: invoiceLineLabel('TBAE0L'),
  }, {
    approveUrl: 'https://example.test/aog-invoice?token=abc&decision=approve',
    declineUrl: 'https://example.test/aog-invoice?token=abc&decision=decline',
  });
  const body = `${letter.html}\n${letter.text}`;
  assert.match(body, /TBAE0L/);
  assert.match(body, /Andrius Butkus/);
  assert.match(body, /\$225\.00/);
  assert.match(body, /Approve invoice/);
  assert.match(body, /Decline invoice/);
  assert.match(body, /AOG Recovery Coverage, 100% \(trip TBAE0L\)/);
  const offer = offerLetter(openRecord, 'https://example.test/aog-coverage?token=preview');
  const offerBody = `${offer.html}\n${offer.text}`;
  assert.match(offerBody, /Pay premium by card/);
  assert.match(offerBody, /Add premium to my charter invoice/);
  assert.equal(coverageChoiceUrl('https://example.test/aog-coverage?token=preview', 'invoice').includes('choice=invoice'), true);
});

test('CFS still sees only 100% after an invoice bind', () => {
  const view = cfsTripProjection({
    id: 'cov-tbae',
    tripId: 'TBAE0L',
    coverageLevel: 'purchased_100',
    paymentStatus: 'invoice_unpaid',
    paymentMethod: 'invoice',
    premium: 225,
    premiumCents: 22500,
    invoiceRequestStatus: 'approved',
    invoiceLineItem: invoiceLineLabel('TBAE0L'),
    invoiceRequestedByEmail: 'andrius.butkus@surfair.com',
    tripTotal: 15000,
    tripTotalCents: 1500000,
    upgradeMultiplier: 2,
    coverageLimitCents: 3000000,
    tail: 'N525CR',
    route: 'DSM → IAD',
  });
  assert.equal(view.coverage, '100%');
  const blob = JSON.stringify(view);
  assert.equal(/invoice/i.test(blob), false);
  assert.equal(/premium/i.test(blob), false);
  assert.equal(/payment/i.test(blob), false);
  assert.equal(projectionLeaks(view), false);
  assert.equal(paymentStatusLabel('paid'), 'Paid by card');
  assert.equal(paymentStatusLabel('invoice_paid'), 'On invoice, paid');
});

test('invoice routes are wired for the offer page, the email link, and ops', async () => {
  const publicApi = await readFile(path.join(root, 'api/aog-recovery-public.js'), 'utf8');
  const ops = await readFile(path.join(root, 'api/aog-recovery-ops.js'), 'utf8');
  const settings = await readFile(path.join(root, 'api/aog-recovery-settings.js'), 'utf8');
  const page = await readFile(path.join(root, 'src/AogCoverageOffer.jsx'), 'utf8');
  const decision = await readFile(path.join(root, 'src/AogInvoiceDecision.jsx'), 'utf8');
  assert.match(publicApi, /action === 'invoice'/);
  assert.match(ops, /invoice-decide/);
  assert.match(ops, /invoice-paid/);
  assert.match(settings, /invoiceAutoApprove/);
  assert.match(page, /Add premium to my charter invoice/);
  assert.match(page, /Pay premium by card/);
  assert.match(decision, /\/api\/aog-recovery-invoice/);
  assert.doesNotMatch(page, /End of offer/);
  assert.doesNotMatch(page, /Sign election/);
  assert.match(page, /I agree to the coverage terms/);
});

function assertSansMail(html, label) {
  assert.equal(/Georgia|Times New Roman/.test(html), false, `${label} still uses a serif face`);
  const tags = html.match(/<(td|th|a|h1|h2|h3|p|span)\b[^>]*>/gi) || [];
  assert.ok(tags.length > 3, `${label} has text elements`);
  for (const tag of tags) {
    assert.match(tag, /font-family:[^;"]*sans-serif/i, `${label} missing a sans stack on ${tag}`);
  }
}

test('every AOG email text element uses the sans stack', () => {
  const offer = offerLetter(openRecord, 'https://example.test/aog-coverage?token=preview');
  const paid = brokerPaidLetter({ ...openRecord, coverageLevel: 'purchased_100' });
  const bind = bindLetterContent({ ...openRecord, coverageLevel: 'purchased_100', legCount: 1 }, {
    ackUrl: 'https://example.test/cfs?ack=preview',
    portalUrl: 'https://example.test/cfs',
  });
  const ops = opsInvoiceLetter(openRecord, {
    approveUrl: 'https://example.test/aog-invoice?token=preview-token-123456&decision=approve',
    declineUrl: 'https://example.test/aog-invoice?token=preview-token-123456&decision=decline',
  });
  const incident = incidentCfsLetter({ ...openRecord, coverageBound: true, location: 'KIAD', issue: 'Hydraulic leak' }, 'https://example.test/cfs?aog=preview');
  for (const [label, letter] of [['offer', offer], ['payment', paid], ['bind', bind], ['invoice ops', ops], ['incident', incident]]) {
    assertSansMail(letter.html, label);
  }
  assert.match(offer.html, /\$22,500\.00/);
  assert.match(offer.html, /\$30,000\.00/);
  assert.match(offer.html, /\$225\.00/);
});
