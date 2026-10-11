// The production "Requires attention" shapes Jake reported, as plain duty
// documents. Names and tails match that report so the admin page and the
// tests exercise the same finding labels. Nothing here is written on deploy.

const HOUR = 3600 * 1000;

function atEt(year, month, day, hour, minute = 0) {
  const utc = Date.UTC(year, month - 1, day, hour + 4, minute);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const map = {};
  for (const part of fmt.formatToParts(new Date(utc))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const rendered = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute));
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  return utc + (desired - rendered);
}

function base(partial) {
  return {
    status: 'off',
    confirmStatus: 'self-attested',
    fitForDuty: true,
    priorRestMs: 12 * HOUR,
    assignmentType: 'regular',
    crewType: 'single',
    location: 'KTEB',
    over14: false,
    flightTimeMs: 2 * HOUR,
    ...partial,
  };
}

export function attentionFixture(now = Date.now()) {
  const mattOn = atEt(2026, 10, 1, 8, 0);
  const matt = base({
    id: 'duty-matt-oct1',
    pilotUid: 'pilot-matt',
    pilotName: 'Matt St John',
    role: 'PIC',
    tail: 'N168ZZ',
    tripId: 'oct1-168',
    dutyOnAt: mattOn,
    dutyOffAt: atEt(2026, 10, 1, 18, 0),
    flightTimeMs: 9.3 * HOUR,
    crewType: 'single',
    partnerPeriodId: null,
  });
  const daniel = base({
    id: 'duty-daniel-oct1',
    pilotUid: 'pilot-daniel',
    pilotName: 'Daniel Gonzalez',
    role: 'SIC',
    tail: 'N168ZZ',
    tripId: 'oct1-168',
    dutyOnAt: mattOn,
    dutyOffAt: atEt(2026, 10, 1, 14, 0),
    flightTimeMs: 4 * HOUR,
    crewType: 'two',
    partnerPeriodId: matt.id,
  });
  const samLongOn = now - Math.round(455.3 * HOUR);
  const samLong = base({
    id: 'duty-sam-long',
    pilotUid: 'pilot-sam',
    pilotName: 'Sam Parker',
    role: 'SIC',
    tail: 'N444AM',
    tripId: 'sam-open-clock',
    dutyOnAt: samLongOn,
    dutyOffAt: null,
    status: 'off',
    confirmStatus: 'declined',
    declinedReason: 'Did not accept the paired duty',
    flightTimeMs: 1.2 * HOUR,
    fitForDuty: false,
    crewType: 'two',
  });
  const samA = base({
    id: 'duty-sam-sep28-a',
    pilotUid: 'pilot-sam',
    pilotName: 'Sam Parker',
    role: 'SIC',
    tail: 'N444AM',
    dutyOnAt: atEt(2026, 9, 28, 8, 0),
    dutyOffAt: atEt(2026, 9, 28, 16, 0),
    flightTimeMs: 3.5 * HOUR,
    crewType: 'two',
    partnerPeriodId: 'duty-sam-partner-missing',
  });
  const samB = base({
    id: 'duty-sam-sep28-b',
    pilotUid: 'pilot-sam',
    pilotName: 'Sam Parker',
    role: 'SIC',
    tail: 'N444AM',
    dutyOnAt: atEt(2026, 9, 28, 14, 0),
    dutyOffAt: atEt(2026, 9, 28, 20, 0),
    flightTimeMs: 2 * HOUR,
    crewType: 'two',
  });
  const samC = base({
    id: 'duty-sam-oct2-outer',
    pilotUid: 'pilot-sam',
    pilotName: 'Sam Parker',
    role: 'SIC',
    tail: 'N241CJ',
    dutyOnAt: atEt(2026, 10, 2, 9, 0),
    dutyOffAt: atEt(2026, 10, 2, 17, 0),
    flightTimeMs: 4 * HOUR,
    crewType: 'two',
  });
  const samD = base({
    id: 'duty-sam-oct2-inner',
    pilotUid: 'pilot-sam',
    pilotName: 'Sam Parker',
    role: 'SIC',
    tail: 'N241CJ',
    dutyOnAt: atEt(2026, 10, 2, 10, 0),
    dutyOffAt: atEt(2026, 10, 2, 15, 0),
    flightTimeMs: 4 * HOUR,
    crewType: 'two',
  });
  return [matt, daniel, samLong, samA, samB, samC, samD];
}
