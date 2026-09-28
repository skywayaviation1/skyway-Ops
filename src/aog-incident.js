// Report AOG. Pure helpers shared by the ops API and tests.
// Charter Flight Support is notified only when the trip is already at 100%.
// The CFS view never includes premiums, margins, broker contacts, or passenger names.

import { isHundredCoverage } from './aog-reporting.js';
import { emailButton, emailShell, factTable } from './aog-mail-layout.js';
import { acceptTripCode } from './trip-id.js';

function cleanLeg(leg) {
  return {
    id: String(leg?.id || leg?.uid || '').slice(0, 80),
    from: String(leg?.from || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
    to: String(leg?.to || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4),
    departAt: String(leg?.departAt || leg?.start || '').slice(0, 40),
    tail: String(leg?.tail || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8),
  };
}

export function validateAogReport(input = {}) {
  const tripId = acceptTripCode(input.tripId);
  if (!tripId) return { ok: false, error: 'A valid trip code is required' };
  const legs = (Array.isArray(input.legs) ? input.legs : []).map(cleanLeg)
    .filter((leg) => leg.id || leg.from || leg.to)
    .slice(0, 12);
  const wholeTrip = input.wholeTrip === true;
  const selected = new Set((Array.isArray(input.legIds) ? input.legIds : []).map((id) => String(id)));
  const chosen = wholeTrip ? legs : legs.filter((leg) => selected.has(leg.id));
  if (chosen.length === 0) return { ok: false, error: 'Select at least one leg, or the whole trip' };
  const location = String(input.location || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (location.length < 3) return { ok: false, error: 'Enter the airport or location' };
  const aogAt = String(input.aogAt || '').trim().slice(0, 40);
  if (!aogAt) return { ok: false, error: 'Enter the time it went AOG' };
  const issue = String(input.issue || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (issue.length < 4) return { ok: false, error: 'Describe the issue' };
  return {
    ok: true,
    value: {
      tripId,
      wholeTrip,
      legs: chosen,
      tail: String(input.tail || chosen.find((leg) => leg.tail)?.tail || '').toUpperCase().slice(0, 8),
      aircraftType: String(input.aircraftType || '').trim().slice(0, 80),
      route: chosen.map((leg) => [leg.from, leg.to].filter(Boolean).join(' → ')).filter(Boolean).join(' · '),
      location,
      aogAt,
      issue,
      notes: String(input.notes || '').trim().slice(0, 1000),
      contact: String(input.contact || '').trim().slice(0, 160),
      idempotencyKey: String(input.idempotencyKey || '').trim().slice(0, 80),
    },
  };
}

export function cfsShouldBeNotified(records) {
  return (records || []).some((record) => isHundredCoverage(record?.coverageLevel));
}

export function cfsIncidentView(incident = {}) {
  return {
    id: incident.id || '',
    tripId: incident.tripId || '',
    tail: incident.tail || '',
    aircraftType: incident.aircraftType || '',
    route: incident.route || '',
    legs: (incident.legs || []).map((leg) => ({
      id: leg.id || '',
      from: leg.from || '',
      to: leg.to || '',
      departAt: leg.departAt || '',
      tail: leg.tail || '',
    })),
    location: incident.location || '',
    aogAt: incident.aogAt || '',
    issue: incident.issue || '',
    notes: incident.notes || '',
    contact: incident.contact || '',
    status: incident.status || 'active',
    coverage: '100%',
    updates: (incident.updates || []).map((row) => ({
      at: row.at || '',
      text: row.text || '',
      by: row.by || '',
    })),
  };
}

export function incidentCfsLetter(incident, url) {
  const subject = `AOG incident — trip ${incident.tripId || ''}`.trim();
  const lede = `An aircraft on trip ${incident.tripId || 'this trip'} is AOG. Coverage for this trip is 100%.`;
  const html = emailShell({
    coBrand: true,
    preheader: `Active AOG on trip ${incident.tripId || ''}.`,
    headline: 'Active AOG — response needed',
    lede,
    body: `${factTable([
      ['Trip ID', incident.tripId],
      ['Tail', incident.tail],
      ['Aircraft', incident.aircraftType],
      ['Route', incident.route],
      ['Location', incident.location],
      ['AOG time', incident.aogAt],
      ['Issue', incident.issue],
      ['Notes', incident.notes],
      ['Contact', incident.contact],
      ['Coverage', '100%'],
    ])}${emailButton(url, 'Open the active AOG')}`,
  });
  const text = [
    lede,
    `Trip ID: ${incident.tripId || ''}`,
    `Location: ${incident.location || ''}`,
    `AOG time: ${incident.aogAt || ''}`,
    `Issue: ${incident.issue || ''}`,
    `Coverage: 100%`,
    `Open the active AOG: ${url || ''}`,
  ].join('\n');
  return { subject, html, text };
}

export function incidentInternalLetter(incident) {
  const subject = `AOG recorded internally — trip ${incident.tripId || ''}`.trim();
  const lede = 'This AOG was recorded for Skyway ops. Charter Flight Support was not notified because the trip is not covered at 100%.';
  const html = emailShell({
    headline: 'AOG recorded internally',
    lede,
    body: factTable([
      ['Trip ID', incident.tripId],
      ['Tail', incident.tail],
      ['Location', incident.location],
      ['AOG time', incident.aogAt],
      ['Issue', incident.issue],
      ['Coverage', 'Not covered at 100% by Charter Flight Support'],
    ]),
  });
  const text = [lede, `Trip ${incident.tripId || ''}`, incident.location || '', incident.issue || ''].join('\n');
  return { subject, html, text };
}
