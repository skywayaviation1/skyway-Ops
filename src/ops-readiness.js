// Pure flight-control readiness rules shared by the OCC exception queue and
// the detailed Dispatch board. Nothing here grants a legal release; this is an
// operational coordination checklist over data already stored on each trip.

import { fboCallOutstanding } from './fbo-call.js';

export const OPS_STATUS_STEPS = Object.freeze([
  { id: 'crew_onsite', label: 'CREW' },
  { id: 'aircraft_ready', label: 'A/C' },
  { id: 'catering_aboard', label: 'CTR', revenueOnly: true, cateringOnly: true },
  { id: 'pax_arrived', label: 'PAX IN', revenueOnly: true },
  { id: 'pax_boarded', label: 'PAX BRD', revenueOnly: true },
  { id: 'taxi_dep', label: 'TAXI' },
  { id: 'wheels_up', label: 'UP' },
  { id: 'landed', label: 'DOWN' },
]);

/**
 * Whether a leg's status list should include the catering milestone.
 *
 * A leg with no catering ordered would otherwise show a milestone that can
 * never complete, which reads to a broker as something outstanding. Catering
 * already recorded still shows, so turning the flag off later never hides
 * history.
 */
export function showsCateringStatus(leg) {
  const recorded = leg?.status?.catering_aboard;
  if (recorded && (recorded.at || recorded === true || recorded.timestamp)) return true;
  return leg?.hasCatering !== false;
}

export function tripStartMs(trip) {
  const value = trip?.start;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function operationalTrip(trip) {
  if (!trip?.info) return false;
  if (trip.info.isOps === false || trip.info.isFlight === false) return false;
  if (['HOLD', 'MX', 'TRAINING'].includes(String(trip.info.category || '').toUpperCase())) return false;
  if (trip.info.from && trip.info.from === trip.info.to && !trip.info.pax) return false;
  return tripStartMs(trip) != null;
}

/**
 * Window used by Dispatch: the next 48 hours plus anything that departed in
 * the last 24 hours and remains incomplete. Legacy trips older than that never
 * leak onto the live board merely because nobody marked them complete.
 */
export function buildActiveOpsTrips(trips, tripStates, now = Date.now()) {
  const futureEnd = now + 48 * 3600_000;
  const pastStart = now - 24 * 3600_000;
  return (Array.isArray(trips) ? trips : [])
    .filter(operationalTrip)
    .filter((trip) => {
      const start = tripStartMs(trip);
      const state = tripStates?.get?.(trip.uid) || null;
      if (state?.completed || state?.archived) return false;
      return start >= pastStart && start <= futureEnd;
    })
    .sort((a, b) => tripStartMs(a) - tripStartMs(b));
}

/**
 * Missing operational inputs. `severity` is critical/warn/info so the OCC can
 * rank items while the detailed board can group them.
 */
export function computeOutstanding(trip, state, now = Date.now()) {
  if (!trip?.info) return [];
  const info = trip.info;
  const s = state || {};
  const out = [];
  const isRevenue = info.legType === 'REVENUE';
  const start = tripStartMs(trip);
  const hours = start == null ? Infinity : (start - now) / 3600_000;
  const imminent = hours <= 4;
  const urgent = hours <= 1;
  const severity = (normal = 'warn') => (urgent ? 'critical' : normal);

  if (!s.tripSheetUrl) {
    out.push({ code: 'no-sheet', label: 'No trip sheet', severity: severity() });
  }
  if (!Array.isArray(s.dispatcherUids) || s.dispatcherUids.length === 0) {
    out.push({
      code: 'no-dispatch',
      label: 'No controller assigned',
      severity: imminent ? 'warn' : 'info',
    });
  }
  if (!String(info.pic || '').trim()) {
    out.push({ code: 'no-pic', label: 'No PIC', severity: severity('warn') });
  }
  if (isRevenue && !String(info.sic || '').trim()) {
    out.push({ code: 'no-sic', label: 'No SIC', severity: imminent ? 'warn' : 'info' });
  }

  if (isRevenue) {
    const brokerEmail = String(s.brokerEmail || info.broker || '').trim();
    if (!brokerEmail) out.push({ code: 'no-broker', label: 'No broker email', severity: severity() });

    const expectedPax = Number(info.pax || 0);
    const parsedPax = Array.isArray(s.passengers) ? s.passengers.length : 0;
    const override = typeof s.paxOverride === 'number' ? s.paxOverride : null;
    if (expectedPax > 0 && parsedPax === 0 && override == null) {
      out.push({
        code: 'no-pax',
        label: `${expectedPax} pax not parsed`,
        severity: severity(),
      });
    }
    if (imminent && !String(s.fromFbo || '').trim()) {
      out.push({ code: 'no-origin-fbo', label: 'Origin FBO missing', severity: 'warn' });
    }
    if (imminent && !String(s.toFbo || '').trim()) {
      out.push({ code: 'no-destination-fbo', label: 'Destination FBO missing', severity: 'warn' });
    }
  }

  if (s.opsDisposition === 'hold') {
    out.unshift({
      code: 'ops-hold',
      label: s.opsDispositionReason ? `HOLD: ${s.opsDispositionReason}` : 'Operational hold',
      severity: 'critical',
    });
  }
  out.push(...fboCallOutstanding(trip, s, now));
  return out;
}

export function readinessProgress(trip, state) {
  const isRevenue = trip?.info?.legType === 'REVENUE';
  const hasCatering = state?.hasCatering !== false;
  const steps = OPS_STATUS_STEPS.filter((step) => (
    (!step.revenueOnly || isRevenue) && (!step.cateringOnly || hasCatering)
  ));
  const done = steps.filter((step) => Boolean(state?.statuses?.[step.id])).length;
  return {
    done,
    total: steps.length,
    percent: steps.length ? Math.round((done / steps.length) * 100) : 0,
    next: steps.find((step) => !state?.statuses?.[step.id]) || null,
  };
}

export function readinessLevel(items) {
  if (items.some((item) => item.severity === 'critical')) return 'critical';
  if (items.some((item) => item.severity === 'warn')) return 'warning';
  if (items.length) return 'info';
  return 'ready';
}
