/**
 * Flight Risk Assessment Tool (FRAT) — pure scoring.
 *
 * Accumulates weighted risk points from everything the ops platform already
 * knows about a leg: schedule, weather, NOTAMs, aircraft airworthiness,
 * crew currency/legality, and ops readiness. Manual IMSAFE / go-items add
 * points when the pilot marks them adverse, and block a "signed" FRAT
 * until every required item is answered.
 *
 * This is an operational decision aid, not a regulatory release.
 */

export const FRAT_VERSION = 1;

/** Point thresholds → display level. */
export const FRAT_LEVELS = Object.freeze([
  { id: 'low', label: 'LOW', max: 15, tone: 'green' },
  { id: 'moderate', label: 'MODERATE', max: 30, tone: 'amber' },
  { id: 'high', label: 'HIGH', max: 50, tone: 'orange' },
  { id: 'severe', label: 'SEVERE', max: Infinity, tone: 'red' },
]);

export function fratLevelForScore(score) {
  const n = Math.max(0, Number(score) || 0);
  for (const level of FRAT_LEVELS) {
    if (n <= level.max) return level;
  }
  return FRAT_LEVELS[FRAT_LEVELS.length - 1];
}

/** Manual checklist shown to PIC/SIC before signing the FRAT. */
export const FRAT_CHECKLIST = Object.freeze([
  { id: 'illness', label: 'Illness / injury', group: 'IMSAFE', adversePoints: 15, required: true },
  { id: 'medication', label: 'Medication / drugs', group: 'IMSAFE', adversePoints: 20, required: true },
  { id: 'stress', label: 'Stress', group: 'IMSAFE', adversePoints: 10, required: true },
  { id: 'alcohol', label: 'Alcohol (within 8+ hours)', group: 'IMSAFE', adversePoints: 40, required: true },
  { id: 'fatigue', label: 'Fatigue', group: 'IMSAFE', adversePoints: 15, required: true },
  { id: 'emotion', label: 'Emotion / distraction', group: 'IMSAFE', adversePoints: 10, required: true },
  { id: 'wx_brief', label: 'Weather briefing reviewed', group: 'GO', adversePoints: 8, required: true, invert: true },
  { id: 'notams', label: 'NOTAMs reviewed', group: 'GO', adversePoints: 6, required: true, invert: true },
  { id: 'performance', label: 'Performance / W&B reviewed', group: 'GO', adversePoints: 10, required: true, invert: true },
  { id: 'mel_review', label: 'MEL / squawks reviewed', group: 'GO', adversePoints: 8, required: true, invert: true },
  { id: 'comfortable', label: 'I am comfortable accepting this flight', group: 'GO', adversePoints: 25, required: true, invert: true },
]);

function pushFactor(factors, {
  id, category, label, points, detail, severity = 'info', blocker = false,
}) {
  if (!points && !blocker && severity === 'info') return;
  factors.push({
    id,
    category,
    label,
    points: Number(points) || 0,
    detail: detail || null,
    severity,
    blocker: Boolean(blocker),
  });
}

function isUsDomesticAirport(code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return true;
  // Rough heuristic: K… CONUS ICAO, or 3-letter US codes.
  if (/^[A-Z0-9]{3}$/.test(c)) return true;
  if (c.startsWith('K') && c.length === 4) return true;
  return false;
}

function hourUtc(isoOrDate) {
  try {
    const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (Number.isNaN(d.getTime())) return null;
    return d.getUTCHours();
  } catch {
    return null;
  }
}

/** Late-night / early-morning window in UTC as a conservative proxy. */
function isCircadianWindow(isoOrDate) {
  const h = hourUtc(isoOrDate);
  if (h == null) return false;
  return h >= 22 || h < 5;
}

function categoryPoints(cat) {
  switch (String(cat || '').toUpperCase()) {
    case 'LIFR': return { points: 25, severity: 'critical' };
    case 'IFR': return { points: 15, severity: 'warn' };
    case 'MVFR': return { points: 5, severity: 'info' };
    default: return { points: 0, severity: 'info' };
  }
}

function scoreAirportWeather(factors, side, wx) {
  if (!wx?.ok && !wx?.metar && !wx?.parsed) {
    pushFactor(factors, {
      id: `wx-missing-${side}`,
      category: 'Weather',
      label: `${side} weather unavailable`,
      points: 4,
      detail: 'Could not load METAR — treat as unknown risk',
      severity: 'warn',
    });
    return;
  }
  const metar = wx.metar || wx.parsed || {};
  const cat = metar.flightCategory || wx.parsed?.flightCategory;
  const scored = categoryPoints(cat);
  if (scored.points) {
    pushFactor(factors, {
      id: `wx-cat-${side}`,
      category: 'Weather',
      label: `${side} METAR ${cat}`,
      points: scored.points,
      detail: metar.rawMetar || null,
      severity: scored.severity,
    });
  }
  const ceiling = metar.ceilingFt;
  if (ceiling != null && ceiling < 500) {
    pushFactor(factors, {
      id: `wx-ceil-${side}`,
      category: 'Weather',
      label: `${side} ceiling ${ceiling} ft`,
      points: 15,
      severity: 'critical',
    });
  } else if (ceiling != null && ceiling < 1000) {
    pushFactor(factors, {
      id: `wx-ceil-${side}`,
      category: 'Weather',
      label: `${side} ceiling ${ceiling} ft`,
      points: 8,
      severity: 'warn',
    });
  }
  const vis = metar.visibilitySm;
  if (vis != null && vis < 1) {
    pushFactor(factors, {
      id: `wx-vis-${side}`,
      category: 'Weather',
      label: `${side} visibility ${vis} SM`,
      points: 15,
      severity: 'critical',
    });
  } else if (vis != null && vis < 3) {
    pushFactor(factors, {
      id: `wx-vis-${side}`,
      category: 'Weather',
      label: `${side} visibility ${vis} SM`,
      points: 8,
      severity: 'warn',
    });
  }
  const gust = metar.windGustKt;
  const wind = metar.windKt;
  if (gust != null && gust >= 35) {
    pushFactor(factors, {
      id: `wx-gust-${side}`,
      category: 'Weather',
      label: `${side} gusts ${gust} kt`,
      points: 12,
      severity: 'warn',
    });
  } else if (gust != null && gust >= 25) {
    pushFactor(factors, {
      id: `wx-gust-${side}`,
      category: 'Weather',
      label: `${side} gusts ${gust} kt`,
      points: 6,
      severity: 'info',
    });
  } else if (wind != null && wind >= 25) {
    pushFactor(factors, {
      id: `wx-wind-${side}`,
      category: 'Weather',
      label: `${side} wind ${wind} kt`,
      points: 4,
      severity: 'info',
    });
  }

  // TAF periods overlapping ETD window (±2h) — use worst category.
  const periods = wx.taf?.periods || wx.parsed?.tafPeriods || [];
  let worstTaf = null;
  let worstPts = 0;
  for (const p of periods) {
    const { points } = categoryPoints(p.flightCategory);
    if (points > worstPts) {
      worstPts = points;
      worstTaf = p.flightCategory;
    }
  }
  if (worstPts >= 15) {
    pushFactor(factors, {
      id: `wx-taf-${side}`,
      category: 'Weather',
      label: `${side} TAF ${worstTaf}`,
      points: Math.round(worstPts * 0.6),
      detail: 'Forecast period indicates reduced conditions',
      severity: worstPts >= 25 ? 'critical' : 'warn',
    });
  }
}

function scoreNotams(factors, side, notams) {
  const significant = notams?.significantOnly
    || (Array.isArray(notams?.notams) ? notams.notams.filter((n) => n.severity === 'high' || n.severity === 'medium') : []);
  if (!Array.isArray(significant) || !significant.length) return;
  const high = significant.filter((n) => n.severity === 'high').length;
  const medium = significant.filter((n) => n.severity === 'medium').length;
  if (high > 0) {
    pushFactor(factors, {
      id: `notam-high-${side}`,
      category: 'NOTAM',
      label: `${side}: ${high} high-severity NOTAM${high === 1 ? '' : 's'}`,
      points: Math.min(24, high * 10),
      severity: 'critical',
    });
  }
  if (medium > 0) {
    pushFactor(factors, {
      id: `notam-med-${side}`,
      category: 'NOTAM',
      label: `${side}: ${medium} medium NOTAM${medium === 1 ? '' : 's'}`,
      points: Math.min(12, medium * 3),
      severity: 'warn',
    });
  }
}

function scoreAircraft(factors, aircraftStatus, squawkSummary) {
  const status = aircraftStatus?.status || 'UNKNOWN';
  if (status === 'AOG') {
    pushFactor(factors, {
      id: 'ac-aog',
      category: 'Aircraft',
      label: 'Aircraft AOG / grounded',
      points: 40,
      detail: (aircraftStatus.reasons || []).slice(0, 2).join('; ') || null,
      severity: 'critical',
      blocker: true,
    });
  } else if (status === 'RESTRICTED') {
    pushFactor(factors, {
      id: 'ac-restricted',
      category: 'Aircraft',
      label: `Aircraft restricted (${aircraftStatus.melOpen || 0} open MEL)`,
      points: 15,
      detail: (aircraftStatus.reasons || []).slice(0, 2).join('; ') || null,
      severity: 'warn',
    });
  }
  const grounding = squawkSummary?.grounding || 0;
  const open = squawkSummary?.openSquawks || 0;
  if (grounding > 0 && status !== 'AOG') {
    pushFactor(factors, {
      id: 'ac-ground-squawk',
      category: 'Aircraft',
      label: `${grounding} grounding squawk${grounding === 1 ? '' : 's'}`,
      points: 30,
      severity: 'critical',
      blocker: true,
    });
  } else if (open > 0) {
    pushFactor(factors, {
      id: 'ac-squawk',
      category: 'Aircraft',
      label: `${open} open squawk${open === 1 ? '' : 's'}`,
      points: Math.min(18, open * 6),
      severity: 'warn',
    });
  }
}

function scoreCrewMember(factors, role, crew) {
  if (!crew?.name && !crew?.resolved) {
    pushFactor(factors, {
      id: `crew-missing-${role}`,
      category: 'Crew',
      label: `No ${role} assigned`,
      points: role === 'PIC' ? 20 : 10,
      severity: role === 'PIC' ? 'critical' : 'warn',
      blocker: role === 'PIC',
    });
    return;
  }
  if (crew.name && !crew.resolved) {
    pushFactor(factors, {
      id: `crew-unresolved-${role}`,
      category: 'Crew',
      label: `${role} not matched to a user profile`,
      points: 4,
      detail: crew.name,
      severity: 'info',
    });
  }
  const legality = crew.legality;
  if (legality?.status === 'illegal') {
    pushFactor(factors, {
      id: `crew-illegal-${role}`,
      category: 'Crew',
      label: `${role} duty status illegal`,
      points: 30,
      detail: (legality.blockers || []).map((b) => b.message || b.label || b.code || b).slice(0, 2).join('; ') || null,
      severity: 'critical',
      blocker: true,
    });
  } else if (legality?.status === 'warning') {
    pushFactor(factors, {
      id: `crew-warn-${role}`,
      category: 'Crew',
      label: `${role} duty caution`,
      points: 10,
      detail: (legality.warnings || []).map((w) => w.message || w.label || w.code || w).slice(0, 2).join('; ') || null,
      severity: 'warn',
    });
  }
  const currency = crew.currency;
  if (currency?.expiredCount > 0 || currency?.status === 'expired') {
    pushFactor(factors, {
      id: `crew-currency-exp-${role}`,
      category: 'Crew',
      label: `${role} currency expired`,
      points: 25,
      detail: `${currency.expiredCount || 1} item(s)`,
      severity: 'critical',
      blocker: true,
    });
  } else if (currency?.warningCount > 0 || ['warning', 'critical'].includes(currency?.status)) {
    pushFactor(factors, {
      id: `crew-currency-warn-${role}`,
      category: 'Crew',
      label: `${role} currency warning`,
      points: 8,
      severity: 'warn',
    });
  }
  if (crew.fitForDuty === false) {
    pushFactor(factors, {
      id: `crew-fit-${role}`,
      category: 'Crew',
      label: `${role} marked not fit for duty`,
      points: 25,
      severity: 'critical',
      blocker: true,
    });
  }
}

function scoreOps(factors, trip, tripState, outstanding) {
  const info = trip?.info || {};
  const category = String(info.category || '').toUpperCase();
  const legType = String(info.legType || '').toUpperCase();

  if (tripState?.opsDisposition === 'hold') {
    pushFactor(factors, {
      id: 'ops-hold',
      category: 'Operations',
      label: 'Ops disposition: HOLD',
      points: 20,
      detail: tripState.opsDispositionReason || null,
      severity: 'critical',
      blocker: true,
    });
  }

  for (const gap of outstanding || []) {
    const pts = gap.severity === 'critical' ? 8 : gap.severity === 'warn' ? 4 : 2;
    pushFactor(factors, {
      id: `ops-${gap.code}`,
      category: 'Operations',
      label: gap.label || gap.code,
      points: pts,
      severity: gap.severity === 'critical' ? 'warn' : 'info',
    });
  }

  if (legType === 'REVENUE' && Number(info.pax || 0) >= 6) {
    pushFactor(factors, {
      id: 'ops-pax-high',
      category: 'Operations',
      label: `${info.pax} passengers`,
      points: 3,
      severity: 'info',
    });
  }

  if (!isUsDomesticAirport(info.from) || !isUsDomesticAirport(info.to)) {
    pushFactor(factors, {
      id: 'ops-intl',
      category: 'Operations',
      label: 'International / non-CONUS airport',
      points: 6,
      detail: `${info.from || '?'} → ${info.to || '?'}`,
      severity: 'info',
    });
  }

  if (isCircadianWindow(trip?.start)) {
    pushFactor(factors, {
      id: 'ops-circadian',
      category: 'Operations',
      label: 'Departure in circadian low window (UTC 22–05)',
      points: 8,
      severity: 'warn',
    });
  }

  if (category === 'REPO' || category === 'FERRY') {
    pushFactor(factors, {
      id: 'ops-repo',
      category: 'Operations',
      label: `${category} leg`,
      points: 2,
      severity: 'info',
    });
  }

  // Long block day: scheduled block > 3 hours.
  try {
    const start = trip?.start instanceof Date ? trip.start.getTime() : new Date(trip?.start).getTime();
    const end = trip?.end instanceof Date ? trip.end.getTime() : new Date(trip?.end).getTime();
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const hours = (end - start) / 3600_000;
      if (hours >= 4) {
        pushFactor(factors, {
          id: 'ops-long-block',
          category: 'Operations',
          label: `Scheduled block ~${hours.toFixed(1)} h`,
          points: hours >= 6 ? 10 : 5,
          severity: hours >= 6 ? 'warn' : 'info',
        });
      }
    }
  } catch {
    /* ignore */
  }

  if (trip?.sameDayLegCount >= 3) {
    pushFactor(factors, {
      id: 'ops-multi-leg',
      category: 'Operations',
      label: `${trip.sameDayLegCount} legs same day on this tail`,
      points: 6,
      severity: 'info',
    });
  }
}

function scoreChecklist(factors, answers) {
  const map = answers && typeof answers === 'object' ? answers : {};
  for (const item of FRAT_CHECKLIST) {
    const raw = map[item.id];
    if (raw == null) continue;
    // invert: true means "yes I reviewed" is good; adverse when false/no
    const adverse = item.invert ? raw === false || raw === 'no' : raw === true || raw === 'yes';
    if (adverse) {
      pushFactor(factors, {
        id: `check-${item.id}`,
        category: item.group === 'IMSAFE' ? 'Human factors' : 'Checklist',
        label: item.label,
        points: item.adversePoints,
        severity: item.adversePoints >= 20 ? 'critical' : 'warn',
        blocker: item.adversePoints >= 40,
      });
    }
  }
}

/**
 * Compute a FRAT result from gathered inputs.
 *
 * @param {object} input
 * @param {object} input.trip — { start, end, info, sameDayLegCount? }
 * @param {object} [input.tripState]
 * @param {object} [input.originWx] — airport-weather API payload
 * @param {object} [input.destWx]
 * @param {object} [input.originNotams] — faa-notams API payload
 * @param {object} [input.destNotams]
 * @param {object} [input.aircraftStatus] — deriveAircraftStatus result
 * @param {object} [input.squawkSummary] — { grounding, openSquawks, melCount }
 * @param {object} [input.pic] — { name, resolved, legality, currency, fitForDuty }
 * @param {object} [input.sic]
 * @param {array}  [input.outstanding] — computeOutstanding()
 * @param {object} [input.checklist] — { [itemId]: true|false|'yes'|'no' }
 */
export function computeFrat(input = {}) {
  const factors = [];
  const trip = input.trip || {};
  const info = trip.info || {};

  scoreAirportWeather(factors, 'Departure', input.originWx);
  scoreAirportWeather(factors, 'Arrival', input.destWx);
  scoreNotams(factors, info.from || 'DEP', input.originNotams);
  scoreNotams(factors, info.to || 'ARR', input.destNotams);
  scoreAircraft(factors, input.aircraftStatus, input.squawkSummary);
  scoreCrewMember(factors, 'PIC', input.pic || { name: info.pic });
  if (String(info.legType || '').toUpperCase() === 'REVENUE' || info.sic) {
    scoreCrewMember(factors, 'SIC', input.sic || { name: info.sic });
  }
  scoreOps(factors, trip, input.tripState, input.outstanding);
  scoreChecklist(factors, input.checklist);

  const score = factors.reduce((sum, f) => sum + (Number(f.points) || 0), 0);
  const level = fratLevelForScore(score);
  const blockers = factors.filter((f) => f.blocker);
  const unanswered = FRAT_CHECKLIST
    .filter((item) => item.required)
    .filter((item) => {
      const v = input.checklist?.[item.id];
      return v == null;
    })
    .map((item) => item.id);

  return {
    version: FRAT_VERSION,
    score,
    level: level.id,
    levelLabel: level.label,
    tone: level.tone,
    factors: factors.sort((a, b) => (b.points || 0) - (a.points || 0)),
    blockers,
    go: blockers.length === 0 && level.id !== 'severe' && unanswered.length === 0,
    unanswered,
    computedAt: Date.now(),
  };
}

/** Compact public summary safe to store / show in lists. */
export function fratSummary(result) {
  if (!result) return null;
  return {
    version: result.version || FRAT_VERSION,
    score: result.score,
    level: result.level,
    levelLabel: result.levelLabel,
    tone: result.tone,
    go: result.go,
    topFactors: (result.factors || []).slice(0, 5).map((f) => ({
      id: f.id,
      label: f.label,
      points: f.points,
      category: f.category,
      severity: f.severity,
    })),
    blockerCount: (result.blockers || []).length,
    computedAt: result.computedAt || Date.now(),
  };
}
