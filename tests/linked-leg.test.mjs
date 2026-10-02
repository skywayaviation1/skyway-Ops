import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  brokerMaySeePax,
  composeBrokerTrip,
  delayNoticeText,
  enforcePublicTrip,
  immediateChainedLeg,
  linkExpiryLandedAt,
  movementEmailText,
  observerSharePatch,
  openSecondaryNotifyField,
  projectSharedLeg,
  repositioningProjection,
  saveSecondaryNotify,
  secondaryNotifyPayloads,
  secondaryRecipients,
  secondaryTrackingUrl,
} from '../src/linked-leg.js';

const HOUR = 3600 * 1000;

function tripAt(uid, { tail = 'N444AM', from = 'TEB', to = 'RVS', start, customer = 'Farley', category = 'Revenue' } = {}) {
  return {
    uid,
    start: new Date(start),
    info: { tail, from, to, customer, category, isFlight: true, legType: category === 'Repo' ? 'REPO' : 'REVENUE' },
  };
}

test('different broker or different trip id stays hidden even when showPax is true', () => {
  const viewer = { uid: 'obs', customer: 'Farley', tripCode: 'ABC123', brokerEmail: 'a@outlierjets.com' };
  const otherBroker = projectSharedLeg({
    tripId: 'own',
    presentAs: 'repositioning',
    showPax: true,
    hidePax: false,
    from: 'TEB',
    to: 'RVS',
    category: 'REVENUE',
    pax: [{ name: 'Pat Passenger' }],
    pic: 'Capt Hidden',
    fromFbo: 'Signature',
    status: { pax_arrived: { at: 1 }, wheels_up: { at: 2 } },
    flightNumber: 'SKW9',
    client: 'Farley',
  }, viewer, {
    uid: 'own',
    customer: 'NetJets',
    tripCode: 'ABC123',
    brokerEmail: 'b@netjets.com',
  });
  assert.equal(otherBroker.showPax, false);
  assert.equal(otherBroker.category, 'REPOSITIONING');
  assert.deepEqual(otherBroker.pax, []);
  assert.equal(otherBroker.pic, undefined);
  assert.equal(otherBroker.fromFbo, undefined);

  const otherTrip = projectSharedLeg({
    tripId: 'own',
    presentAs: 'repositioning',
    showPax: true,
    category: 'REVENUE',
    pax: [{ name: 'Pat Passenger' }],
  }, viewer, {
    uid: 'own',
    customer: 'Farley',
    tripCode: 'OTHER',
    brokerEmail: 'a@outlierjets.com',
  });
  assert.equal(otherTrip.showPax, false);
  assert.equal(brokerMaySeePax({
    viewer,
    leg: { uid: 'own', customer: 'Farley', tripCode: 'OTHER', brokerEmail: 'a@outlierjets.com' },
    hidePax: false,
  }), false);
});

test('server recompute ignores a client showPax flag when identity does not match', () => {
  const enforced = enforcePublicTrip({
    tail: 'N444AM',
    viewer: { uid: 'obs', customer: 'Farley', tripCode: 'ABC123', brokerEmail: 'spoof@outlierjets.com' },
    legs: [{
      tripId: 'own',
      presentAs: 'repositioning',
      showPax: true,
      hidePax: false,
      from: 'TEB',
      to: 'RVS',
      departure: '2026-09-26T14:00:00.000Z',
      arrival: '2026-09-26T17:00:00.000Z',
      category: 'REVENUE',
      ownerCustomer: 'Farley',
      ownerTripCode: 'ABC123',
      ownerBrokerEmail: 'a@outlierjets.com',
      pax: [{ name: 'Pat Passenger' }],
      pic: 'Capt Hidden',
      fromFbo: 'Signature',
      flightNumber: 'SKW9',
      client: 'Farley',
      status: { pax_arrived: { at: 10 }, taxi_dep: { at: 20 }, wheels_up: { at: 30 }, landed: { at: 40 } },
    }],
  }, {
    obs: { uid: 'obs', customer: 'Farley', tripCode: 'OBS1', brokerEmail: 'ops@farley.test' },
    own: { uid: 'own', customer: 'NetJets', tripCode: 'OWN9', brokerEmail: 'desk@netjets.com' },
  });
  const leg = enforced.legs[0];
  assert.equal(leg.category, 'REPOSITIONING');
  assert.equal(leg.presentAs, 'repositioning');
  assert.equal(leg.showPax, false);
  assert.deepEqual(leg.pax, []);
  assert.equal(leg.pic, undefined);
  assert.equal(leg.fromFbo, undefined);
  assert.equal(leg.flightNumber, undefined);
  assert.equal(leg.client, undefined);
  assert.equal(leg.paxCount, undefined);
  assert.equal(leg.status.pax_arrived, undefined);
  assert.equal(leg.status.taxi_dep.at, 20);
  assert.equal(leg.status.wheels_up.at, 30);
  assert.equal(leg.status.landed.at, 40);
  assert.equal(leg.from, 'TEB');
  assert.equal(leg.departure, '2026-09-26T14:00:00.000Z');
  assert.equal(enforced.viewer.customer, 'Farley');
  assert.equal(leg.ownerCustomer, 'NetJets');
  assert.equal(Object.prototype.hasOwnProperty.call(enforced, 'secondaryNotify'), false);
});

test('same broker and same trip id can hide passengers and still keep crew', () => {
  const viewer = { uid: 'obs', customer: 'Farley', tripCode: 'ABC123', brokerEmail: 'a@outlierjets.com' };
  const owner = { uid: 'own', customer: 'Outlier Jets', tripCode: 'ABC123', brokerEmail: 'desk@outlierjets.com' };
  assert.equal(brokerMaySeePax({ viewer, leg: owner, hidePax: false }), true);
  const hidden = projectSharedLeg({
    tripId: 'own',
    presentAs: 'repositioning',
    showPax: true,
    hidePax: true,
    category: 'REVENUE',
    pic: 'Capt Visible',
    sic: 'FO Visible',
    fromFbo: 'Signature TEB',
    pax: [{ name: 'Pat Passenger' }],
    status: { pax_boarded: { at: 5 }, wheels_up: { at: 9 } },
  }, viewer, owner);
  assert.equal(hidden.showPax, false);
  assert.deepEqual(hidden.pax, []);
  assert.equal(hidden.category, 'REVENUE');
  assert.equal(hidden.pic, 'Capt Visible');
  assert.equal(hidden.fromFbo, 'Signature TEB');
  assert.equal(hidden.status.pax_boarded, undefined);
  assert.equal(hidden.status.wheels_up.at, 9);

  const shown = projectSharedLeg({
    ...{ tripId: 'own', presentAs: 'repositioning', hidePax: false, category: 'REVENUE', pax: [{ name: 'Pat Passenger' }] },
    showPax: false,
  }, viewer, owner);
  assert.equal(shown.showPax, true);
  assert.equal(shown.pax[0].name, 'Pat Passenger');
});

test('observer projection is position and times only; owner leg stays a live charter', () => {
  const live = {
    obs: {
      identity: { uid: 'obs', customer: 'Farley', tripCode: 'OBS', brokerEmail: 'a@farley.test' },
      pax: [{ name: 'Owner Pax', status: 'checked_in' }],
      statuses: { wheels_up: { at: 3 } },
    },
    own: {
      identity: { uid: 'own', customer: 'NetJets', tripCode: 'OWN', brokerEmail: 'b@netjets.com' },
      pax: [{ name: 'Secret Pax', status: 'checked_in' }],
      statuses: { pax_arrived: { at: 1 }, landed: { at: 99 } },
    },
  };
  const observer = composeBrokerTrip({
    tripId: 'obs',
    publicTripData: {
      viewer: { uid: 'obs', customer: 'Spoof', tripCode: 'OWN', brokerEmail: 'b@netjets.com' },
      legs: [
        {
          tripId: 'obs',
          legNumber: 1,
          from: 'RVS',
          to: 'TEB',
          departure: '2026-09-26T18:00:00.000Z',
          arrival: '2026-09-26T21:00:00.000Z',
          category: 'REVENUE',
          showPax: true,
          pax: [{ name: 'Owner Pax' }],
          pic: 'Owner Capt',
          fromFbo: 'Atlantic',
        },
        {
          tripId: 'own',
          legNumber: 2,
          presentAs: 'repositioning',
          showPax: true,
          from: 'TEB',
          to: 'RVS',
          departure: '2026-09-26T12:00:00.000Z',
          arrival: '2026-09-26T15:00:00.000Z',
          category: 'REVENUE',
          ownerCustomer: 'Farley',
          ownerTripCode: 'OBS',
          pic: 'Other Capt',
          fromFbo: 'Signature',
          flightNumber: 'SKW1',
          client: 'NetJets',
          pax: [{ name: 'Secret Pax' }],
          status: { pax_arrived: { at: 1 }, taxi_dep: { at: 2 } },
        },
      ],
    },
    liveByTripId: live,
  });
  const borrowed = observer.legs[1];
  assert.equal(borrowed.category, 'REPOSITIONING');
  assert.equal(borrowed.presentAs, 'repositioning');
  assert.deepEqual(borrowed.pax, []);
  assert.equal(borrowed.showPax, false);
  assert.equal(borrowed.pic, undefined);
  assert.equal(borrowed.fromFbo, undefined);
  assert.equal(borrowed.flightNumber, undefined);
  assert.equal(borrowed.client, undefined);
  assert.equal(borrowed.paxCount, undefined);
  assert.equal(borrowed.status.pax_arrived, undefined);
  assert.equal(borrowed.status.taxi_dep.at, 2);
  assert.equal(borrowed.from, 'TEB');
  assert.equal(borrowed.departure, '2026-09-26T12:00:00.000Z');
  assert.equal(borrowed.ownerCustomer, undefined);

  const ownerView = composeBrokerTrip({
    tripId: 'own',
    publicTripData: {
      viewer: { uid: 'own' },
      legs: [{
        tripId: 'own',
        from: 'TEB',
        to: 'RVS',
        category: 'REVENUE',
        showPax: true,
        pax: [{ name: 'Secret Pax' }],
        pic: 'Other Capt',
      }],
    },
    liveByTripId: live,
  });
  assert.equal(ownerView.legs[0].category, 'REVENUE');
  assert.equal(ownerView.legs[0].showPax, true);
  assert.equal(ownerView.legs[0].pax[0].name, 'Secret Pax');
  assert.equal(ownerView.legs[0].pic, 'Other Capt');
});

test('repositioning card drops crew, FBO, and passenger milestones', () => {
  const card = repositioningProjection({
    tripId: 'own',
    from: 'TEB',
    to: 'RVS',
    departure: 'dep',
    arrival: 'arr',
    pic: 'Capt',
    fromFbo: 'Signature',
    status: { crew_onsite: { at: 1 }, taxi_dep: { at: 2 }, pax_boarded: { at: 3 } },
  });
  assert.deepEqual(Object.keys(card).sort(), [
    'arrival', 'category', 'departure', 'from', 'hasCatering', 'legNumber', 'pax', 'presentAs', 'showPax', 'status', 'to', 'tripId',
  ]);
  assert.deepEqual(card.status, { taxi_dep: { at: 2 } });
});

test('opening secondary notify prefills and does not write; a saved list stays put', () => {
  const opened = openSecondaryNotifyField({
    stored: null,
    prefill: 'next@broker.test',
  });
  assert.equal(opened.shouldWrite, false);
  assert.equal(opened.draft, 'next@broker.test');
  assert.equal(opened.persisted, null);

  const sticky = openSecondaryNotifyField({
    stored: ['saved@broker.test'],
    prefill: 'changed@broker.test',
  });
  assert.equal(sticky.shouldWrite, false);
  assert.equal(sticky.draft, 'saved@broker.test');
  assert.deepEqual(sticky.persisted, ['saved@broker.test']);

  const cleared = openSecondaryNotifyField({ stored: [], prefill: 'next@broker.test' });
  assert.equal(cleared.draft, '');
  assert.deepEqual(cleared.persisted, []);

  const saved = saveSecondaryNotify({
    draft: 'saved@broker.test, extra@broker.test',
    observerTripUid: 'obs',
    updatedBy: 'ops@skyway.test',
    now: 50,
  });
  assert.deepEqual(saved.secondaryNotify[0].emails, ['saved@broker.test', 'extra@broker.test']);
  assert.equal(saved.secondaryNotify[0].observerTripUid, 'obs');
  assert.equal(saved.secondaryNotify[0].presentAs, 'repositioning');
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'linkedLegs'), false);
});

test('share patch writes linked legs only', () => {
  const patch = observerSharePatch([
    { legUid: 'prev', role: 'previous', hidePax: true, secondaryNotify: ['nope@x.com'] },
    { legUid: 'next', role: 'sideways', hidePax: false },
  ]);
  assert.deepEqual(Object.keys(patch), ['linkedLegs']);
  assert.equal(patch.linkedLegs[0].presentAs, 'repositioning');
  assert.equal(patch.linkedLegs[0].hidePax, true);
  assert.equal(patch.linkedLegs[1].role, 'next');
  assert.equal(patch.secondaryNotify, undefined);
});

test('owner status copy stays the revenue template; secondary copy is repositioning', () => {
  const owner = movementEmailText({
    stepId: 'wheels_up',
    repo: false,
    tail: 'N444AM',
    from: 'TEB',
    to: 'RVS',
    greeting: 'Hi Farley,',
    localTimeStr: '10:00 AM EDT',
    arrTimeStr: '12:00 PM CDT',
    signature: '\n\n— Skyway Aviation',
    brandName: 'Skyway Aviation',
    customer: 'Farley',
    flightNumber: 'SKW100',
  });
  assert.equal(owner.subject, 'Wheels Up — N444AM TEB-RVS');
  assert.match(owner.text, /en route to RVS/);
  assert.doesNotMatch(owner.text, /repositioning/i);

  const landed = movementEmailText({
    stepId: 'landed',
    repo: false,
    tail: 'N444AM',
    from: 'TEB',
    to: 'RVS',
    greeting: 'Hi Farley,',
    localTimeStr: '10:00 AM EDT',
    arrTimeStr: '12:00 PM CDT',
    brandName: 'Skyway Aviation',
  });
  assert.match(landed.text, /Thank you for choosing Skyway Aviation/);

  const ready = movementEmailText({
    stepId: 'aircraft_ready',
    repo: false,
    tail: 'N444AM',
    from: 'TEB',
    to: 'RVS',
    greeting: 'Hi Farley,',
    localTimeStr: '9:00 AM EDT',
  });
  assert.match(ready.text, /passengers/);

  const secondary = secondaryNotifyPayloads({
    entries: [{ emails: ['second@broker.test', 'owner@broker.test'], observerTripUid: 'obs' }],
    ownerEmails: ['owner@broker.test'],
    stepId: 'wheels_up',
    tail: 'N444AM',
    from: 'TEB',
    to: 'RVS',
    localTimeStr: '10:00 AM EDT',
    arrTimeStr: '12:00 PM CDT',
    customer: 'Farley',
    flightNumber: 'SKW100',
  });
  assert.equal(secondary.length, 1);
  assert.deepEqual(secondary[0].to, ['second@broker.test']);
  assert.match(secondary[0].subject, /Repositioning/);
  assert.match(secondary[0].text, /repositioning flight/);
  assert.doesNotMatch(secondary[0].text, /Farley/);
  assert.doesNotMatch(secondary[0].text, /SKW100/);
  assert.doesNotMatch(secondary[0].text, /passenger/i);
  assert.equal(secondary[0].trackingForTripId, 'obs');

  assert.deepEqual(secondaryNotifyPayloads({
    entries: [{ emails: ['second@broker.test'], observerTripUid: 'obs' }],
    ownerEmails: [],
    stepId: 'pax_boarded',
    tail: 'N444AM',
    from: 'TEB',
    to: 'RVS',
  }), []);
  assert.deepEqual(secondaryRecipients(['owner@broker.test'], { emails: ['owner@broker.test', 'second@broker.test'] }), ['second@broker.test']);
});

test('secondary tracking url is signed for the observer trip', () => {
  const calls = [];
  const url = secondaryTrackingUrl({
    observerTripUid: 'obs-uid',
    linkTokenIssuedAt: 42,
    linkRevoked: false,
    origin: 'https://www.skyway.app',
    sign: (uid, issuedAt) => {
      calls.push([uid, issuedAt]);
      return 'observer-token';
    },
  });
  assert.deepEqual(calls, [['obs-uid', 42]]);
  assert.equal(url, 'https://www.skyway.app/trip-track.html?token=observer-token');
  assert.equal(secondaryTrackingUrl({
    observerTripUid: 'obs-uid',
    linkTokenIssuedAt: 42,
    linkRevoked: true,
    sign: () => 'nope',
  }), null);
  assert.equal(secondaryTrackingUrl({
    observerTripUid: 'obs-uid',
    linkRevoked: false,
    sign: () => 'nope',
  }), null);
});

test('link expiry ignores a borrowed repositioning landing', () => {
  const landed = linkExpiryLandedAt({
    viewerUid: 'obs',
    anchorStatuses: {},
    snapshotLegs: [
      { tripId: 'obs', status: { landed: { at: 100 } } },
      { tripId: 'own', presentAs: 'repositioning', status: { landed: { at: 500 } } },
      { tripId: 'other', status: { landed: { at: 800 } } },
    ],
    liveByTripId: {
      own: { statuses: { landed: { at: 900 } } },
      obs: { statuses: { landed: { at: 150 } } },
    },
  });
  assert.equal(landed, 150);
});

test('secondary prefill walks only the immediately chained next leg inside 30 hours', () => {
  const anchor = tripAt('a', { from: 'TEB', to: 'RVS', start: 0 });
  const next = tripAt('b', { from: 'RVS', to: 'TEB', start: 30 * HOUR, customer: 'Other' });
  const tooFar = tripAt('c', { from: 'RVS', to: 'TEB', start: 31 * HOUR, customer: 'Other' });
  const wrongAirport = tripAt('d', { from: 'MIA', to: 'TEB', start: 2 * HOUR, customer: 'Other' });
  const beyond = tripAt('e', { from: 'TEB', to: 'PBI', start: 40 * HOUR, customer: 'Other' });
  assert.equal(immediateChainedLeg(anchor, [anchor, next], 'next').uid, 'b');
  assert.equal(immediateChainedLeg(anchor, [anchor, tooFar], 'next'), null);
  assert.equal(immediateChainedLeg(anchor, [anchor, wrongAirport, next], 'next'), null);
  assert.equal(immediateChainedLeg(anchor, [beyond, anchor], 'previous'), null);
  const prev = tripAt('p', { from: 'MIA', to: 'TEB', start: -5 * HOUR, customer: 'Other', category: 'Revenue' });
  assert.equal(immediateChainedLeg(anchor, [prev, anchor, next], 'previous').uid, 'p');
});

test('repositioning delay copy omits the passenger arrival line', () => {
  const notice = delayNoticeText({
    repo: true,
    tail: 'N444AM',
    route: 'TEB-RVS',
    greeting: 'Hi Next,',
    reason: 'Weather',
    paxArrivalTime: '3:00 PM',
  });
  assert.match(notice.subject, /Repositioning Delay/);
  assert.match(notice.text, /repositioning/);
  assert.doesNotMatch(notice.text, /passenger/i);
});

test('enqueue still copies charters and signs the observer tracking link', () => {
  const enqueue = readFileSync(new URL('../api/email-enqueue.js', import.meta.url), 'utf8');
  assert.match(enqueue, /withCharterCopy\(\{ to: validTo, cc: validCc \}\)/);
  assert.match(enqueue, /trackingForTripId/);
  assert.match(enqueue, /secondaryTrackingUrl/);
  const share = readFileSync(new URL('../api/trip-share.js', import.meta.url), 'utf8');
  assert.match(share, /observerSharePatch/);
  assert.match(share, /enforcePublicTrip/);
  assert.doesNotMatch(share, /patch\.secondaryNotify/);
  const pub = readFileSync(new URL('../api/trip-public.js', import.meta.url), 'utf8');
  assert.match(pub, /composeBrokerTrip/);
  assert.match(pub, /linkExpiryLandedAt/);
  const track = readFileSync(new URL('../src/TripTrack.jsx', import.meta.url), 'utf8');
  assert.match(track, /presentAs === 'repositioning'/);
});
