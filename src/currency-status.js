/**
 * Pure pilot-currency date calculations.
 *
 * Part 135 uses a mix of exact-day windows (for example 90-day landing
 * recency), calendar-month windows (checks/training), explicit certificate
 * expiration dates, and grace months. Keeping this free of Firebase makes the
 * compliance math independently testable.
 */

export const STATUS_THRESHOLDS = Object.freeze({
  CRITICAL: 14,
  WARNING: 30,
  CAUTION: 60,
});

function bucketize(daysUntil) {
  if (daysUntil < 0) return 'expired';
  if (daysUntil <= STATUS_THRESHOLDS.CRITICAL) return 'critical';
  if (daysUntil <= STATUS_THRESHOLDS.WARNING) return 'warning';
  if (daysUntil <= STATUS_THRESHOLDS.CAUTION) return 'caution';
  return 'current';
}

function validDateMs(value) {
  if (!value) return null;
  const ms = new Date(`${value}T23:59:59.999Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function endOfUtcMonth(year, monthIndex) {
  return Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999);
}

function addCalendarMonthsEnd(dateString, months, graceMonths = 0) {
  const date = new Date(`${dateString}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return endOfUtcMonth(
    date.getUTCFullYear(),
    date.getUTCMonth() + Number(months || 0) + Number(graceMonths || 0),
  );
}

// Direct due dates win over computed intervals. Calendar-month requirements
// use month-end and any cited grace month; 90-day recency remains exact days.
export function computeStatus(item, intervalDays, todayMs = Date.now(), type = {}) {
  if (item?.notApplicable === true) {
    return { status: 'na', dueDate: null, daysUntil: null };
  }
  if (type.noExpiration || item?.noExpiration === true) {
    return item?.present === true
      ? { status: 'noExpiration', dueDate: null, daysUntil: null }
      : { status: 'unknown', dueDate: null, daysUntil: null };
  }

  const explicitDueMs = validDateMs(item?.graceDate || item?.dueDate);
  let effectiveDueMs = explicitDueMs;
  let baseDueDate = item?.dueDate || null;

  if (effectiveDueMs == null && item?.lastDate) {
    if (type.intervalMonths) {
      effectiveDueMs = addCalendarMonthsEnd(
        item.lastDate,
        type.intervalMonths,
        type.graceMonths,
      );
      const baseMs = addCalendarMonthsEnd(item.lastDate, type.intervalMonths, 0);
      baseDueDate = baseMs == null ? null : new Date(baseMs).toISOString().slice(0, 10);
    } else if (Number.isFinite(Number(intervalDays)) && Number(intervalDays) > 0) {
      const last = new Date(`${item.lastDate}T12:00:00Z`);
      if (Number.isFinite(last.getTime())) {
        effectiveDueMs = last.getTime() + Number(intervalDays) * 86400000;
        baseDueDate = new Date(effectiveDueMs).toISOString().slice(0, 10);
      }
    }
  }

  if (effectiveDueMs == null) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }

  const daysUntil = Math.floor((effectiveDueMs - todayMs) / 86400000);
  const effectiveDueDate = new Date(effectiveDueMs).toISOString().slice(0, 10);
  const displayedDueDate = baseDueDate || effectiveDueDate;
  return {
    status: bucketize(daysUntil),
    dueDate: displayedDueDate,
    effectiveDueDate,
    graceDate: effectiveDueDate !== displayedDueDate ? effectiveDueDate : null,
    baseDueDate,
    graceApplied: Boolean(item?.graceDate || type.graceMonths),
    daysUntil,
  };
}

// Medical uses the actual expiration printed/calculated for the certificate.
export function computeMedicalStatus(med, todayMs = Date.now()) {
  if (!med || !med.expirationDate) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }
  const due = new Date(`${med.expirationDate}T23:59:59.999Z`);
  if (!Number.isFinite(due.getTime())) {
    return { status: 'unknown', dueDate: null, daysUntil: null };
  }
  const daysUntil = Math.floor((due.getTime() - todayMs) / 86400000);
  return {
    status: bucketize(daysUntil),
    dueDate: med.expirationDate,
    daysUntil,
  };
}
