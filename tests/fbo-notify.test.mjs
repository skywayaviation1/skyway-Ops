import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTestRecipient,
  arrivalAutoDecision,
  arrivalPlanView,
  arrivalScheduleDecision,
  arrivalView,
  buildArrivalEmail,
  buildArrivalTimeChangeEmail,
  buildArrivalUpdateEmail,
  buildDepartureEmail,
  buildInboundEmail,
  DEFAULT_ARRIVAL_LEAD_HOURS,
  composeFboHtml,
  contactFromMatch,
  departureReminderDecision,
  deskCounts,
  directoryDocId,
  filterDeskLegs,
  isHandlingProvider,
  legSyncRecord,
  matchFbo,
  mergeSyncedLeg,
  omitUndefined,
  inboundDecision,
  paxLabel,
  pickDepartureSignal,
  publicLegView,
  resolveGlobalLeadHours,
  resolveTestMode,
  scoreFboNames,
  tripIdLabel,
} from '../src/fbo-notify.js';
import { signFboToken, verifyFboToken } from '../api/_fbo-token.js';
import { cronAuthorized } from '../src/fbo-notify.js';

const HOUR = 60 * 60 * 1000;
const SECRET = 'test-fbo-link-secret-value-24';

function leg(overrides = {}) {
  const now = overrides.now || Date.now();
  return {
    legUid: 'leg-1',
    tripId: 'WEQVQD',
    tail: 'N444AM',
    from: 'KAPF',
    to: 'KTEB',
    start: new Date(now + 2 * HOUR).toISOString(),
    end: new Date(now + 5 * HOUR).toISOString(),
    pax: 3,
    legType: 'REVENUE',
    departure: {
      airport: 'KAPF',
      aid: 'sig',
      name: 'Signature Aviation',
      email: 'csr@signature.example',
      matchStatus: 'auto',
      reminderStatus: 'scheduled',
    },
    arrival: {
      airport: 'KTEB',
      aid: 'mer',
      name: 'Meridian',
      email: 'teb@meridian.example',
      matchStatus: 'confirmed',
      arrivalStatus: 'not_sent',
      services: 'GPU',
      opsNotes: 'Call on final',
    },
    ...overrides,
  };
}

test('fuzzy match prefers the handling FBO and ignores fuel-only', () => {
  assert.ok(scoreFboNames('Signature Aviation', 'Signature Flight Support') >= 0.84);
  assert.ok(scoreFboNames('Atlantic Aviation', 'Atlantic Aviation') === 1);
  assert.ok(scoreFboNames('Million Air', 'Sheltair') < 0.62);
  const providers = [
    { aid: 'fuel', name: 'Self Serve Fuel', category: 'FUEL', fbo: false },
    { aid: 'sig', name: 'Signature Flight Support', category: 'HANDLING', fbo: true, email: '' },
    { aid: 'atl', name: 'Atlantic Aviation', category: 'HANDLING', fbo: true, email: 'a@atlantic.example' },
  ];
  assert.equal(isHandlingProvider(providers[0]), false);
  const match = matchFbo({ hints: ['Signature Aviation'], providers });
  assert.equal(match.provider.aid, 'sig');
  assert.equal(match.auto, true);
  const contact = contactFromMatch(match, { email: 'desk@signature.example', phone: '555', contact: 'Alex' });
  assert.equal(contact.email, 'desk@signature.example');
  assert.equal(contact.emailSource, 'directory');
});

test('ambiguous names stay unconfirmed and a preferred FBO is only a suggestion', () => {
  const providers = [
    { aid: 'a', name: 'Jet Center North', category: 'HANDLING', fbo: true },
    { aid: 'b', name: 'Jet Center South', category: 'HANDLING', fbo: true },
  ];
  const ambiguous = matchFbo({ hints: ['Jet Center'], providers });
  assert.equal(ambiguous.auto, false);
  const preferred = matchFbo({ hints: [], providers, preferredAid: 'b' });
  assert.equal(preferred.status, 'suggested');
  assert.equal(preferred.auto, false);
  assert.equal(preferred.provider.aid, 'b');
});

test('directory ids are airport plus aviowiki aid', () => {
  assert.equal(directoryDocId(' kapf ', 'sig/1'), 'KAPF__sig_1');
});

test('passenger line is a count or the empty label, never a name', () => {
  assert.equal(paxLabel({ pax: 4, legType: 'REVENUE' }), '4');
  assert.equal(paxLabel({ pax: 0, legType: 'REPO' }), 'EMPTY / repositioning');
  assert.equal(paxLabel({ pax: 0, legType: 'REVENUE' }), 'EMPTY / repositioning');
});

test('departure reminder waits, sends once, retimes, and skips cancelled legs', () => {
  const now = Date.parse('2026-10-11T15:00:00Z');
  const waiting = leg({
    now,
    start: new Date(now + 3 * HOUR).toISOString(),
  });
  assert.equal(departureReminderDecision(waiting, now).action, 'wait');

  const due = leg({
    now,
    start: new Date(now + 30 * 60 * 1000).toISOString(),
  });
  const first = departureReminderDecision(due, now);
  assert.equal(first.action, 'send');
  assert.match(first.key, /leg-1:dep:/);

  const sent = {
    ...due,
    departure: {
      ...due.departure,
      reminderStatus: 'sent',
      reminderSentForStart: due.start,
    },
  };
  assert.equal(departureReminderDecision(sent, now).reason, 'already-sent');

  const moved = {
    ...sent,
    start: new Date(now + 45 * 60 * 1000).toISOString(),
  };
  const retimed = departureReminderDecision(moved, now);
  assert.equal(retimed.action, 'send');
  assert.equal(retimed.reason, 'retimed');
  assert.notEqual(retimed.key, first.key);

  assert.equal(departureReminderDecision({ ...due, cancelled: true }, now).reason, 'cancelled');
  assert.equal(departureReminderDecision({
    ...due,
    departure: { ...due.departure, email: '' },
  }, now).reason, 'missing-email');
  assert.equal(departureReminderDecision({ ...due, emailsDisabled: true }, now).reason, 'trip-disabled');
});

test('opted-out FBOs are not mailed', () => {
  const now = Date.now();
  const due = leg({ start: new Date(now + 20 * 60 * 1000).toISOString() });
  const directory = new Map([
    [directoryDocId('KAPF', 'sig'), { optedOut: true, airport: 'KAPF', aid: 'sig' }],
  ]);
  assert.equal(departureReminderDecision(due, now, directory).reason, 'fbo-opt-out');
});

test('arrival auto-send stays off unless a lead time is configured', () => {
  const now = Date.now();
  const sample = leg({ end: new Date(now + 30 * 60 * 1000).toISOString() });
  assert.equal(arrivalAutoDecision(sample, now, null).reason, 'auto-off');
  assert.equal(arrivalAutoDecision(sample, now, 1).action, 'send');
  const sent = {
    ...sample,
    arrival: { ...sample.arrival, arrivalStatus: 'sent', sentForEnd: sample.end },
  };
  assert.equal(arrivalAutoDecision(sent, now, 1).reason, 'already-sent');
});

test('advance arrival defaults to 24 hours and can be overridden or turned off', () => {
  const now = Date.now();
  assert.equal(DEFAULT_ARRIVAL_LEAD_HOURS, 24);
  assert.equal(resolveGlobalLeadHours({}, false), 24);
  assert.equal(resolveGlobalLeadHours({ arrivalAutoLeadHours: 'off' }, true), null);

  const later = leg({ end: new Date(now + 30 * HOUR).toISOString() });
  const waiting = arrivalScheduleDecision(later, now, 24);
  assert.equal(waiting.action, 'wait');
  assert.equal(waiting.leadHours, 24);
  assert.ok(waiting.dueAt > now);

  const due = leg({ end: new Date(now + 20 * HOUR).toISOString() });
  const first = arrivalScheduleDecision(due, now, 24);
  assert.equal(first.action, 'send');
  const sent = {
    ...due,
    arrival: { ...due.arrival, arrivalStatus: 'sent', sentForEnd: due.end },
  };
  assert.equal(arrivalScheduleDecision(sent, now, 24).reason, 'already-sent');

  const offTrip = {
    ...due,
    arrival: { ...due.arrival, scheduleDisabled: true },
  };
  assert.equal(arrivalScheduleDecision(offTrip, now, 24).reason, 'advance-off');

  const sooner = {
    ...later,
    arrival: { ...later.arrival, leadHours: 6 },
  };
  assert.equal(arrivalScheduleDecision(sooner, now, 24).action, 'wait');
  assert.equal(arrivalScheduleDecision(sooner, now, 24).leadHours, 6);

  const at = new Date(now - 60 * 1000).toISOString();
  const timed = {
    ...later,
    arrival: { ...later.arrival, sendAt: at },
  };
  assert.equal(arrivalScheduleDecision(timed, now, null).action, 'send');
  assert.equal(arrivalScheduleDecision(timed, now, null).mode, 'at');
});

test('a material ETA change updates before confirmation and asks for a reconfirm after', () => {
  const now = Date.now();
  const end = new Date(now + 10 * HOUR).toISOString();
  const previous = new Date(now + 8 * HOUR).toISOString();
  const sent = leg({
    end,
    arrival: {
      airport: 'KTEB', aid: 'mer', name: 'Meridian', email: 'teb@meridian.example',
      matchStatus: 'confirmed', arrivalStatus: 'sent', sentForEnd: previous, services: 'GPU',
    },
  });
  const update = arrivalScheduleDecision(sent, now, 24);
  assert.equal(update.action, 'update');
  assert.match(update.key, /arr-update/);

  const nudge = leg({
    end: new Date(new Date(previous).getTime() + 5 * 60 * 1000).toISOString(),
    arrival: { ...sent.arrival, sentForEnd: previous },
  });
  assert.equal(arrivalScheduleDecision(nudge, now, 24).reason, 'already-sent');

  const confirmed = {
    ...sent,
    arrival: { ...sent.arrival, arrivalStatus: 'confirmed', confirmedBy: 'Dana Ruiz' },
  };
  const change = arrivalScheduleDecision(confirmed, now, 24);
  assert.equal(change.action, 'time-change');
  const noticed = {
    ...confirmed,
    arrival: { ...confirmed.arrival, timeChangeForEnd: end, arrivalStatus: 'needs_reconfirm', sentForEnd: end },
  };
  assert.equal(arrivalScheduleDecision(noticed, now, 24).reason, 'awaiting-reconfirm');

  const view = arrivalPlanView(sent, 24, now);
  assert.equal(view.scheduleAction, 'update');
  assert.ok(view.dueAt);
});

test('inbound mail waits for an actual departure and sends once', () => {
  const now = Date.now();
  const sample = leg({ start: new Date(now - 20 * 60 * 1000).toISOString() });
  assert.equal(inboundDecision(sample, now, null, null).reason, 'not-departed');
  assert.equal(pickDepartureSignal(sample), null);

  const wheels = pickDepartureSignal(sample, {
    tripState: { statuses: { wheels_up: { timestamp: now - 10 * 60 * 1000 } } },
  });
  assert.equal(wheels.source, 'wheels_up');
  const taxiOnly = pickDepartureSignal(sample, {
    tripState: { statuses: { taxi_dep: { timestamp: now - 15 * 60 * 1000 } } },
  });
  assert.equal(taxiOnly.source, 'taxi_dep');

  const fa = pickDepartureSignal(sample, {
    flightaware: { actualOff: new Date(now - 12 * 60 * 1000).toISOString(), origin: 'APF', destination: 'KTEB' },
  });
  assert.equal(fa.source, 'flightaware');
  const other = pickDepartureSignal(sample, {
    flightaware: { actualOff: new Date(now - 12 * 60 * 1000).toISOString(), origin: 'KOPF', destination: 'KTEB' },
  });
  assert.equal(other, null);

  const manual = pickDepartureSignal({ ...sample, departedManualAt: new Date(now - 5 * 60 * 1000).toISOString() });
  assert.equal(manual.source, 'manual');

  const due = inboundDecision(sample, now, null, wheels);
  assert.equal(due.action, 'send');
  assert.match(due.key, /:inbound$/);
  const mailed = {
    ...sample,
    arrival: { ...sample.arrival, inboundStatus: 'sent' },
  };
  assert.equal(inboundDecision(mailed, now, null, wheels).reason, 'already-sent');

  const inbound = buildInboundEmail(sample, 'https://www.skyway.app/fbo-confirm?token=abc', {
    timeZone: 'America/New_York',
    originTimeZone: 'America/New_York',
    departedAt: wheels.at,
  });
  assert.match(inbound.text, /Inbound — departed KAPF at /);
  assert.match(inbound.text, /WEQVQD/);
  assert.match(inbound.text, /subject to change/);
  assert.match(inbound.subject, /inbound/i);
  assert.doesNotMatch(`${inbound.html} ${inbound.text}`, /Jane|Doe/);

  const updateMail = buildArrivalUpdateEmail(sample, 'https://www.skyway.app/fbo-confirm?token=abc', {
    timeZone: 'America/New_York',
    previousEta: sample.end,
  });
  assert.match(updateMail.subject, /update/);
  assert.match(updateMail.text, /updated schedule/);
  const changeMail = buildArrivalTimeChangeEmail(sample, 'https://www.skyway.app/fbo-confirm?token=abc', {
    timeZone: 'America/New_York',
    previousEta: sample.end,
  });
  assert.match(changeMail.subject, /time change/);
  assert.match(changeMail.text, /reconfirm/);
});

test('test mode redirects to Jake and the banner names the FBO', () => {
  assert.equal(resolveTestMode(null), true);
  assert.equal(resolveTestMode({ testMode: false, live: true }), false);
  assert.equal(resolveTestMode({ testMode: false, live: true }, { FBO_EMAIL_TEST_MODE: '1' }), true);
  const routed = applyTestRecipient('csr@fbo.example', true);
  assert.equal(routed.to, 'jake@flyskyway.com');
  assert.equal(routed.intendedTo, 'csr@fbo.example');
  const html = composeFboHtml({ html: '<p>Hello</p>', testMode: true, intendedTo: routed.intendedTo });
  assert.match(html, /TEST MODE/);
  assert.match(html, /csr@fbo\.example/);
});

test('emails use the trip ID, local subject-to-change time, and no passenger names', () => {
  const sample = leg({
    pax: 0,
    legType: 'REPO',
    passengers: [{ firstName: 'Jane', lastName: 'Doe' }],
    start: '2026-10-11T20:00:00Z',
  });
  const departure = buildDepartureEmail(sample, { timeZone: 'America/New_York' });
  assert.match(departure.subject, /WEQVQD/);
  assert.doesNotMatch(departure.subject, /Jane|Doe/);
  assert.match(departure.text, /EMPTY \/ repositioning/);
  assert.match(departure.text, /subject to change/);
  assert.match(departure.text, /charters@flyskyway.com/);
  assert.match(departure.text, /727-605-5000/);
  assert.match(departure.html, /N444AM/);
  assert.equal(tripIdLabel({ tripNumber: '1044', tripId: 'AB12CD' }), 'AB12CD');
  assert.equal(tripIdLabel({ tripNumber: '1044' }), 'Unavailable');

  const arrival = buildArrivalEmail(sample, 'https://www.skyway.app/fbo-confirm?token=abc', { timeZone: 'America/New_York' });
  assert.match(arrival.html, /You're on our schedule/);
  assert.match(arrival.text, /GPU/);
  assert.doesNotMatch(`${arrival.html} ${arrival.text}`, /Jane|Doe/);
  const view = publicLegView(sample, { timeZone: 'America/New_York' });
  assert.equal(view.passengers, 'EMPTY / repositioning');
  assert.equal(view.tripId, 'WEQVQD');
  assert.equal(JSON.stringify(view).includes('Jane'), false);
});

test('arrival status labels name the CSR', () => {
  const view = arrivalView({
    arrivalStatus: 'confirmed',
    confirmedBy: 'Dana Ruiz',
    csrNotes: 'On the schedule',
  });
  assert.equal(view.label, 'Confirmed by Dana Ruiz');
  assert.equal(view.notes, 'On the schedule');
});

test('desk filters by airport, missing email, and open arrivals', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const rows = [
    leg({ legUid: 'a', from: 'KAPF', to: 'KTEB', start: new Date(now + HOUR).toISOString() }),
    leg({
      legUid: 'b',
      from: 'KPBI',
      to: 'KAPF',
      start: new Date(now + 2 * HOUR).toISOString(),
      departure: { email: '', matchStatus: 'suggested' },
      arrival: { email: 'x@y.co', arrivalStatus: 'confirmed', matchStatus: 'confirmed' },
    }),
  ];
  const open = filterDeskLegs(rows, { status: 'open' }, now);
  assert.deepEqual(open.map((row) => row.legUid), ['a']);
  const missing = filterDeskLegs(rows, { status: 'all', missingEmail: true }, now);
  assert.deepEqual(missing.map((row) => row.legUid), ['b']);
  const airport = filterDeskLegs(rows, { status: 'all', airport: 'pbi' }, now);
  assert.deepEqual(airport.map((row) => row.legUid), ['b']);
  assert.equal(deskCounts(rows, now).open, 1);
  assert.equal(deskCounts(rows, now).missingEmail, 1);
});

test('sync keeps a manual match and drops a leg removed from the feed window flags', () => {
  const now = Date.now();
  const trip = {
    uid: 'leg-9',
    start: new Date(now + 2 * HOUR),
    end: new Date(now + 4 * HOUR),
    info: {
      tail: 'N20UF', from: 'KAPF', to: 'KTEB', pax: 2, legType: 'REVENUE',
      isFlight: true, tripCode: 'H8N21Q', fromFbo: 'Signature Aviation',
    },
  };
  const record = legSyncRecord(trip);
  assert.equal(record.tripId, 'H8N21Q');
  const existing = {
    fromFboName: 'Signature Aviation',
    departure: { matchStatus: 'manual', locked: true, email: 'keep@fbo.example', name: 'Signature Aviation', aid: 'sig' },
  };
  const merged = mergeSyncedLeg(existing, record, now);
  assert.equal(merged.departure.matchStatus, 'manual');
  assert.equal(merged.departure.email, 'keep@fbo.example');
  const renamed = mergeSyncedLeg(existing, { ...record, fromFboName: 'Sheltair' }, now);
  assert.equal(renamed.departure.matchStatus, 'manual');
  const suggested = {
    fromFboName: 'Signature Aviation',
    departure: { matchStatus: 'suggested', locked: false, email: 'old@fbo.example', name: 'Signature Aviation' },
  };
  const cleared = mergeSyncedLeg(suggested, { ...record, fromFboName: 'Sheltair' }, now);
  assert.equal(cleared.departure.matchStatus, 'unmatched');
  assert.equal(cleared.departure.email, '');
});

test('confirmation tokens expire and reject a bad signature', () => {
  const env = { FBO_LINK_SECRET: SECRET };
  const issued = Date.parse('2026-10-01T00:00:00Z');
  const token = signFboToken('leg-1', issued, env);
  const fresh = verifyFboToken(token, issued + HOUR, env);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.legUid, 'leg-1');
  const expired = verifyFboToken(token, issued + 8 * 24 * HOUR, env);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
  assert.equal(verifyFboToken(`${token}x`, issued + HOUR, env).ok, false);
  assert.throws(() => signFboToken('leg-1', issued, { FBO_LINK_SECRET: 'short' }));
});

test('omitUndefined removes optional Firestore fields and keeps explicit nulls', () => {
  const written = omitUndefined({
    updatedAt: 1,
    arrival: {
      email: 'teb@meridian.example',
      sentForEnd: null,
      timeChangeForEnd: undefined,
      services: 'GPU',
    },
  });
  assert.equal(Object.hasOwn(written.arrival, 'timeChangeForEnd'), false);
  assert.equal(written.arrival.sentForEnd, null);
  assert.equal(written.arrival.services, 'GPU');
  assert.equal(written.updatedAt, 1);
});

test('the departure cron requires the bearer CRON_SECRET', () => {
  assert.equal(cronAuthorized({ headers: { authorization: 'Bearer secret' } }, { CRON_SECRET: 'secret' }), true);
  assert.equal(cronAuthorized({ headers: { authorization: 'Bearer no' } }, { CRON_SECRET: 'secret' }), false);
  assert.equal(cronAuthorized({ headers: { authorization: 'Bearer secret' } }, {}), false);
});
