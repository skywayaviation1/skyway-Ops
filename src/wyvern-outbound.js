// Future Wyvern hours push.
//
// Wyvern documents an FMS Update API that lets flight-management software
// push roster and hour updates, and a quarterly Excel vendor export. Neither
// is connected here: this app has no API documentation and no credentials.
// buildWyvernHoursPush only shapes the hours a later sync would send.
// wyvernOutboundStatus stays unwired until that client exists.

export const WYVERN_HOURS_SCHEMA = 'skyway-wyvern-hours-1';

function hourOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function buildWyvernHoursPush(logbook) {
  const hours = logbook?.hours || {};
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(logbook?.baseline?.asOf || '')
    ? logbook.baseline.asOf
    : /^\d{4}-\d{2}-\d{2}$/.test(logbook?.hoursMeta?.asOf || '')
      ? logbook.hoursMeta.asOf
      : '';
  return {
    schema: WYVERN_HOURS_SCHEMA,
    ready: false,
    pilotName: String(logbook?.pilotName || '').slice(0, 80),
    hoursAsOf: asOf,
    hours: {
      total: hourOrNull(hours.totalTime),
      pic: hourOrNull(hours.pic),
      sic: hourOrNull(hours.sic),
      fixedWing: hourOrNull(hours.fixedWing),
      rotorWing: hourOrNull(hours.rotorWing),
      singleEngine: hourOrNull(hours.singleEngine),
      multiEngine: hourOrNull(hours.multiEngine),
      multiEngine90: hourOrNull(hours.multiEngine90),
      multiEngine12: hourOrNull(hours.multiEngine12),
      turbine: hourOrNull(hours.turbine),
      instrument: hourOrNull(hours.instrument),
      last90Days: hourOrNull(hours.last90Days),
      last12Months: hourOrNull(hours.last12Months),
      byType: (Array.isArray(hours.timeInType) ? hours.timeInType : []).slice(0, 24).map((entry) => ({
        type: String(entry?.type || '').slice(0, 80),
        total: hourOrNull(entry?.hours),
        pic: hourOrNull(entry?.picHours),
      })).filter((entry) => entry.type),
    },
  };
}

export function wyvernOutboundStatus() {
  return {
    ready: false,
    fmsUpdateApi: {
      available: false,
      reason: 'No Wyvern FMS Update API credentials or documentation are configured.',
    },
    quarterlyExcelExport: {
      available: false,
      reason: 'The quarterly Excel vendor export is not connected.',
    },
  };
}
