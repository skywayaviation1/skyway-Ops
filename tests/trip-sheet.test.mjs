import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  parseTripSheetPages,
  parseJetInsightTripSheet,
  pagesToReadingText,
  planTripSheetPropagation,
  legDepartureUtcMs,
  mergePreloadedPax,
  resolveTripSheetNotes,
  fboForAirport,
} from '../src/trip-sheet.js';

const fixtureDir = path.join(import.meta.dirname, 'fixtures', 'trip-sheets');

// Real passenger names, crew, client contacts, and the original weights/phones
// must never land in the repo. The fixtures are position dumps with those
// strings replaced; this list is the check that the replacement held.
const BANNED = [
  'Simianer', 'Cavazos', 'Schrager', 'Brennan', 'Glancey', 'Kosakowski',
  'Friedman', 'Sterre', 'Braedon', 'Crocier', 'Hagberg', 'Kolberg', 'Ditroia',
  'Wietzke', 'flyvictor', 'flysmoother', 'titan.aero', 'yvictor', 'ysmoother',
  '3109132684', '2014003126', '574-343', '475-0657', '262-308', '928-0839',
  '997-6989', '601-5599', '301 lbs', '225 lbs', '190 lbs', '200 lbs', '230 lbs', '250 lbs',
];

function load(name) {
  const raw = readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8');
  for (const needle of BANNED) {
    assert.equal(raw.toLowerCase().includes(needle.toLowerCase()), false, `${name} still contains ${needle}`);
  }
  return parseTripSheetPages(JSON.parse(raw));
}

function paxName(pax) {
  return `${pax.firstName} ${pax.lastName}`;
}

test('QCO5LD crew sheet parses every leg, passenger, and cost field', () => {
  const parsed = load('qco5ld');
  assert.equal(parsed.tripCode, 'QCO5LD');
  assert.equal(parsed.tail, 'N168ZZ');
  assert.equal(parsed.aircraftType, 'Bombardier Lear 60');
  assert.equal(parsed.operator.name, 'Skyway Aviation Services, Inc');
  assert.equal(parsed.operator.email, 'charters@flyskyway.com');
  assert.equal(parsed.client.company, 'Northwind Aviation');
  assert.equal(parsed.client.contact, 'Northwind Aviation');
  assert.equal(parsed.client.email, 'client@example.com');
  assert.equal(parsed.planner, null);
  assert.match(parsed.notes.pax, /insufficient baggage/i);
  assert.equal(parsed.crewContacts.pic.name, 'Avery Cole');
  assert.equal(parsed.crewContacts.pic.email, 'pic@example.com');
  assert.equal(parsed.crewContacts.sic.name, 'Blake Nguyen');
  assert.equal(parsed.legs.length, 4);

  const [l1, l2, l3, l4] = parsed.legs;
  assert.deepEqual([l1.from, l1.to, l1.partClass, l1.paxCount], ['9TE2', 'SAT', 'Part 91', 0]);
  assert.equal(l1.depTimeLocal, '14:30');
  assert.equal(l1.depTimeLocalTz, 'CDT');
  assert.equal(l1.depTimeZ, '19:30');
  assert.equal(l1.distance, '119 nm');
  assert.equal(l1.blockTime, '0:42');
  assert.equal(l1.flightTime, '0:30');
  assert.equal(l1.fromFbo, 'Jl Bar Ranch & Resort Airport');
  assert.equal(l1.fromFrequencyKind, 'A2G');
  assert.equal(l1.fromFrequency, '123.075');
  assert.equal(l1.toFbo, 'Million Air');
  assert.equal(l1.released, true);
  assert.equal(l1.releasedBy, 'Ops Desk');
  assert.equal(l1.vettingApplicable, false);
  assert.equal(l1.fees['9TE2'].landing, null);
  assert.equal(l1.fees.SAT.groundHandling, 300);
  assert.equal(l1.fees.SAT.groundHandlingWaivedGals, 200);
  assert.equal(l1.fuel['9TE2'].tiers.length, 4);
  assert.equal(l1.fuel['9TE2'].note, '9TE2 AVFUEL');
  assert.equal(l1.pax.length, 0);
  assert.equal(fboForAirport(parsed, '9TE2'), 'Jl Bar Ranch & Resort Airport');
  assert.equal(fboForAirport(parsed, 'KSAT'), 'Million Air');

  assert.equal(l2.partClass, 'Part 135');
  assert.equal(l2.flightNumber, 3946);
  assert.equal(l2.timeChange, '-1');
  assert.equal(l2.arrTimeLocalTz, 'MDT');
  assert.equal(l2.toAirportName, 'Salt Lake City Intl');
  assert.equal(l2.toAirportPhone, '385-715-7192');
  assert.deepEqual(l2.pax.map(paxName), ['Alex Morgan', 'Jordan Lee']);
  assert.equal(l2.pax[0].primary, true);
  assert.equal(l2.pax[0].gender, 'Male');
  assert.equal(l2.pax[0].dob, '1/2/90');
  assert.equal(l2.pax[0].weight, 170);
  assert.equal(l2.pax[1].primary, false);
  assert.equal(l2.totalPaxWeight, 325);
  assert.equal(l2.vettedAt, '09/24/2026 15:29 Z');
  assert.equal(l2.paxCleared, true);
  assert.equal(l2.released, false);
  assert.equal(l2.fees.SLC.landing, 43);
  assert.equal(l2.fuel.SAT.tiers.at(-1).price, 6.81);
  assert.equal(l2.catering.arrangedBy, 'broker');
  assert.equal(l2.catering.items[0].description, 'Beef Short Rib Tacos');
  assert.equal(l2.catering.items[1].quantity, 1);

  assert.equal(l3.from, 'SLC');
  assert.equal(l3.flightNumber, 3950);
  assert.equal(l3.timeChange, '+1');
  assert.equal(l3.fuel.SLC.note, 'SLC ATLANTIC');
  assert.deepEqual(l3.pax.map(paxName), ['Alex Morgan', 'Jordan Lee']);

  assert.equal(l4.from, 'SAT');
  assert.equal(l4.to, '9TE2');
  assert.equal(l4.partClass, 'Part 91');
  assert.equal(l4.paxCount, 0);
  assert.equal(l4.vettingApplicable, false);
});

test('211WEE keeps two same-day TEB-YIP legs distinct', () => {
  const parsed = load('211wee');
  assert.equal(parsed.tripCode, '211WEE');
  assert.equal(parsed.tail, 'N525CR');
  assert.equal(parsed.aircraftType, 'Cessna Citation CJ3');
  assert.equal(parsed.client.contact, 'Sam Rivera');
  assert.equal(parsed.client.company, null);
  assert.equal(parsed.client.email, 'client@example.com');
  assert.equal(parsed.client.phone, '5550102001');
  assert.equal(parsed.planner, null);
  assert.equal(parsed.legs.length, 3);

  const [l1, l2, l3] = parsed.legs;
  assert.equal(l1.from, 'TEB');
  assert.equal(l1.to, 'YIP');
  assert.equal(l1.depTimeLocal, '09:45');
  assert.equal(l1.partClass, 'Part 135');
  assert.equal(l1.flightNumber, 3960);
  assert.equal(l1.toFrequencyKind, 'UNICOM');
  assert.equal(l1.toFrequency, '122.825');
  assert.equal(l1.pax.length, 1);
  assert.equal(l1.pax[0].primary, true);
  assert.equal(l1.fees.TEB.parking, 772);
  assert.equal(l1.fees.TEB.parkingWaivedNights, 0);
  assert.equal(l1.fees.TEB.parkingWaivedGals, 0);
  assert.equal(l1.fuel.TEB.note, 'TEB ATLANTIC');

  assert.equal(l2.from, 'TEB');
  assert.equal(l2.to, 'YIP');
  assert.equal(l2.depTimeLocal, '18:03');
  assert.equal(l2.partClass, 'Part 91');
  assert.equal(l2.flightNumber, null);
  assert.equal(l2.paxCount, 0);
  assert.equal(l2.vettingApplicable, false);
  assert.notEqual(legDepartureUtcMs(l1), legDepartureUtcMs(l2));

  assert.equal(l3.from, 'YIP');
  assert.equal(l3.to, 'TEB');
  assert.equal(l3.depTimeZ, '00:30');
  assert.equal(l3.depDate, '09/26/2026');
  assert.equal(l3.flightNumber, 3961);
  assert.equal(l3.fuel.YIP.note, 'YIP RETAIL with Avcard');
  assert.equal(l3.pax.length, 1);
  // 20:30 EDT is 00:30 Z the next calendar day.
  const dep = new Date(legDepartureUtcMs(l3));
  assert.equal(dep.getUTCHours(), 0);
  assert.equal(dep.getUTCDate(), 27);
});

test('SVRCGD passenger lists differ by leg and fuel notes stay intact', () => {
  const parsed = load('svrcgd');
  assert.equal(parsed.tripCode, 'SVRCGD');
  assert.equal(parsed.tail, 'N286N');
  assert.equal(parsed.aircraftType, 'Cessna Citation CJ3');
  assert.equal(parsed.client.company, 'Northwind Aviation');
  assert.equal(parsed.client.contact, null);
  assert.equal(parsed.client.email, 'client@example.com');
  assert.equal(parsed.planner.name, 'Jamie Ortiz');
  assert.equal(parsed.planner.email, 'planner@example.com');
  assert.equal(parsed.planner.phone, '5550102002');
  assert.equal(parsed.legs.length, 3);

  const [l1, l2, l3] = parsed.legs;
  assert.equal(l1.partClass, 'Part 91');
  assert.equal(l1.paxCount, 0);
  assert.equal(l1.fromFbo, 'Sheltair Tampa Jet Center');
  assert.equal(l1.fees.DJT.infrastructure, 165);
  assert.equal(l1.fuel.TPA.brand, 'Avfuel');
  assert.equal(l1.fuel.TPA.note, null);
  assert.equal(l1.vettingApplicable, false);

  assert.equal(l2.paxCount, 4);
  assert.deepEqual(l2.pax.map(paxName), ['Alex Morgan', 'Jordan Lee', 'Casey Nguyen', 'Riley Patel']);
  assert.equal(l2.pax[0].primary, true);
  assert.equal(l2.pax[2].primary, false);
  assert.equal(l2.totalPaxWeight, 680);
  assert.equal(l2.flightNumber, 3959);
  assert.equal(l2.toFrequencyKind, 'UNICOM');
  assert.equal(l2.fees.MRH.parkingWaivedNights, 1);
  assert.equal(l2.fees.MRH.parkingWaivedGals, 100);
  assert.equal(l2.fuel.DJT.note, 'FXE ATLANTIC');

  assert.equal(l3.paxCount, 3);
  assert.deepEqual(l3.pax.map(paxName), ['Casey Nguyen', 'Jordan Lee', 'Riley Patel']);
  assert.equal(l3.pax[0].primary, true);
  assert.equal(l3.pax.some((pax) => pax.firstName === 'Alex'), false);
  assert.equal(l3.totalPaxWeight, 510);
  assert.equal(l3.flightNumber, 3962);
  assert.equal(l3.fuel.MRH.note, 'Discounted fuel with Avcard');
  assert.equal(l3.fuel.MRH.tiers.length, 0);
  assert.equal(l3.vettedAt, '09/26/2026 03:00 Z');
});

function scheduleCode(code) {
  // iCal uses K + IATA for public US fields. Private strips like 9TE2
  // are already four characters and are stored as printed.
  return /^[A-Z]{3}$/.test(code) ? `K${code}` : code;
}

function scheduleTrip(leg, uid, tail) {
  return {
    uid,
    start: new Date(legDepartureUtcMs(leg)).toISOString(),
    info: { tail, from: scheduleCode(leg.from), to: scheduleCode(leg.to) },
  };
}

test('uploading one sheet plans an update for every matching schedule leg', () => {
  const parsed = load('qco5ld');
  const trips = parsed.legs.map((leg, index) => scheduleTrip(leg, `leg-${index + 1}`, parsed.tail));
  const plan = planTripSheetPropagation({ parsed, allTrips: trips, now: 1000 });
  assert.equal(plan.attachedCount, 4);
  assert.equal(plan.unmatchedCount, 0);
  assert.deepEqual(plan.matches.map((match) => match.update.tripUid), ['leg-1', 'leg-2', 'leg-3', 'leg-4']);
  assert.equal(plan.matches[1].update.tripSheetData.flightNumber, 3946);
  assert.equal(plan.matches[1].update.tripSheetData.fromFbo, 'Million Air');
  assert.equal(plan.matches[1].update.tripSheetData.client.email, 'client@example.com');
  assert.equal(plan.matches[1].update.preloadedPax[0].id, 'pre-leg-2-0');
  assert.equal(plan.matches[1].update.preloadedPax[0].checkInStatus, 'pending');
  assert.equal(plan.matches[0].update.preloadedPax.length, 0);
});

test('same-route same-day legs attach to different trips, and a missing leg is not created', () => {
  const parsed = load('211wee');
  const trips = [
    scheduleTrip(parsed.legs[0], 'morning', parsed.tail),
    scheduleTrip(parsed.legs[2], 'return', parsed.tail),
  ];
  const plan = planTripSheetPropagation({ parsed, allTrips: trips });
  assert.equal(plan.matches[0].update.tripUid, 'morning');
  assert.equal(plan.matches[1].update, null);
  assert.equal(plan.matches[1].unmatchedReason, 'no-schedule-leg');
  assert.equal(plan.matches[2].update.tripUid, 'return');
  assert.equal(plan.attachedCount, 2);

  const swapped = planTripSheetPropagation({
    parsed,
    allTrips: [scheduleTrip(parsed.legs[0], 'only', 'N00000')],
  });
  assert.equal(swapped.matches[0].tailMismatch, true);
  assert.equal(swapped.matches[0].update.tripUid, 'only');
  assert.equal(swapped.matches[1].update, null);
});

test('re-upload keeps edited notes and check-in progress', () => {
  const parsed = load('svrcgd');
  const revenue = parsed.legs[1];
  const trip = scheduleTrip(revenue, 'djtmrh', parsed.tail);
  const existing = {
    tripSheetNotesEditedAt: 50,
    tripSheetNotes: { pax: 'Crew added a note', crew: null, customer: null, specialItems: null },
    preloadedPax: [
      {
        id: 'pre-djtmrh-0',
        firstName: 'Alex',
        lastName: 'Morgan',
        gender: 'Male',
        dob: '1/1/80',
        weight: 100,
        primary: false,
        scannedPaxId: 'scan-1',
        checkInStatus: 'matched',
      },
      {
        id: 'pre-djtmrh-9',
        firstName: 'Skipped',
        lastName: 'Person',
        checkInStatus: 'skipped',
        scannedPaxId: null,
      },
    ],
  };
  const plan = planTripSheetPropagation({
    parsed,
    allTrips: [trip],
    statesByUid: { djtmrh: existing },
  });
  const match = plan.matches[1];
  assert.equal(match.preservedManualNotes, true);
  assert.equal(match.preservedPaxProgress, true);
  assert.equal(match.update.tripSheetNotes.pax, 'Crew added a note');
  const alex = match.update.preloadedPax.find((pax) => pax.lastName === 'Morgan');
  assert.equal(alex.id, 'pre-djtmrh-0');
  assert.equal(alex.checkInStatus, 'matched');
  assert.equal(alex.scannedPaxId, 'scan-1');
  assert.equal(alex.weight, 170);
  assert.equal(alex.primary, true);
  assert.equal(match.update.preloadedPax.some((pax) => pax.lastName === 'Person'), false);
  assert.equal(match.update.preloadedPax.length, 4);
});

test('mergePreloadedPax refreshes a clean list and keeps sticky names', () => {
  const fresh = mergePreloadedPax([], [{ firstName: 'Alex', lastName: 'Morgan', weight: 170, primary: true }], 't1');
  assert.equal(fresh[0].checkInStatus, 'pending');
  assert.equal(fresh[0].id, 'pre-t1-0');

  const kept = mergePreloadedPax(
    [{ id: 'old', firstName: 'Alex', lastName: 'Morgan', checkInStatus: 'carried_over', scannedPaxId: 's', weight: 90 }],
    [],
    't1',
  );
  assert.equal(kept[0].id, 'old');
  assert.equal(kept[0].checkInStatus, 'carried_over');

  const notes = resolveTripSheetNotes(
    { tripSheetNotesEditedAt: 1, tripSheetNotes: { pax: 'keep' } },
    { pax: 'from sheet' },
  );
  assert.equal(notes.preservedManualNotes, true);
  assert.equal(notes.notes.pax, 'keep');
});

test('flat crew-itinerary text is not parsed; a passenger itinerary still is', () => {
  const pages = JSON.parse(readFileSync(path.join(fixtureDir, 'qco5ld.json'), 'utf8'));
  const reading = pagesToReadingText(pages);
  assert.match(reading, /Crew Itinerary/);
  assert.equal(parseJetInsightTripSheet(reading), null);

  const passenger = parseJetInsightTripSheet([
    'Passenger Itinerary (AB12CD)',
    'N123AB',
    'Leg 1: TEB 09/26/2026 - 9:45 am EDT YIP 09/26/2026 - 11:27 am EDT',
    'PIC: Avery Cole',
    'SIC: Blake Nguyen',
    'Passengers (1)',
    'Alex Morgan',
  ].join('\n'));
  assert.equal(passenger._isPassengerItinerary, true);
  assert.equal(passenger.tripCode, 'AB12CD');
  assert.equal(passenger.legs[0].from, 'TEB');
  assert.equal(passenger.legs[0].depTimeLocal, '09:45');
  assert.equal(passenger.legs[0].pax[0].firstName, 'Alex');
  assert.equal(passenger.legs[0].pax[0].weight, null);
});
