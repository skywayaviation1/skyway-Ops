// src/aog-utils.js
//
// Shared AOG coverage utilities used by both the client tab and the
// server endpoints. Kept here (not in the API bundle) so the same
// classification logic runs on the browser preview AND the server
// recompute — impossible for them to drift.

// Aircraft classification for AOG coverage. Tails not in this map are
// NOT eligible for AOG coverage at all and the UI should reject them.
export const AOG_TAIL_CLASS = {
  N444AM: 'CJ3',
  N525CR: 'CJ3',
  N286N:  'CJ3',
  N168ZZ: 'LR60',
};

export const AOG_COVERAGE_RATES = {
  CJ3:  0.0125, // 1.25%
  LR60: 0.015,  // 1.5%
};

export const DEFAULT_FET_RATE = 0.075; // 7.5% federal excise tax

export const AOG_ELIGIBLE_TAILS = Object.keys(AOG_TAIL_CLASS);

export function classifyTail(tail) {
  const t = String(tail || '').toUpperCase().trim();
  return AOG_TAIL_CLASS[t] || null;
}

export function isEligibleTail(tail) {
  return classifyTail(tail) !== null;
}

// Compute coverage cost. Inputs are dollars (numbers or number-parseable
// strings). Returns { class, rate, tripTotal, fetAmount, netAmount,
// coverageCost, eligible, error }.
//
// - tripTotal: gross invoice total (includes FET)
// - fetAmount: optional; if omitted, computed as tripTotal * (fetRate / (1 + fetRate))
//              (i.e. FET as a portion of the gross)
// - fetRate: default 0.075
export function computeCoverage({ tail, tripTotal, fetAmount, fetRate = DEFAULT_FET_RATE }) {
  const cls = classifyTail(tail);
  if (!cls) {
    return { eligible: false, error: `${tail} is not covered under the AOG policy` };
  }
  const total = Number(tripTotal);
  if (!Number.isFinite(total) || total <= 0) {
    return { eligible: false, error: 'Trip total is required' };
  }
  let fet = Number(fetAmount);
  if (!Number.isFinite(fet) || fet < 0) {
    // Auto-compute — FET as portion of gross: gross × (rate / (1 + rate))
    fet = total * (fetRate / (1 + fetRate));
  }
  if (fet > total) {
    return { eligible: false, error: 'FET amount cannot exceed trip total' };
  }
  const net = total - fet;
  const rate = AOG_COVERAGE_RATES[cls];
  const coverageCost = net * rate;
  return {
    eligible: true,
    class: cls,
    rate,
    tripTotal: total,
    fetAmount: fet,
    netAmount: net,
    coverageCost,
  };
}

export function fmtCurrency(n) {
  if (!Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n));
}

export function fmtPct(n) {
  return `${(Number(n) * 100).toFixed(2)}%`;
}
