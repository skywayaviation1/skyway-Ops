import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { extractUncompressedPdfText, parseCheckoutEmail } from '../api/_aog-checkout-parser.js';
import { publicCoverageView } from '../api/_aog-recovery.js';
import { renderElectionPdf } from '../api/_aog-election-pdf.js';
import { applyNotifyTestMode, notifyTestModeEnabled, notifyTestRecipient } from '../api/_notify-test-mode.js';
import { assertStripeTestKey, buildCheckoutSessionParams, stripeClient } from '../api/_aog-stripe.js';
import {
  buildCoverageDraft,
  classifyCheckout,
  coverageCsv,
  domainRecordsFromList,
  findRate,
  isComplimentaryDomain,
  matchCoverageToTrips,
  paymentDecision,
  quotePremium,
  readDomainRecords,
} from '../src/aog-recovery.js';
import {
  TRIP_PAGE_SIZE,
  buildTripRows,
  filterTripRows,
  pageOfRows,
  rowsEligibleForComplimentary,
  tripRowCsv,
} from '../src/aog-trip-rows.js';
import { planBrokerBackfill } from '../src/broker-backfill.js';
import { cfsIncidentView, coverageIsBound, incidentCfsLetter, validateAogReport } from '../src/aog-incident.js';
import {
  ackTokenUsable,
  bindLetterContent,
  cfsBrokerLetter,
  cfsOpsLetter,
  planCfsAcknowledgement,
  publicCfsView,
} from '../src/aog-cfs.js';
import { normalizeTripId } from '../src/trip-id.js';
import {
  contractStoragePath,
  contractVersionPath,
  isUnmatchedContract,
  matchContractToTrips,
  planContractWrite,
  shouldAttachCharterContract,
} from '../src/charter-contract.js';
import { offerLetter } from '../api/_aog-recovery.js';
import {
  coverageEvent,
  coverageLimitCentsFor,
  dollarsFromCents,
  electionSourceFor,
  eventDocId,
  reportingFacts,
} from '../src/aog-reporting.js';

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
  assert.equal(parsed.parserVersion, 'provisional-3');
  assert.equal(parsed.tripId, 'WEQVQD');
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
  assert.match(parsed.notes.join(' '), /provisional-3/);
});

test('provisional parser reads a synthetic Lear checkout', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('lear-checkout.txt'));
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.tripId, 'TJ7R2B');
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

  const paid = classifyCheckout({ ...parsed, tripId: 'WEQVQD', checkoutEmail: 'buyer@other-example.test' }, settings);
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
    { id: 'leg-a', tripCode: 'WEQVQD', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-10-12T14:00:00.000Z' },
    { id: 'leg-b', tripCode: 'WEQVQD', tail: 'N100TS', from: 'KTEB', to: 'KAPF', start: '2026-10-14T18:00:00.000Z' },
    { id: 'other', tripCode: 'ZZZZZ9', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-01-01T14:00:00.000Z' },
  ];
  const linked = matchCoverageToTrips({
    tripId: 'WEQVQD', tail: 'N100TS', routeFrom: 'KAPF', routeTo: 'KTEB', departDate: '2026-10-12',
  }, trips);
  assert.equal(linked.status, 'linked');
  assert.deepEqual(linked.matches.map((trip) => trip.id).sort(), ['leg-a', 'leg-b']);

  const tailOnly = matchCoverageToTrips({ tail: 'N100TS' }, trips);
  assert.equal(tailOnly.status, 'unmatched');

  const draft = buildCoverageDraft({
    parsed: {
      tripId: 'ZZZZZ9',
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
    { id: 'leg-a', tripCode: 'WEQVQD', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-10-12T14:00:00.000Z' },
    { id: 'leg-b', tripCode: 'WEQVQD', tail: 'N100TS', from: 'KTEB', to: 'KAPF', start: '2026-10-14T18:00:00.000Z' },
    { id: 'other', tripCode: 'ZZZZZ9', tail: 'N100TS', from: 'KAPF', to: 'KTEB', start: '2026-10-12T14:00:00.000Z' },
  ];
  const byId = matchContractToTrips({
    tripId: 'WEQVQD', tail: 'N999XX', routeFrom: 'KORD', routeTo: 'KJFK', departDate: '2026-01-01',
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

  const unique = trips.filter((trip) => trip.tripCode !== 'ZZZZZ9');
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
      path: contractStoragePath('WEQVQD'),
      sizeBytes: 1200,
      source,
      attachedAt: '2026-10-01T15:04:00.000Z',
    },
  });
  assert.equal(first.action, 'attached');
  assert.equal(first.contract.path, 'trip-contracts/WEQVQD/charter-contract.pdf');
  assert.equal(first.contract.source.messageId, source.messageId);
  assert.equal(first.contract.source.sender, source.sender);
  assert.equal(first.contract.source.receivedAt, source.receivedAt);
  assert.deepEqual(first.contract.versions, []);

  const again = planContractWrite({
    existing: first.contract,
    incoming: {
      fingerprint: 'abc123',
      filename: 'synthetic-charter.pdf',
      path: contractStoragePath('WEQVQD'),
      source: { ...source, messageId: 'graph-message-synthetic-2' },
      attachedAt: '2026-10-02T15:04:00.000Z',
    },
  });
  assert.equal(again.action, 'unchanged');
  assert.equal(again.contract.source.messageId, 'graph-message-synthetic-1');

  const versionPath = contractVersionPath('WEQVQD', 'abc123');
  const replaced = planContractWrite({
    existing: first.contract,
    versionPath,
    incoming: {
      fingerprint: 'def456',
      filename: 'synthetic-charter-revised.pdf',
      path: contractStoragePath('WEQVQD'),
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

test('reporting fields are typed cents, ICAO, and an append-only event id', () => {
  const facts = reportingFacts({
    brokerCompany: '  Example   Charter Group ',
    checkoutEmail: 'Broker@Example-Charter.test',
    aircraftType: 'Citation CJ3',
    tail: 'n100ts',
    tripId: 'weqvqd',
    routeFrom: 'APF',
    routeTo: 'TEB',
    itinerary: 'KAPF → KTEB → KAPF',
    departDate: '2026-10-12',
    returnDate: '2026-10-14',
    tripTotal: 18500,
    premiumCents: 27750,
    ratePercent: 1.5,
    coverageLevel: 'included_50',
    paymentStatus: 'offer_pending',
  });
  assert.equal(facts.currency, 'usd');
  assert.equal(facts.tripTotalCents, 1850000);
  assert.equal(facts.premiumCents, 27750);
  assert.equal(dollarsFromCents(facts.premiumCents), 277.5);
  assert.equal(facts.brokerCompany, 'Example Charter Group');
  assert.equal(facts.brokerEmail, 'broker@example-charter.test');
  assert.equal(facts.brokerDomain, 'example-charter.test');
  assert.equal(facts.tail, 'N100TS');
  assert.equal(facts.tripId, 'WEQVQD');
  assert.equal(facts.origin, 'KAPF');
  assert.equal(facts.destination, 'KTEB');
  assert.equal(facts.legCount, 2);
  assert.equal(facts.departAtUtc, '2026-10-12T00:00:00.000Z');
  assert.equal(facts.returnAtUtc, '2026-10-14T00:00:00.000Z');
  assert.equal(facts.electionSource, null);
  assert.equal(facts.ratePercent, 1.5);
  assert.equal(facts.coverageLimitCents, 1850000);
  assert.equal(facts.coverageMultiplier, 1);
  assert.equal(facts.includedMultiplier, 1);
  assert.equal(facts.upgradeMultiplier, 2);
  const hundred = reportingFacts({ tripTotal: 20000, coverageLevel: 'gifted_100', premiumCents: 30000 });
  assert.equal(hundred.coverageLimitCents, 4000000);
  assert.equal(hundred.coverageMultiplier, 2);
  const corrected = reportingFacts({ tripTotalCents: 2500000, coverageLevel: 'purchased_100' });
  assert.equal(corrected.coverageLimitCents, 5000000);
  assert.equal(corrected.coverageMultiplier, 2);
  assert.equal(coverageLimitCentsFor(2000000, 'included_50'), 2000000);
  assert.equal(coverageLimitCentsFor(2000000, 'included_50', { includedMultiplier: 1.5 }), 3000000);
  assert.equal(coverageLimitCentsFor(2000000, 'gifted_100', { upgradeMultiplier: 3 }), 6000000);
  assert.equal(electionSourceFor('purchased_100'), 'purchased');
  assert.equal(electionSourceFor('gifted_100'), 'gifted');
  assert.equal(electionSourceFor('complimentary_100'), 'complimentary_domain');

  const offered = coverageEvent({
    type: 'offer_sent',
    atUtc: '2026-10-01T15:00:00.000Z',
    ...facts,
    actor: 'broker@example-charter.test',
  });
  assert.equal(offered.id, 'offer_sent');
  assert.equal(offered.amountCents, 27750);
  assert.equal(eventDocId('paid', { stripePaymentIntentId: 'pi_test_aog' }), 'paid_pi_test_aog');
  assert.equal(eventDocId('refunded', { stripeRefundId: 're_test_aog' }), 'refunded_re_test_aog');
  assert.equal(eventDocId('contract_signed', {}), 'contract_signed');
  assert.throws(() => eventDocId('voided', {}), /Unknown coverage event/);
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
    text: 'Trip WEQVQD',
    html: '<p>Trip WEQVQD</p>',
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
      tripId: 'WEQVQD',
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
      tripId: 'WEQVQD',
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
    tripId: 'WEQVQD',
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
  assert.match(tab, /Today and upcoming/);
  assert.match(tab, /Add domain/);
  assert.match(tab, /Save contract/);
  assert.match(tab, /preview-contract/);
  assert.doesNotMatch(tab, /\b(setDoc|updateDoc|addDoc)\b/);
  assert.match(app, /scheduleTrips=\{allTrips\}/);
  const ops = await readFile(path.join(root, 'api/aog-recovery-ops.js'), 'utf8');
  assert.match(ops, /preview-contract/);
  assert.match(ops, /save-contract/);
  assert.match(ops, /authorizeOps/);
  const scan = await readFile(path.join(root, 'api/aog-recovery-inbox-scan.js'), 'utf8');
  assert.match(scan, /receivedAt/);
  const indexes = await readFile(path.join(root, 'firestore.indexes.json'), 'utf8');
  assert.match(indexes, /brokerDomain/);
  assert.match(indexes, /aircraftType/);
  assert.match(indexes, /coverageEvents/);
  assert.match(indexes, /charterContractData.departAt/);
  assert.match(mailer, /appendCoverageEvent/);
  assert.match(mailer, /charterContractData/);
  assert.match(main, /\/aog-coverage/);
  const stripeRoute = await readFile(path.join(root, 'api/aog-recovery-stripe-webhook.js'), 'utf8');
  assert.match(stripeRoute, /constructEvent/);
  assert.match(stripeRoute, /bodyParser: false/);
  const checkout = await readFile(path.join(root, 'api/_aog-stripe.js'), 'utf8');
  assert.doesNotMatch(checkout, /payment_method_types/);
});

test('trip rows group legs and default to today forward by last leg', () => {
  const now = new Date('2026-09-27T15:00:00.000Z');
  const legs = [
    { uid: 'a1', tripId: 'WEQVQD', start: '2026-10-12T14:00:00.000Z', end: '2026-10-12T16:00:00.000Z', tail: 'N100TS', from: 'KAPF', to: 'KTEB', aircraft: 'Citation CJ3', customer: 'Example Charter Group', brokerEmail: 'broker@example-charter.test', contractAttached: false },
    { uid: 'a2', tripId: 'WEQVQD', start: '2026-10-14T14:00:00.000Z', end: '2026-10-14T17:00:00.000Z', tail: 'N100TS', from: 'KTEB', to: 'KAPF', aircraft: 'Citation CJ3', customer: 'Example Charter Group', brokerEmail: 'broker@example-charter.test', contractAttached: false },
    { uid: 'past', tripId: 'G7OLD2', start: '2026-08-01T14:00:00.000Z', end: '2026-08-01T16:00:00.000Z', tail: 'N200TS', from: 'KTEB', to: 'KMIA', aircraft: 'Learjet 60', customer: 'Northwind Example Jets', brokerEmail: 'dispatch@example-lear.test', contractAttached: false },
    { uid: 'mid', tripId: 'R3TURN', start: '2026-09-20T14:00:00.000Z', end: '2026-09-28T16:00:00.000Z', tail: 'N100TS', from: 'KTEB', to: 'KAPF', aircraft: 'Citation CJ3', customer: 'Example Charter Group', brokerEmail: 'broker@example-charter.test', contractAttached: false },
    { uid: 'yest', tripId: 'Y2DONE', start: '2026-09-20T14:00:00.000Z', end: '2026-09-26T16:00:00.000Z', tail: 'N200TS', from: 'KTEB', to: 'KMIA', aircraft: 'Learjet 60', customer: 'Northwind Example Jets', brokerEmail: 'dispatch@example-lear.test', contractAttached: false },
  ];
  const rows = buildTripRows(legs, []);
  const grouped = rows.find((row) => row.tripId === 'WEQVQD');
  assert.equal(grouped.legCount, 2);
  assert.equal(grouped.route, 'KAPF → KTEB → KAPF');
  assert.equal(grouped.coverageLevel, 'included_50');
  assert.equal(grouped.contractStatus, 'missing');
  assert.equal(grouped.paymentStatus, 'not_required');
  const current = filterTripRows(rows, { now, window: 'current' });
  assert.deepEqual(current.map((row) => row.tripId), ['R3TURN', 'WEQVQD']);
  const past = filterTripRows(rows, { now, window: 'past' });
  assert.deepEqual(past.map((row) => row.tripId), ['Y2DONE', 'G7OLD2']);
  const missing = filterTripRows(rows, { now, window: 'all', contract: 'missing' });
  assert.equal(missing.length, 4);
  const many = buildTripRows(Array.from({ length: TRIP_PAGE_SIZE + 5 }, (_, i) => ({
    uid: `f${i}`, tripId: `SKY-FILL-${i}`, start: '2026-10-15T12:00:00.000Z', tail: 'N100TS', from: 'KAPF', to: 'KTEB',
  })), []);
  const paged = pageOfRows(filterTripRows(many, { now, window: 'all' }), 1);
  assert.equal(paged.page, 1);
  assert.equal(paged.rows.length, 5);
  const csv = tripRowCsv(current);
  assert.match(csv, /Trip ID,Dates,Route/);
  assert.match(csv, /missing/);
  assert.match(csv, /50% included/);
});

test('complimentary domain records keep who added them', () => {
  assert.throws(() => domainRecordsFromList(['not a domain']), /Invalid complimentary domain/);
  const first = domainRecordsFromList(['example-charter.test'], {
    actorEmail: 'ops@example-charter.test',
    now: '2026-09-27T15:00:00.000Z',
  });
  assert.equal(first[0].addedBy, 'ops@example-charter.test');
  const second = domainRecordsFromList(['example-charter.test', 'example-lear.test'], {
    previous: first,
    actorEmail: 'other@example-charter.test',
    now: '2026-10-01T15:00:00.000Z',
  });
  assert.equal(second[0].addedBy, 'ops@example-charter.test');
  assert.equal(second[0].addedAt, '2026-09-27T15:00:00.000Z');
  assert.equal(second[1].addedBy, 'other@example-charter.test');
  const loaded = readDomainRecords({ complimentaryDomainRecords: second });
  assert.equal(loaded.length, 2);
  const rows = buildTripRows([
    { uid: 'up', tripId: 'WEQVQD', start: '2026-10-12T14:00:00.000Z', brokerEmail: 'broker@example-charter.test', customer: 'Example Charter Group' },
    { uid: 'done', tripId: 'X9K2M4', start: '2026-10-12T14:00:00.000Z', brokerEmail: 'broker@example-charter.test', customer: 'Example Charter Group' },
  ], [{ id: 'c2', tripId: 'X9K2M4', coverageLevel: 'purchased_100', brokerEmail: 'broker@example-charter.test' }]);
  const eligible = rowsEligibleForComplimentary(rows, 'example-charter.test', new Date('2026-09-27T15:00:00.000Z'));
  assert.deepEqual(eligible.map((row) => row.tripId), ['WEQVQD']);
});

test('uncompressed charter PDF text uses the checkout parser', () => {
  const lines = [
    'Charter contract',
    'Trip ID: WEQVQD',
    'Company: Example Charter Group',
    'Checkout email: broker@example-charter.test',
    'Aircraft type: Citation CJ3',
    'Registration: N100TS',
    'Itinerary: KAPF → KTEB',
    'Depart: 2026-10-12',
    'Return: 2026-10-14',
    'Charter total: $18,500.00',
  ];
  const body = `%PDF-1.4\n${lines.map((line) => `(${line}) Tj`).join('\n')}\n%%EOF`;
  const text = extractUncompressedPdfText(Buffer.from(body));
  const parsed = parseCheckoutEmail({
    subject: 'Charter contract',
    from: '',
    bodyText: text,
    attachmentText: text,
    attachmentNames: ['synthetic-charter.pdf'],
    hasPdf: true,
  });
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.tripId, 'WEQVQD');
  assert.equal(parsed.tripTotal, 18500);
  assert.equal(parsed.checkoutEmail, 'broker@example-charter.test');
  assert.equal(parsed.tail, 'N100TS');
});

test('trip ids are the 6 or 7 character trip code, not a trip number', () => {
  assert.equal(normalizeTripId('weqvqd'), 'WEQVQD');
  assert.equal(normalizeTripId('X9K2M4'), 'X9K2M4');
  assert.equal(normalizeTripId('TJ7R2B1'), 'TJ7R2B1');
  assert.equal(normalizeTripId('SKY-TEST-3003'), '');
  assert.equal(normalizeTripId('1234567'), '');
  assert.equal(normalizeTripId('leg-3001-a'), '');

  const parsed = parseCheckoutEmail({
    subject: 'Crew Itinerary (WEQVQD)',
    from: 'broker@example-charter.test',
    bodyText: [
      'Trip number: 482193845',
      'Trip number: SKY-TEST-3003',
      'Crew Itinerary (WEQVQD)',
      'Broker: Example Charter Group',
      'Checkout email: broker@example-charter.test',
      'Broker phone: (305) 555-0148',
      'Aircraft: Citation CJ3',
      'Tail: N100TS',
      'Route: KAPF - KTEB',
      'Departure: 2026-10-12',
      'Trip total: $18,500.00',
    ].join('\n'),
    attachmentNames: ['charter.pdf'],
    hasPdf: true,
  });
  assert.equal(parsed.tripId, 'WEQVQD');
  assert.equal(parsed.brokerPhone.includes('305'), true);
  assert.equal(parsed.notes.some((note) => /SKY-TEST|482193845/.test(note)), false);
});

test('broker backfill fills empty trip fields and keeps a different existing broker', () => {
  const empty = planBrokerBackfill({}, {
    brokerCompany: 'Example Charter Group',
    checkoutEmail: 'broker@example-charter.test',
    brokerPhone: '(305) 555-0148',
  });
  assert.deepEqual(empty.filled.sort(), ['brokerCompany', 'brokerDomain', 'brokerEmail', 'brokerPhone']);
  assert.equal(empty.patch.brokerEmail, 'broker@example-charter.test');
  assert.equal(empty.patch.brokerDomain, 'example-charter.test');
  assert.equal(empty.mismatches.length, 0);

  const same = planBrokerBackfill({
    brokerCompany: 'Example Charter Group',
    brokerEmail: 'broker@example-charter.test',
  }, {
    brokerCompany: 'example charter group',
    checkoutEmail: 'broker@example-charter.test',
  });
  assert.equal(same.filled.length, 0);
  assert.equal(same.mismatches.length, 0);

  const clash = planBrokerBackfill({
    brokerCompany: 'Kept Broker Co',
    brokerEmail: 'kept@example-broker.test',
  }, {
    brokerCompany: 'Other Jets',
    checkoutEmail: 'other@example-other.test',
    brokerPhone: '305-555-0199',
  });
  assert.equal(clash.patch.brokerEmail, undefined);
  assert.equal(clash.patch.brokerCompany, undefined);
  assert.equal(clash.patch.brokerPhone, '305-555-0199');
  assert.ok(clash.mismatches.some((row) => row.field === 'brokerEmail' && row.existing === 'kept@example-broker.test'));
  assert.ok(clash.mismatches.some((row) => row.field === 'brokerCompany'));
});

const cfsRecord = {
  tripId: 'WEQVQD',
  aircraftType: 'Citation CJ3',
  tail: 'N100TS',
  route: 'KTEB → KPBI',
  datesLabel: '2026-11-02 – 2026-11-04',
  legCount: 2,
  brokerCompany: 'Example Charter Group',
  coverageLevel: 'gifted_100',
  tripTotal: 20000,
  tripTotalCents: 2000000,
  premium: 360,
  premiumCents: 36000,
  ratePercent: 1.5,
  checkoutEmail: 'broker@example-charter.test',
};

test('CFS bind email omits the premium and rate and links to acknowledge coverage', () => {
  const letter = bindLetterContent(cfsRecord, {
    ackUrl: 'https://example.test/aog-cfs?token=synthetic-token',
    attachmentNotes: 'Charter contract is attached.',
  });
  const body = `${letter.html}\n${letter.text}`;
  assert.equal(/premium/i.test(body), false);
  assert.equal(body.includes('1.5'), false);
  assert.equal(body.includes('$360'), false);
  assert.match(letter.html, /Acknowledge coverage/);
  assert.match(body, /WEQVQD/);
  assert.match(body, /Example Charter Group/);
  assert.match(body, /\$20,000\.00/);
  assert.match(body, /Coverage value: up to \$40,000\.00/);
  assert.match(body, /Coverage: 100%/);
  assert.match(body, /Open the CFS portal/);
  assert.equal(/50%|gifted|complimentary/i.test(body), false);
  assert.match(body, /N100TS/);
  assert.match(body, /KTEB/);
  assert.match(body, /2026-11-02/);
  assert.match(body, /Legs/);
  assert.match(body, /https:\/\/example\.test\/aog-cfs\?token=synthetic-token/);
  assert.match(body, /Charter contract is attached/);
});

test('CFS acknowledgement tokens expire and a submit is an update, a retry, or a no-op', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  assert.equal(ackTokenUsable({}, now).status, 404);
  assert.equal(ackTokenUsable({
    ackTokenHash: 'abc',
    ackTokenExpiresAt: '2020-01-01T00:00:00.000Z',
  }, now).status, 410);
  assert.equal(ackTokenUsable({
    ackTokenHash: 'abc',
    ackTokenExpiresAt: '2027-01-01T00:00:00.000Z',
  }, now).ok, true);

  const input = {
    name: 'Casey Stone',
    email: 'Casey@CharterFlightSupport.com',
    cfsCost: '640.00',
    acceptedCoveragePercent: '80',
    coverageLimit: '1000',
    reference: 'CFS-4491',
    notes: 'Bind note',
  };
  const first = planCfsAcknowledgement(cfsRecord, input, new Date(now));
  assert.equal(first.ok, true);
  assert.equal(first.kind, 'update');
  assert.equal(first.revision, 1);
  assert.equal(first.patch.cfsStatus, 'cfs_confirmed');
  assert.equal(first.patch.cfsCostCents, 64000);
  assert.equal(first.patch.cfsMarginCents, 36000 - 64000);
  assert.equal(first.patch.acceptedCoveragePercent, 100);
  assert.equal(first.patch.coverageLimitCents, 4000000);
  assert.equal(first.patch.coverageMultiplier, 2);
  assert.equal(first.patch.cfsShortfall, false);
  assert.equal(first.patch.cfsConfirmedByEmail, 'casey@charterflightsupport.com');
  const correctedAck = planCfsAcknowledgement({ ...cfsRecord, tripTotal: 25000, tripTotalCents: 2500000 }, input, new Date(now));
  assert.equal(correctedAck.patch.coverageLimitCents, 5000000);

  const stored = {
    ...cfsRecord,
    ...first.patch,
    cfsOpsNotifiedRevision: 1,
    cfsBrokerNotifiedRevision: 1,
  };
  const same = planCfsAcknowledgement(stored, input, new Date(now + 1000));
  assert.equal(same.kind, 'unchanged');
  assert.equal(same.revision, 1);

  const retry = planCfsAcknowledgement({ ...stored, cfsOpsNotifiedRevision: 0 }, input, new Date(now + 2000));
  assert.equal(retry.kind, 'resend');
  assert.equal(retry.revision, 1);
  assert.equal(retry.patch, undefined);

  const changed = planCfsAcknowledgement(stored, { ...input, cfsCost: '700.00' }, new Date(now + 3000));
  assert.equal(changed.kind, 'update');
  assert.equal(changed.revision, 2);
  assert.equal(changed.patch.cfsCostCents, 70000);

  assert.equal(planCfsAcknowledgement(cfsRecord, { ...input, name: 'A' }).ok, false);
  assert.equal(planCfsAcknowledgement(cfsRecord, { ...input, email: 'not-an-email' }).ok, false);
  assert.equal(planCfsAcknowledgement(cfsRecord, { ...input, cfsCost: '' }).ok, false);
  assert.equal(planCfsAcknowledgement(cfsRecord, { ...input, acceptedCoveragePercent: '150' }).patch.acceptedCoveragePercent, 100);
});

test('broker CFS mail omits cost and premium, and both notices show the 2x coverage value', () => {
  const fields = {
    name: 'Casey Stone',
    email: 'casey@charterflightsupport.com',
    cfsCostCents: 64000,
    reference: 'CFS-4491',
    notes: '',
  };
  const broker = cfsBrokerLetter(cfsRecord, fields);
  const brokerBody = `${broker.html}\n${broker.text}`;
  assert.match(brokerBody, /Included: 50%, up to \$20,000\.00/);
  assert.match(brokerBody, /Upgrade: 100%, up to \$40,000\.00, premium \$360\.00/);
  assert.equal(brokerBody.includes('$640'), false);
  assert.equal(brokerBody.includes('640.00'), false);
  assert.equal(/CFS cost/i.test(brokerBody), false);
  assert.equal(/below what was requested/i.test(brokerBody), false);
  assert.match(brokerBody, /WEQVQD/);
  assert.match(brokerBody, /KTEB/);
  assert.match(brokerBody, /2026-11-02/);
  assert.match(brokerBody, /Coverage: 100%/);
  assert.match(brokerBody, /Coverage value: up to \$40,000\.00/);
  const ops = cfsOpsLetter(cfsRecord, fields);
  const opsBody = `${ops.html}\n${ops.text}`;
  assert.match(opsBody, /\$640\.00/);
  assert.match(opsBody, /CFS cost/);
  assert.match(opsBody, /Coverage value: up to \$40,000\.00/);
  assert.equal(/below what was requested/i.test(opsBody), false);
  assert.equal(/premium/i.test(opsBody), false);
  const offer = offerLetter({ ...cfsRecord, coverageLevel: 'included_50', premium: 300, ratePercent: 1.5 }, 'https://example.test/aog-coverage');
  const offerBody = `${offer.html}\n${offer.text}`;
  assert.match(offerBody, /Included: 50%, up to \$20,000\.00/);
  assert.match(offerBody, /Upgrade: 100%, up to \$40,000\.00, premium \$300\.00/);
  assert.match(offerBody, /Coverage value: up to \$40,000\.00/);

  const view = JSON.stringify(publicCfsView({ ...cfsRecord, cfsStatus: '' }));
  assert.equal(/premium/i.test(view), false);
  assert.equal(view.includes('360'), false);
  assert.equal(view.includes('1.5'), false);
  const acknowledged = publicCfsView({
    ...cfsRecord,
    cfsStatus: 'cfs_confirmed',
    cfsConfirmedByName: 'Casey Stone',
    cfsConfirmedByEmail: 'casey@charterflightsupport.com',
    cfsCostCents: 64000,
    acceptedCoveragePercent: 80,
    cfsShortfall: true,
  });
  assert.equal(acknowledged.acknowledgement.acceptedCoveragePercent, 100);
  assert.equal(acknowledged.coverageValueLabel, 'up to $40,000.00');
  assert.equal(acknowledged.coverage, '100%');
  assert.equal(JSON.stringify(acknowledged).includes('gifted'), false);
  assert.equal(JSON.stringify(acknowledged).includes('complimentary'), false);
  assert.equal(acknowledged.acknowledgement.cfsCost, '640.00');
  assert.equal(Object.hasOwn(acknowledged, 'premium'), false);
});

test('trip rows filter bind-sent coverage that CFS has not confirmed, and CSV carries cost and margin cents', () => {
  const legs = [{
    uid: 'c1',
    tripId: 'M8CFS2',
    start: '2026-11-02T14:00:00.000Z',
    tail: 'N318CS',
    from: 'KTEB',
    to: 'KPBI',
    aircraft: 'Citation CJ3',
    customer: 'Example Charter Group',
    brokerEmail: 'broker@example-charter.test',
  }, {
    uid: 'w1',
    tripId: 'WEQVQD',
    start: '2026-11-03T14:00:00.000Z',
    tail: 'N100TS',
    from: 'KAPF',
    to: 'KTEB',
    aircraft: 'Citation CJ3',
  }];
  const rows = buildTripRows(legs, [{
    id: 'cov-m8cfs2',
    tripId: 'M8CFS2',
    coverageLevel: 'gifted_100',
    paymentStatus: 'gifted',
    tripTotal: 20000,
    tripTotalCents: 2000000,
    premiumCents: 36000,
    premium: 360,
    cfsStatus: 'cfs_confirmed',
    cfsCostCents: 64000,
    cfsMarginCents: -28000,
    acceptedCoveragePercent: 100,
    bindEmailSentAt: '2026-11-01T15:00:00.000Z',
    cfsConfirmedAt: '2026-11-01T16:00:00.000Z',
    cfsShortfall: true,
  }, {
    id: 'cov-weqvqd',
    tripId: 'WEQVQD',
    coverageLevel: 'gifted_100',
    paymentStatus: 'gifted',
    bindEmailSentAt: '2026-11-01T15:00:00.000Z',
    cfsStatus: '',
  }]);
  const awaiting = filterTripRows(rows, { window: 'all', cfs: 'awaiting' });
  assert.deepEqual(awaiting.map((row) => row.tripId), ['WEQVQD']);
  const confirmed = filterTripRows(rows, { window: 'all', cfs: 'confirmed' });
  assert.deepEqual(confirmed.map((row) => row.tripId), ['M8CFS2']);
  const csv = tripRowCsv(confirmed);
  assert.match(csv, /Coverage limit cents,CFS cost cents,Margin cents/);
  assert.match(csv, /4000000,64000,-28000/);
  assert.equal(rows.find((row) => row.tripId === 'WEQVQD').coverageLimitCents, null);
});

test('CFS acknowledgement is an Admin SDK write and mail is claimed once per change', async () => {
  const api = await readFile(new URL('../api/aog-recovery-cfs.js', import.meta.url), 'utf8');
  assert.match(api, /acknowledgeCfs/);
  assert.doesNotMatch(api, /setDoc|updateDoc|addDoc/);
  assert.doesNotMatch(api, /acceptedCoveragePercent|coverageLimit/);
  const form = await readFile(new URL('../src/AogCfsAcknowledge.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(form, /Accepted coverage percent|Coverage limit/);
  assert.match(form, /Coverage value/);
  const server = await readFile(new URL('../api/_aog-recovery.js', import.meta.url), 'utf8');
  const ackStart = server.indexOf('export async function acknowledgeCfs');
  const ack = server.slice(ackStart, ackStart + 1800);
  assert.match(ack, /runTransaction/);
  assert.match(ack, /tx\.create/);
  assert.match(ack, /cfs_acknowledged/);
  const sendStart = server.indexOf('async function sendAckNotices');
  const send = server.slice(sendStart, ackStart);
  assert.ok(send.indexOf('claimNotice') < send.indexOf('sendRecoveryEmail'));
  const event = coverageEvent({
    type: 'cfs_acknowledged',
    atUtc: '2026-09-27T12:00:00.001Z',
    amountCents: 64000,
    actor: 'casey@charterflightsupport.com',
    tripId: 'WEQVQD',
  });
  assert.match(event.id, /^cfs_acknowledged_/);
  assert.equal(event.amountCents, 64000);
});

test('checkout parser rejects label words, clips aircraft, and orders dates', () => {
  const parsed = parseCheckoutEmail({
    subject: 'Charter checkout',
    from: 'andrius.butkus@surfair.com',
    bodyText: [
      'Trip locator: LOCATOR',
      'Trip code: K7M4QX',
      'Aircraft: Cessna Citation CJ3 (N525CR) Passengers : 2 Charter p',
      'Tail: N525CR',
      'Route: KDSM - KIAD',
      'Departure: 2026-09-28',
      'Return: 2026-09-27',
      'Trip total: $0.00',
      'Checkout email: trips@surfair.com',
      'Broker: Surf Air',
    ].join('\n'),
    attachmentNames: ['signed-charter-contract.pdf'],
    hasPdf: true,
  }, { knownAircraft: ['Citation CJ3', 'Learjet 60'] });
  assert.equal(parsed.tripId, 'K7M4QX');
  assert.equal(parsed.aircraftType, 'Cessna Citation CJ3');
  assert.equal(parsed.tail, 'N525CR');
  assert.equal(parsed.passengerCount, 2);
  assert.equal(parsed.departDate, '2026-09-27');
  assert.equal(parsed.returnDate, '2026-09-28');
  assert.equal(parsed.datesLabel, '2026-09-27 – 2026-09-28');
  assert.equal(parsed.tripTotal, null);
  assert.match(parsed.notes.join(' '), /LOCATOR/);

  const held = classifyCheckout(parsed, {});
  assert.deepEqual(held.emails, []);
  assert.equal(findRate('Cessna Citation CJ3 (N525CR) Passengers : 2')?.aircraftType, 'Citation CJ3');
  assert.equal(findRate('Citation CJ1'), null);
});

test('a real trip code is required before a broker offer is queued', () => {
  const offer = classifyCheckout({
    tripId: 'LOCATOR',
    aircraftType: 'Citation CJ3',
    tripTotal: 18500,
    checkoutEmail: 'trips@surfair.com',
  }, {});
  assert.deepEqual(offer.emails, []);
  const ready = classifyCheckout({
    tripId: 'K7M4QX',
    aircraftType: 'Cessna Citation CJ3',
    tripTotal: 18500,
    checkoutEmail: 'trips@surfair.com',
  }, {});
  assert.deepEqual(ready.emails, ['broker_offer']);
  assert.equal(ready.ratePercent, 1.5);
});

test('a redacted Skyway contract parses the trip locator, charter price, and local leg', async () => {
  const parsed = parseCheckoutEmail(await loadFixture('skyway-signed-contract.txt'), {
    knownAircraft: ['Citation CJ3', 'Learjet 60'],
  });
  assert.equal(parsed.isCheckout, true);
  assert.equal(parsed.tripId, 'TBAE0L');
  assert.equal(parsed.tail, 'N525CR');
  assert.equal(parsed.confidence.tail, 'high');
  assert.match(parsed.aircraftType, /CJ3/);
  assert.equal(parsed.passengerCount, 2);
  assert.equal(parsed.tripTotal, 15000);
  assert.equal(parsed.confidence.tripTotal, 'high');
  assert.equal(parsed.departDate, '2026-09-28');
  assert.equal(parsed.returnDate, null);
  assert.equal(parsed.routeFrom, 'DSM');
  assert.equal(parsed.routeTo, 'IAD');
  assert.deepEqual(parsed.legs, [{
    from: 'DSM',
    to: 'IAD',
    departAt: '2026-09-28 13:00 CDT',
    arriveAt: '2026-09-28 16:18 EDT',
  }]);
  assert.equal(parsed.checkoutEmail, 'jordan.hale@example-charter.test');
  assert.equal(parsed.brokerCompany, 'Jordan Hale');
  assert.equal(parsed.signedAt, '2026-09-25T13:27:52Z');
  assert.equal(parsed.contractSigned, true);
  assert.equal(parsed.notes.some((note) => /2600:|e-signature value|aarBls/.test(note)), false);
  assert.deepEqual(parsed.uncertainFields, []);

  const quote = quotePremium({ aircraftType: parsed.aircraftType, tripTotal: parsed.tripTotal });
  assert.equal(quote.premium, 225);
  assert.equal(quote.ratePercent, 1.5);
  const action = classifyCheckout(parsed, {});
  assert.deepEqual(action.emails, ['broker_offer']);
  assert.equal(action.premium, 225);
  const draft = buildCoverageDraft({
    parsed,
    settings: {},
    match: { status: 'unmatched', matches: [], ambiguous: false },
    messageId: 'fixture',
  });
  const view = publicCoverageView(draft);
  assert.equal(view.includedLine, 'Included: 50%, up to $15,000.00');
  assert.equal(view.upgradeLine, 'Upgrade: 100%, up to $30,000.00, premium $225.00');
  assert.equal(draft.contractSignedAt, '2026-09-25T13:27:52Z');
  assert.equal(draft.legs[0].departAt, '2026-09-28 13:00 CDT');
});

test('an AOG report notifies CFS for every trip and hides coverage unless 100% is bound', () => {
  const missing = validateAogReport({ tripId: 'LOCATOR', wholeTrip: true, legs: [{ id: 'a', from: 'KDSM', to: 'KIAD' }] });
  assert.equal(missing.ok, false);
  const report = validateAogReport({
    tripId: 'k7m4qx',
    wholeTrip: false,
    legIds: ['leg-b'],
    legs: [
      { id: 'leg-a', from: 'KDSM', to: 'KIAD', departAt: '2026-09-28T14:00:00Z', tail: 'N525CR' },
      { id: 'leg-b', from: 'KIAD', to: 'KTEB', departAt: '2026-09-29T14:00:00Z', tail: 'N525CR' },
    ],
    location: 'KIAD',
    aogAt: '2026-09-29T16:00',
    issue: 'Hydraulic leak on arrival',
    notes: 'Crew is with the aircraft',
    contact: 'Dispatch desk',
    idempotencyKey: 'same-key',
  });
  assert.equal(report.ok, true);
  assert.equal(report.value.legs.length, 1);
  assert.equal(report.value.legs[0].id, 'leg-b');
  assert.equal(coverageIsBound([{ coverageLevel: 'included_50' }]), false);
  assert.equal(coverageIsBound([{ coverageLevel: 'purchased_100' }]), true);
  const hidden = {
    premium: 277.5,
    checkoutEmail: 'trips@surfair.com',
    passengerName: 'Hidden Guest',
  };
  const unbound = cfsIncidentView({ id: 'abc', ...report.value, ...hidden });
  assert.equal(unbound.coverage, undefined);
  assert.equal(unbound.premium, undefined);
  assert.equal(unbound.checkoutEmail, undefined);
  assert.equal(unbound.passengerName, undefined);
  const unboundLetter = incidentCfsLetter(unbound, 'https://example.test/cfs?aog=token');
  const unboundBody = `${unboundLetter.html}\n${unboundLetter.text}`;
  assert.match(unboundBody, /K7M4QX/);
  assert.match(unboundBody, /Hydraulic leak/);
  assert.equal(/\b50%/.test(unboundBody), false);
  assert.equal(/\bpremium\b/i.test(unboundBody), false);
  assert.equal(/\b100%/.test(unboundLetter.text), false);
  assert.equal(unboundBody.includes('trips@surfair.com'), false);
  const view = cfsIncidentView({ id: 'abc', ...report.value, ...hidden, coverageBound: true });
  assert.equal(view.coverage, '100%');
  const letter = incidentCfsLetter(view, 'https://example.test/cfs?aog=token');
  const body = `${letter.html}\n${letter.text}`;
  assert.match(body, /Coverage: 100%/);
  assert.match(body, /Hydraulic leak/);
  assert.equal(/premium/i.test(body), false);
  assert.equal(/50%/.test(body), false);
  assert.equal(body.includes('trips@surfair.com'), false);
  const again = validateAogReport({ ...report.value, idempotencyKey: 'same-key', wholeTrip: true, legs: report.value.legs });
  assert.equal(again.value.idempotencyKey, 'same-key');
});
