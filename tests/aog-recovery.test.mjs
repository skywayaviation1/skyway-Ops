import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseCheckoutEmail } from '../api/_aog-checkout-parser.js';
import { renderElectionPdf } from '../api/_aog-election-pdf.js';
import { applyNotifyTestMode, notifyTestModeEnabled, notifyTestRecipient } from '../api/_notify-test-mode.js';
import { assertStripeTestKey, buildCheckoutSessionParams, stripeClient } from '../api/_aog-stripe.js';
import {
  buildCoverageDraft,
  classifyCheckout,
  coverageCsv,
  findRate,
  isComplimentaryDomain,
  matchCoverageToTrips,
  paymentDecision,
  quotePremium,
} from '../src/aog-recovery.js';
import {
  contractStoragePath,
  contractVersionPath,
  isUnmatchedContract,
  matchContractToTrips,
  planContractWrite,
  shouldAttachCharterContract,
} from '../src/charter-contract.js';

const fixtureDir = path.resolve(import.meta.dirname, 'fixtures/aog-checkout');

async function loadFixture(name) {
  const raw = await readFile(path.join(fixtureDir, name), 'utf8');
  const [header, body = ''] = raw.split(/\n\n/);
  const fields = {};
  for (const line of header.split('\n')) {
    const split = line.indexOf(':');
    if (split > 0) fields[line.slice(0, split).trim().toUpperCase()] = line.slice(split + 1).trim();
  }
  return {
    subject: fields.SUBJECT || '',
    from: fields.FROM || '',
    attachmentNames: (fields.ATTACHMENTS || '').split(',').map((item) => item.trim()).filter(Boolean),
    bodyText: body.trim(),
    hasPdf: /\.pdf/i.test(fields.ATTACHMENTS || ''),
  };
}

test('provisional parser reads a synthetic CJ3 checkout and flags nothing required', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('cj3-checkout.txt'), {
    knownAircraft: ['Citation CJ3', 'Learjet 60'],
  });
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.parserVersion, 'provisional-1');
  assert.equal(parsed.tripId, 'SKY-TEST-1001');
  assert.equal(parsed.tail, 'N100TS');
  assert.equal(parsed.aircraftType, 'Citation CJ3');
  assert.equal(parsed.routeFrom, 'KAPF');
  assert.equal(parsed.routeTo, 'KTEB');
  assert.equal(parsed.departDate, '2026-10-12');
  assert.equal(parsed.returnDate, '2026-10-14');
  assert.equal(parsed.tripTotal, 18500);
  assert.equal(parsed.checkoutEmail, 'broker@example-charter.test');
  assert.equal(parsed.brokerCompany, 'Example Charter Group');
  assert.deepEqual(parsed.uncertainFields, []);
  assert.match(parsed.notes.join(' '), /provisional-1/);
});

test('provisional parser reads a synthetic Lear checkout', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('lear-checkout.txt'));
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.tripId, 'SKY-TEST-2002');
  assert.equal(parsed.aircraftType, 'Learjet 60');
  assert.equal(parsed.tail, 'N200TS');
  assert.equal(parsed.tripTotal, 24000);
  assert.equal(parsed.departDate, '2026-10-20');
  assert.equal(parsed.checkoutEmail, 'dispatch@example-lear.test');
});

test('disagreeing labeled totals are kept unset and flagged', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('ambiguous-total.txt'));
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.tripTotal, null);
  assert.equal(parsed.confidence.tripTotal, 'low');
  assert.ok(parsed.uncertainFields.includes('tripTotal'));
});

test('a catering PDF is not a charter checkout', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('catering-not-checkout.txt'));
  assert.equal(parsed.isCheckout, false);
  assert.match(parsed.skipReason, /not look like a charter checkout/);
});

test('a checkout missing the tail is still recorded as uncertain', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('missing-tail.txt'));
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.tail, null);
  assert.ok(parsed.uncertainFields.includes('tail'));
  assert.equal(parsed.confidence.tripId, 'high');
});

test('premium is a percentage of the trip total and never the trip itself', () => {
  const cj3 = quotePremium({ aircraftType: 'CJ3', tripTotal: 18500 });
  assert.equal(cj3.eligible, true);
  assert.equal(cj3.aircraftType, 'Citation CJ3');
  assert.equal(cj3.ratePercent, 1.5);
  assert.equal(cj3.premium, 277.5);
  assert.equal(cj3.premiumCents, 27750);
  assert.ok(cj3.premiumCents < Math.round(18500 * 100));

  const lear = quotePremium({ aircraftType: 'Lear 60', tripTotal: 24000 });
  assert.equal(lear.premium, 480);
  assert.equal(lear.ratePercent, 2);

  const unknown = quotePremium({ aircraftType: 'Citation CJ1', tripTotal: 10000 });
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.reason, 'no_rate');
  assert.equal(findRate('Helicopter'), null);
});

test('complimentary domains get 100% and a CFS bind, and 50% does not', () => {
  const settings = {
    rates: [
      { aircraftType: 'Citation CJ3', ratePercent: 1.5, aliases: ['CJ3'] },
      { aircraftType: 'Learjet 60', ratePercent: 2, aliases: ['Learjet 60'] },
    ],
    complimentaryDomains: ['example-charter.test'],
  };
  const parsed = {
    aircraftType: 'Citation CJ3',
    tripTotal: 10000,
    checkoutEmail: 'desk@mail.example-charter.test',
  };
  assert.equal(isComplimentaryDomain(parsed.checkoutEmail, settings.complimentaryDomains), true);
  assert.equal(isComplimentaryDomain('jake@flyskyway.com', settings.complimentaryDomains), false);
  const complimentary = classifyCheckout(parsed, settings);
  assert.equal(complimentary.coverageLevel, 'complimentary_100');
  assert.equal(complimentary.premium, 0);
  assert.deepEqual(complimentary.emails, ['broker_covered', 'cfs_bind']);

  const paid = classifyCheckout({ ...parsed, checkoutEmail: 'buyer@other-example.test' }, settings);
  assert.equal(paid.coverageLevel, 'included_50');
  assert.equal(paid.premium, 150);
  assert.deepEqual(paid.emails, ['broker_offer']);
  assert.equal(paid.emails.includes('cfs_bind'), false);

  const noRate = classifyCheckout({
    aircraftType: 'Citation CJ1',
    tripTotal: 10000,
    checkoutEmail: 'buyer@other-example.test',
  }, settings);
  assert.equal(noRate.upgradeAvailable, false);
  assert.equal(noRate.emails.includes('cfs_bind'), false);
});

test('trip id links every matching leg and a lone tail does not', () => {
  const trips = [
    { id: 'leg-a', tripCode: 'SKY-TEST-1001', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-10-12T14:00:00.000Z' },
    { id: 'leg-b', tripCode: 'SKY-TEST-1001', tail: 'N100TS', from: 'KTEB', to: 'KAPF', start: '2026-10-14T18:00:00.000Z' },
    { id: 'other', tripCode: 'SKY-TEST-9', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-01-01T14:00:00.000Z' },
  ];
  const linked = matchCoverageToTrips({
    tripId: 'SKY-TEST-1001', tail: 'N100TS', routeFrom: 'KAPF', routeTo: 'KTEB', departDate: '2026-10-12',
  }, trips);
  assert.equal(linked.status, 'linked');
  assert.deepEqual(linked.matches.map((trip) => trip.id).sort(), ['leg-a', 'leg-b']);

  const tailOnly = matchCoverageToTrips({ tail: 'N100TS' }, trips);
  assert.equal(tailOnly.status, 'unmatched');

  const draft = buildCoverageDraft({
    parsed: {
      tripId: 'SKY-TEST-9',
      tail: null,
      aircraftType: 'Citation CJ3',
      tripTotal: 10000,
      checkoutEmail: 'buyer@other-example.test',
      uncertainFields: ['tail'],
      notes: ['Tail missing'],
      parserVersion: 'provisional-1',
    },
    settings: { complimentaryDomains: [] },
    match: tailOnly,
    messageId: 'graph-message-1',
  });
  assert.equal(draft.needsReview, true);
  assert.equal(draft.matchStatus, 'unmatched');
  assert.equal(draft.coverageLevel, 'included_50');
});

test('charter contract follows the trip id onto every leg, then tail route and date', () => {
  const trips = [
    { id: 'leg-a', tripCode: 'SKY-TEST-1001', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-10-12T14:00:00.000Z' },
    { id: 'leg-b', tripCode: 'SKY-TEST-1001', tail: 'N100TS', from: 'KTEB', to: 'KAPF', start: '2026-10-14T18:00:00.000Z' },
    { id: 'other', tripCode: 'SKY-TEST-9', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-10-12T14:00:00.000Z' },
  ];
  const byId = matchContractToTrips({
    tripId: 'SKY-TEST-1001', tail: 'N999XX', routeFrom: 'KORD', routeTo: 'KJFK', departDate: '2026-01-01',
  }, trips);
  assert.equal(byId.status, 'linked');
  assert.equal(byId.via, 'trip-id');
  assert.deepEqual(byId.matches.map((trip) => trip.id).sort(), ['leg-a', 'leg-b']);

  const byFallback = matchContractToTrips({
    tripId: 'SKY-TEST-MISSING',
    tail: 'N100TS',
    routeFrom: 'KAPF',
    routeTo: 'KTEB',
    departDate: '2026-10-12',
  }, trips);
  assert.equal(byFallback.status, 'unmatched');
  assert.equal(byFallback.ambiguous, true);

  const unique = trips.filter((trip) => trip.tripCode !== 'SKY-TEST-9');
  const dated = matchContractToTrips({
    tail: 'N100TS', routeFrom: 'APF', routeTo: 'TEB', departDate: '2026-10-12',
  }, unique);
  assert.equal(dated.status, 'linked');
  assert.equal(dated.via, 'tail-route-date');
  assert.deepEqual(dated.matches.map((trip) => trip.id).sort(), ['leg-a', 'leg-b']);

  const noDate = matchContractToTrips({ tail: 'N100TS', routeFrom: 'KAPF', routeTo: 'KTEB' }, unique);
  assert.equal(noDate.status, 'unmatched');
  assert.equal(matchContractToTrips({ tail: 'N100TS' }, unique).status, 'unmatched');
});

test('the same charter PDF is not duplicated, and a new one is versioned with the source email', () => {
  assert.equal(shouldAttachCharterContract({ isCheckout: true, hasPdf: true }), true);
  assert.equal(shouldAttachCharterContract({ isCheckout: true, hasPdf: false }), false);
  const source = {
    messageId: 'graph-message-synthetic-1',
    receivedAt: '2026-10-01T15:00:00.000Z',
    sender: 'broker@example-charter.test',
  };
  const first = planContractWrite({
    incoming: {
      fingerprint: 'abc123',
      filename: 'synthetic-charter.pdf',
      path: contractStoragePath('SKY-TEST-1001'),
      sizeBytes: 1200,
      source,
      attachedAt: '2026-10-01T15:04:00.000Z',
    },
  });
  assert.equal(first.action, 'attached');
  assert.equal(first.contract.path, 'trip-contracts/SKY-TEST-1001/charter-contract.pdf');
  assert.equal(first.contract.source.messageId, source.messageId);
  assert.equal(first.contract.source.sender, source.sender);
  assert.equal(first.contract.source.receivedAt, source.receivedAt);
  assert.deepEqual(first.contract.versions, []);

  const again = planContractWrite({
    existing: first.contract,
    incoming: {
      fingerprint: 'abc123',
      filename: 'synthetic-charter.pdf',
      path: contractStoragePath('SKY-TEST-1001'),
      source: { ...source, messageId: 'graph-message-synthetic-2' },
      attachedAt: '2026-10-02T15:04:00.000Z',
    },
  });
  assert.equal(again.action, 'unchanged');
  assert.equal(again.contract.source.messageId, 'graph-message-synthetic-1');

  const versionPath = contractVersionPath('SKY-TEST-1001', 'abc123');
  const replaced = planContractWrite({
    existing: first.contract,
    versionPath,
    incoming: {
      fingerprint: 'def456',
      filename: 'synthetic-charter-revised.pdf',
      path: contractStoragePath('SKY-TEST-1001'),
      source: { ...source, messageId: 'graph-message-synthetic-3', sender: 'dispatch@example-charter.test' },
      attachedAt: '2026-10-03T15:04:00.000Z',
    },
  });
  assert.equal(replaced.action, 'replaced');
  assert.equal(replaced.contract.fingerprint, 'def456');
  assert.equal(replaced.contract.source.messageId, 'graph-message-synthetic-3');
  assert.equal(replaced.contract.versions.length, 1);
  assert.equal(replaced.contract.versions[0].fingerprint, 'abc123');
  assert.equal(replaced.contract.versions[0].path, versionPath);
  assert.equal(replaced.contract.versions[0].source.sender, 'broker@example-charter.test');
  assert.equal(isUnmatchedContract({ charterContractPath: 'aog-recovery/x/charter-contract.pdf', contractAttachStatus: 'unmatched' }), true);
  assert.equal(isUnmatchedContract({ charterContractPath: 'aog-recovery/x/charter-contract.pdf', contractAttachStatus: 'attached' }), false);
  assert.equal(isUnmatchedContract({ charterContractPath: 'aog-recovery/x/charter-contract.pdf', contractAttachStatus: 'unchanged' }), false);
  assert.equal(isUnmatchedContract({ contractAttachStatus: 'unmatched' }), false);
});

test('notify test mode is on unless explicitly disabled and rewrites the whole envelope', () => {
  assert.equal(notifyTestModeEnabled({}), true);
  assert.equal(notifyTestModeEnabled({ NOTIFY_TEST_MODE: '' }), true);
  assert.equal(notifyTestModeEnabled({ NOTIFY_TEST_MODE: 'true' }), true);
  assert.equal(notifyTestModeEnabled({ NOTIFY_TEST_MODE: 'false' }), false);
  assert.equal(notifyTestModeEnabled({ NOTIFY_TEST_MODE: 'OFF' }), false);
  assert.equal(notifyTestRecipient({}), 'jake@flyskyway.com');
  assert.equal(notifyTestRecipient({ NOTIFY_TEST_RECIPIENT: 'qa@example.test' }), 'qa@example.test');

  const safe = applyNotifyTestMode({
    to: 'broker@example-charter.test',
    cc: ['charters@flyskyway.com'],
    bcc: 'hidden@example.test',
    subject: 'AOG coverage bind request',
    text: 'Trip SKY-TEST-1001',
    html: '<p>Trip SKY-TEST-1001</p>',
  }, {});
  assert.equal(safe.testMode, true);
  assert.deepEqual(safe.to, ['jake@flyskyway.com']);
  assert.deepEqual(safe.cc, []);
  assert.deepEqual(safe.bcc, []);
  assert.equal(safe.subject, '[TEST] AOG coverage bind request');
  assert.match(safe.text, /^TEST MODE/);
  assert.match(safe.text, /To: broker@example-charter\.test/);
  assert.match(safe.text, /Cc: charters@flyskyway\.com/);
  assert.match(safe.text, /Bcc: hidden@example\.test/);
  assert.match(safe.html, /TEST MODE/);
  assert.match(safe.html, /broker@example-charter\.test/);

  const live = applyNotifyTestMode({
    to: ['charter@charterflightsupport.com'],
    cc: 'charters@flyskyway.com',
    subject: '[TEST] already',
    text: 'Bind',
  }, { NOTIFY_TEST_MODE: 'false' });
  assert.equal(live.testMode, false);
  assert.deepEqual(live.to, ['charter@charterflightsupport.com']);
  assert.deepEqual(live.cc, ['charters@flyskyway.com']);
  assert.equal(live.subject, '[TEST] already');
});

test('checkout session charges the server premium and refuses live keys', () => {
  assert.throws(() => assertStripeTestKey(''), /not configured/);
  assert.throws(() => assertStripeTestKey('sk_live_example'), /Live Stripe keys are refused/);
  assert.throws(() => assertStripeTestKey('rk_live_example'), /Live Stripe keys are refused/);
  assert.equal(assertStripeTestKey('sk_test_example'), 'sk_test_example');
  assert.equal(assertStripeTestKey('rk_test_example'), 'rk_test_example');

  const params = buildCheckoutSessionParams({
    record: {
      id: 'cov_test',
      tripId: 'SKY-TEST-1001',
      tail: 'N100TS',
      tripTotal: 18500,
      checkoutEmail: 'broker@example-charter.test',
    },
    amountCents: 27750,
    successUrl: 'https://example.test/aog-coverage?result=success&session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://example.test/aog-coverage?result=cancel',
  });
  assert.equal(params.line_items[0].price_data.unit_amount, 27750);
  assert.equal(params.mode, 'payment');
  assert.equal(params.payment_method_types, undefined);
  assert.equal(params.metadata.coverageProduct, 'aog-recovery');
  assert.match(params.integration_identifier, /^aog_recovery_[a-z]{8}$/);
  assert.throws(() => buildCheckoutSessionParams({
    record: { id: 'cov_test', tripTotal: 100 },
    amountCents: 10000,
    successUrl: 'https://example.test/ok',
    cancelUrl: 'https://example.test/cancel',
  }), /trip total/);
});

test('stripe webhook signature verifies and only a matching premium captures', () => {
  const stripe = stripeClient('sk_test_example');
  const payload = JSON.stringify({
    id: 'evt_test_aog',
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_aog' } },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_aog' });
  const event = stripe.webhooks.constructEvent(payload, header, 'whsec_test_aog');
  assert.equal(event.type, 'checkout.session.completed');
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, 'whsec_wrong'), /signature/i);

  const record = {
    id: 'cov_test',
    tripTotal: 18500,
    premiumCents: 27750,
    stripeAmountCents: 27750,
    paymentStatus: 'awaiting_payment',
    coverageLevel: 'included_50',
  };
  const session = {
    id: 'cs_test_aog',
    payment_status: 'paid',
    amount_total: 27750,
    payment_intent: 'pi_test_aog',
    metadata: { coverageProduct: 'aog-recovery', coverageId: 'cov_test' },
  };
  assert.equal(paymentDecision({ record, session }).action, 'capture');
  assert.equal(paymentDecision({
    record,
    session: { ...session, amount_total: 1850000 },
  }).action, 'reject');
  assert.equal(paymentDecision({
    record: { ...record, paymentStatus: 'paid', stripeReference: 'pi_test_aog' },
    session,
  }).action, 'duplicate');
  assert.equal(paymentDecision({
    record,
    session: { ...session, payment_status: 'unpaid' },
  }).action, 'ignore');
});

test('election PDF stores the typed name and the placeholder Jake must replace', async () => {
  const pdf = await renderElectionPdf({
    record: {
      tripId: 'SKY-TEST-1001',
      tail: 'N100TS',
      aircraftType: 'Citation CJ3',
      route: 'KAPF → KTEB',
      datesLabel: '2026-10-12 – 2026-10-14',
      tripTotal: 18500,
      premium: 277.5,
    },
    signature: {
      fullName: 'Pat Example',
      agreed: true,
      signedAt: '2026-10-01T15:04:00.000Z',
      ip: '203.0.113.10',
      userAgent: 'SyntheticTest/1.0',
      termsVersion: 'placeholder-2026-09-26',
      premium: 277.5,
    },
  });
  const text = pdf.toString('latin1').replace(/<([0-9A-Fa-f]+)>/g, (_, hex) => {
    let decoded = '';
    for (let i = 0; i < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return decoded;
  });
  assert.match(text, /^%PDF-/);
  // Standard-font kerning splits words in the TJ stream (P / at Example, J / AKE:).
  assert.match(text, /at Example/);
  assert.match(text, /CEHOLDER/);
  assert.match(text, /AKE:/);
  assert.match(text, /203\.0\.113\.10/);
  assert.match(text, /placeholder-2026-09-26/);
});

test('CSV export uses coverage labels and synthetic rows only', () => {
  const csv = coverageCsv([{
    tripId: 'SKY-TEST-1001',
    brokerCompany: 'Example Charter Group',
    checkoutEmail: 'broker@example-charter.test',
    tail: 'N100TS',
    aircraftType: 'Citation CJ3',
    datesLabel: '2026-10-12 – 2026-10-14',
    route: 'KAPF → KTEB',
    tripTotal: 18500,
    coverageLevel: 'purchased_100',
    premium: 277.5,
    paymentStatus: 'paid',
    stripeReference: 'pi_test_aog',
    electionContractPath: 'aog-recovery/test/aog-election.pdf',
    charterContractPath: 'aog-recovery/test/charter-contract.pdf',
    offerSentAt: '2026-10-01T15:00:00.000Z',
    bindEmailSentAt: '2026-10-01T15:10:00.000Z',
  }]);
  assert.match(csv, /Trip ID,Broker\/company,Checkout email/);
  assert.match(csv, /100% purchased/);
  assert.match(csv, /\$277\.50/);
  assert.match(csv, /broker@example-charter\.test/);
  assert.doesNotMatch(csv, /flyskyway\.com/i);
});

test('recovery mail and stripe routes are wired, and test mode is centralized', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const mailer = await readFile(path.join(root, 'api/_aog-recovery.js'), 'utf8');
  const vercel = await readFile(path.join(root, 'vercel.json'), 'utf8');
  const app = await readFile(path.join(root, 'src/App.jsx'), 'utf8');
  const main = await readFile(path.join(root, 'src/main.jsx'), 'utf8');
  assert.match(mailer, /applyNotifyTestMode/);
  assert.doesNotMatch(mailer, /NOTIFY_TEST_MODE/);
  assert.match(vercel, /\/api\/aog-recovery-inbox-scan/);
  assert.match(vercel, /\*\/10 \* \* \* \*/);
  assert.match(app, /AogRecoveryTab/);
  assert.match(app, /AogRecoveryGiftButton/);
  assert.match(app, /TripCharterContract/);
  assert.match(mailer, /attachCheckoutContract/);
  const tab = await readFile(path.join(root, 'src/AogRecoveryTab.jsx'), 'utf8');
  assert.match(tab, /Unmatched contracts/);
  const scan = await readFile(path.join(root, 'api/aog-recovery-inbox-scan.js'), 'utf8');
  assert.match(scan, /receivedAt/);
  assert.match(main, /\/aog-coverage/);
  const stripeRoute = await readFile(path.join(root, 'api/aog-recovery-stripe-webhook.js'), 'utf8');
  assert.match(stripeRoute, /constructEvent/);
  assert.match(stripeRoute, /bodyParser: false/);
  const checkout = await readFile(path.join(root, 'api/_aog-stripe.js'), 'utf8');
  assert.doesNotMatch(checkout, /payment_method_types/);
});
