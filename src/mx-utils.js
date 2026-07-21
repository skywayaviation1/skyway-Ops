// mx-utils.js - Projection math + helpers for MX Projections
// Client-safe module (no server-only imports)

export const CATEGORY_STYLES = {
  'INSPECTION': { badge: 'bg-blue-100 text-blue-800', label: 'INSP' },
  'INSPECTION - Life Limited': { badge: 'bg-purple-100 text-purple-800', label: 'INSP-LL' },
  'AD - Recurring': { badge: 'bg-red-100 text-red-800', label: 'AD' },
  'AD - Open': { badge: 'bg-red-200 text-red-900', label: 'AD OPEN' },
  'PART - Life Limited': { badge: 'bg-purple-100 text-purple-800', label: 'LIFE LTD' },
  'PART - Overhaul': { badge: 'bg-amber-100 text-amber-800', label: 'OVERHAUL' },
  'PART - Expiration': { badge: 'bg-orange-100 text-orange-800', label: 'EXP' },
  'PART': { badge: 'bg-gray-100 text-gray-800', label: 'PART' },
  'SB - Recurring': { badge: 'bg-cyan-100 text-cyan-800', label: 'SB' },
  'SB - Open': { badge: 'bg-cyan-200 text-cyan-900', label: 'SB OPEN' },
  'MAINTENANCE': { badge: 'bg-slate-100 text-slate-800', label: 'MX' },
};

const MS_PER_DAY = 86400000;
const DAYS_PER_MONTH = 30.44;

// Compute projected due date for an item based on remaining hours/days/landings.
// Takes the SOONEST (tightest) constraint across calendar, hours, and landings.
export function computeProjection(item, tailSettings, referenceDate = new Date()) {
  if (!item || !item.remaining) return null;
  const now = referenceDate.getTime();
  const avgHoursPerMonth = tailSettings?.avgHoursPerMonth;
  const avgLandingsPerMonth = tailSettings?.avgLandingsPerMonth;

  const constraints = [];

  // Calendar constraint (months + days)
  const remMonths = item.remaining.months;
  const remDays = item.remaining.days;
  if (remMonths != null || remDays != null) {
    const totalDays = (remMonths ?? 0) * DAYS_PER_MONTH + (remDays ?? 0);
    constraints.push({
      dueMs: now + totalDays * MS_PER_DAY,
      source: 'calendar',
    });
  }

  // Hours constraint
  if (item.remaining.hours != null && avgHoursPerMonth && avgHoursPerMonth > 0) {
    const monthsToConsume = item.remaining.hours / avgHoursPerMonth;
    constraints.push({
      dueMs: now + monthsToConsume * DAYS_PER_MONTH * MS_PER_DAY,
      source: 'hours',
    });
  }

  // Landings constraint
  if (item.remaining.landings != null && avgLandingsPerMonth && avgLandingsPerMonth > 0) {
    const monthsToConsume = item.remaining.landings / avgLandingsPerMonth;
    constraints.push({
      dueMs: now + monthsToConsume * DAYS_PER_MONTH * MS_PER_DAY,
      source: 'landings',
    });
  }

  if (constraints.length === 0) return null;

  // Take the earliest (tightest) constraint
  constraints.sort((a, b) => a.dueMs - b.dueMs);
  const tightest = constraints[0];
  const daysUntilDue = Math.round((tightest.dueMs - now) / MS_PER_DAY);

  return {
    dueMs: tightest.dueMs,
    dueDate: new Date(tightest.dueMs),
    source: tightest.source,
    daysUntilDue,
    allConstraints: constraints,
  };
}

// Urgency band for badge display
export function projectionBadge(daysUntilDue) {
  if (daysUntilDue == null) return { color: 'bg-gray-200 text-gray-700', label: '—', level: 0 };
  if (daysUntilDue < 0) return { color: 'bg-red-600 text-white', label: 'OVERDUE', level: 5 };
  if (daysUntilDue < 30) return { color: 'bg-red-500 text-white', label: `${daysUntilDue}d`, level: 4 };
  if (daysUntilDue < 90) return { color: 'bg-orange-500 text-white', label: `${daysUntilDue}d`, level: 3 };
  if (daysUntilDue < 180) return { color: 'bg-yellow-400 text-yellow-900', label: `${daysUntilDue}d`, level: 2 };
  if (daysUntilDue < 365) return { color: 'bg-blue-400 text-white', label: `${daysUntilDue}d`, level: 1 };
  return { color: 'bg-green-400 text-green-900', label: `${daysUntilDue}d`, level: 0 };
}

export function fmtProjectedDate(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Try common flight-hour field names on trip records
function extractFlightHours(trip) {
  const candidates = [
    trip.totalFlightHours,
    trip.flightHours,
    trip.blockHours,
    trip.actualFlightTime,
    trip.totalBlockTime,
    trip.flightTime,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && v > 0) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  // Try legs array
  if (Array.isArray(trip.legs)) {
    let total = 0;
    for (const leg of trip.legs) {
      const lh = leg.flightHours ?? leg.blockHours ?? leg.actualTime ?? leg.blockTime;
      if (typeof lh === 'number' && lh > 0) total += lh;
      else if (typeof lh === 'string') {
        const n = parseFloat(lh);
        if (!isNaN(n) && n > 0) total += n;
      }
    }
    if (total > 0) return total;
  }
  return null;
}

function extractTripTail(trip) {
  return trip.tail || trip.aircraft || trip.tailNumber || trip.aircraftTail || null;
}

function extractTripDate(trip) {
  const raw = trip.completedAt || trip.endTime || trip.startTime || trip.date ||
              trip.tripDate || trip.departureTime;
  if (!raw) return null;
  const ms = raw instanceof Date ? raw.getTime() :
             typeof raw === 'string' ? new Date(raw).getTime() :
             typeof raw === 'number' ? raw :
             raw?.toMillis?.() ?? raw?.seconds ? raw.seconds * 1000 : null;
  return ms && !isNaN(ms) ? ms : null;
}

// Compute avg flight hours/month for a tail from trip history
export function computeAvgHoursFromTrips(trips, tail, lookbackDays = 90) {
  if (!Array.isArray(trips) || trips.length === 0) return null;
  const now = Date.now();
  const cutoff = now - lookbackDays * MS_PER_DAY;

  let totalHours = 0;
  let matched = 0;

  for (const trip of trips) {
    const tripTail = extractTripTail(trip);
    if (tripTail !== tail) continue;
    const tripMs = extractTripDate(trip);
    if (!tripMs || tripMs < cutoff || tripMs > now) continue;
    const hours = extractFlightHours(trip);
    if (hours != null) {
      totalHours += hours;
      matched++;
    }
  }

  if (matched === 0) return null;
  const months = lookbackDays / DAYS_PER_MONTH;
  return Math.round((totalHours / months) * 10) / 10;
}

// Compute avg landings/month from trip legs
export function computeAvgLandingsFromTrips(trips, tail, lookbackDays = 90) {
  if (!Array.isArray(trips) || trips.length === 0) return null;
  const now = Date.now();
  const cutoff = now - lookbackDays * MS_PER_DAY;

  let totalLegs = 0;
  let matched = 0;

  for (const trip of trips) {
    const tripTail = extractTripTail(trip);
    if (tripTail !== tail) continue;
    const tripMs = extractTripDate(trip);
    if (!tripMs || tripMs < cutoff || tripMs > now) continue;
    const legs = Array.isArray(trip.legs) ? trip.legs.length : 1;
    totalLegs += legs;
    matched++;
  }

  if (matched === 0) return null;
  const months = lookbackDays / DAYS_PER_MONTH;
  return Math.round((totalLegs / months) * 10) / 10;
}

// Sort items by projected due date (soonest first, unknown last)
export function sortByProjection(items) {
  return [...items].sort((a, b) => {
    if (!a.projection && !b.projection) return 0;
    if (!a.projection) return 1;
    if (!b.projection) return -1;
    return a.projection.dueMs - b.projection.dueMs;
  });
}

// Display "Remaining" column compactly
export function formatRemaining(rem) {
  if (!rem) return '—';
  const parts = [];
  if (rem.months != null && rem.months !== 0) parts.push(`${rem.months}mo`);
  if (rem.days != null && rem.days !== 0) parts.push(`${rem.days}d`);
  if (rem.hours != null) parts.push(`${Number(rem.hours).toFixed(1)}h`);
  if (rem.landings != null) parts.push(`${rem.landings}L`);
  if (parts.length === 0 && (rem.months === 0 || rem.days === 0)) {
    // Handle "0mo 22d" case where months=0 was skipped above
    const arr = [];
    if (rem.months != null) arr.push(`${rem.months}mo`);
    if (rem.days != null) arr.push(`${rem.days}d`);
    return arr.join(' ') || '—';
  }
  return parts.join(' / ') || '—';
}
