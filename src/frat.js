/**
 * Flight Risk Assessment Tool (FRAT) — pure scoring.
 *
 * Accumulates weighted risk points from everything the ops platform already
 * knows about a leg: schedule, weather, NOTAMs, aircraft airworthiness,
 * crew currency/legality, and ops readiness. Manual IMSAFE / go-items add
 * points when the pilot marks them adverse, and block a "signed" FRAT
 * until every required item is answered.
 *
 * Every weight, threshold, and blocker flag is configurable so a flight
 * department can tune the model to its own ops manual. Defaults below are the
 * starting point; `app-config/frat` overrides them.
 *
 * This is an operational decision aid, not a regulatory release.
 */

export const FRAT_VERSION = 2;

/**
 * Individual automatic signals an administrator can include or exclude.
 * These are separate from category-wide switches: a department can, for
 * example, score IFR/MVFR but ignore the generic "weather unavailable" item.
 */
export const FRAT_FACTOR_OPTIONS = Object.freeze([
  { id: 'weatherMissing', group: 'weather', label: 'Weather unavailable' },
  { id: 'weatherCategory', group: 'weather', label: 'METAR flight category' },
  { id: 'weatherCeiling', group: 'weather', label: 'Ceiling thresholds' },
  { id: 'weatherVisibility', group: 'weather', label: 'Visibility thresholds' },
  { id: 'weatherGust', group: 'weather', label: 'Wind gust thresholds' },
  { id: 'weatherWind', group: 'weather', label: 'Sustained wind threshold' },
  { id: 'weatherTaf', group: 'weather', label: 'TAF forecast category' },
  { id: 'notamHigh', group: 'notam', label: 'High-severity NOTAMs' },
  { id: 'notamMedium', group: 'notam', label: 'Medium-severity NOTAMs' },
  { id: 'aircraftAog', group: 'aircraft', label: 'Aircraft AOG / grounded' },
  { id: 'aircraftRestricted', group: 'aircraft', label: 'Open MEL / restricted' },
  { id: 'aircraftGroundingSquawk', group: 'aircraft', label: 'Grounding squawk' },
  { id: 'aircraftOpenSquawk', group: 'aircraft', label: 'Open non-grounding squawk' },
  { id: 'crewMissingPic', group: 'crew', label: 'PIC not assigned' },
  { id: 'crewMissingSic', group: 'crew', label: 'SIC not assigned' },
  { id: 'crewUnresolved', group: 'crew', label: 'Crew not matched to profile' },
  { id: 'crewDutyIllegal', group: 'crew', label: 'Duty legality blocker' },
  { id: 'crewDutyWarning', group: 'crew', label: 'Duty legality warning' },
  { id: 'crewCurrencyExpired', group: 'crew', label: 'Expired pilot currency' },
  { id: 'crewCurrencyWarning', group: 'crew', label: 'Pilot currency warning' },
  { id: 'crewNotFit', group: 'crew', label: 'Not fit for duty' },
  { id: 'opsHold', group: 'ops', label: 'Ops HOLD disposition' },
  { id: 'opsReadiness', group: 'ops', label: 'Operational readiness gaps' },
  { id: 'opsPax', group: 'ops', label: 'High passenger count' },
  { id: 'opsInternational', group: 'ops', label: 'International / non-CONUS leg' },
  { id: 'opsCircadian', group: 'ops', label: 'Circadian low departure' },
  { id: 'opsRepo', group: 'ops', label: 'Repo / ferry leg' },
  { id: 'opsLongBlock', group: 'ops', label: 'Long scheduled block' },
  { id: 'opsMultiLeg', group: 'ops', label: 'Multi-leg duty day' },
]);

/**
 * Default scoring model. Every number here is adjustable in
 * Settings → FRAT scoring. Thresholds are inclusive-at-or-worse.
 */
export const DEFAULT_FRAT_CONFIG = Object.freeze({
  version: FRAT_VERSION,
  levels: { low: 15, moderate: 30, high: 50 },
  severeIsNoGo: true,
  factors: Object.fromEntries(FRAT_FACTOR_OPTIONS.map((factor) => [factor.id, true])),
  weather: {
    enabled: true,
    missingPoints: 4,
    categoryPoints: { LIFR: 25, IFR: 15, MVFR: 5 },
    ceilingLowFt: 500,
    ceilingLowPoints: 15,
    ceilingMedFt: 1000,
    ceilingMedPoints: 8,
    visLowSm: 1,
    visLowPoints: 15,
    visMedSm: 3,
    visMedPoints: 8,
    gustHighKt: 35,
    gustHighPoints: 12,
    gustMedKt: 25,
    gustMedPoints: 6,
    windHighKt: 25,
    windHighPoints: 4,
    tafFactor: 0.6,
  },
  notam: {
    enabled: true,
    highEach: 10,
    highMax: 24,
    mediumEach: 3,
    mediumMax: 12,
  },
  aircraft: {
    enabled: true,
    aogPoints: 40,
    aogBlocks: true,
    restrictedPoints: 15,
    restrictedBlocks: false,
    groundingSquawkPoints: 30,
    groundingSquawkBlocks: true,
    openSquawkEach: 6,
    openSquawkMax: 18,
  },
  crew: {
    enabled: true,
    missingPicPoints: 20,
    missingPicBlocks: true,
    missingSicPoints: 10,
    missingSicBlocks: false,
    unresolvedPoints: 4,
    dutyIllegalPoints: 30,
    dutyIllegalBlocks: true,
    dutyWarningPoints: 10,
    currencyExpiredPoints: 25,
    currencyExpiredBlocks: true,
    currencyWarningPoints: 8,
    notFitPoints: 25,
    notFitBlocks: true,
  },
  ops: {
    enabled: true,
    holdPoints: 20,
    holdBlocks: true,
    gapCriticalPoints: 8,
    gapWarnPoints: 4,
    gapInfoPoints: 2,
    paxThreshold: 6,
    paxPoints: 3,
    internationalPoints: 6,
    circadianPoints: 8,
    circadianStartUtc: 22,
    circadianEndUtc: 5,
    repoLegPoints: 2,
    longBlockHours: 4,
    longBlockPoints: 5,
    veryLongBlockHours: 6,
    veryLongBlockPoints: 10,
    multiLegThreshold: 3,
    multiLegPoints: 6,
  },
  checklist: {
    illness: { points: 15, required: true, enabled: true },
    medication: { points: 20, required: true, enabled: true },
    stress: { points: 10, required: true, enabled: true },
    alcohol: { points: 40, required: true, enabled: true, blocks: true },
    fatigue: { points: 15, required: true, enabled: true },
    emotion: { points: 10, required: true, enabled: true },
    wx_brief: { points: 8, required: true, enabled: true },
    notams: { points: 6, required: true, enabled: true },
    performance: { points: 10, required: true, enabled: true },
    mel_review: { points: 8, required: true, enabled: true },
    comfortable: { points: 25, required: true, enabled: true, blocks: true },
  },
});

/** Checklist item definitions. Points/required/enabled come from config. */
export const FRAT_CHECKLIST = Object.freeze([
  { id: 'illness', label: 'Illness / injury', group: 'IMSAFE' },
  { id: 'medication', label: 'Medication / drugs', group: 'IMSAFE' },
  { id: 'stress', label: 'Stress', group: 'IMSAFE' },
  { id: 'alcohol', label: 'Alcohol (within 8+ hours)', group: 'IMSAFE' },
  { id: 'fatigue', label: 'Fatigue', group: 'IMSAFE' },
  { id: 'emotion', label: 'Emotion / distraction', group: 'IMSAFE' },
  { id: 'wx_brief', label: 'Weather briefing reviewed', group: 'GO', invert: true },
  { id: 'notams', label: 'NOTAMs reviewed', group: 'GO', invert: true },
  { id: 'performance', label: 'Performance / W&B reviewed', group: 'GO', invert: true },
  { id: 'mel_review', label: 'MEL / squawks reviewed', group: 'GO', invert: true },
  { id: 'comfortable', label: 'I am comfortable accepting this flight', group: 'GO', invert: true },
]);

/**
 * Editable field descriptors so the settings UI stays in sync with the model
 * without hard-coding a second copy of every knob.
 */
export const FRAT_CONFIG_SCHEMA = Object.freeze([
  {
    group: 'weather',
    label: 'Weather',
    description: 'METAR / TAF driven risk at departure and arrival.',
    fields: [
      { key: 'categoryPoints.LIFR', label: 'LIFR category', max: 100 },
      { key: 'categoryPoints.IFR', label: 'IFR category', max: 100 },
      { key: 'categoryPoints.MVFR', label: 'MVFR category', max: 100 },
      { key: 'ceilingLowFt', label: 'Low ceiling threshold (ft)', max: 5000, step: 100, unit: 'ft' },
      { key: 'ceilingLowPoints', label: 'Low ceiling points', max: 100 },
      { key: 'ceilingMedFt', label: 'Marginal ceiling threshold (ft)', max: 5000, step: 100, unit: 'ft' },
      { key: 'ceilingMedPoints', label: 'Marginal ceiling points', max: 100 },
      { key: 'visLowSm', label: 'Low visibility threshold (SM)', max: 10, step: 0.25, unit: 'SM' },
      { key: 'visLowPoints', label: 'Low visibility points', max: 100 },
      { key: 'visMedSm', label: 'Marginal visibility threshold (SM)', max: 10, step: 0.25, unit: 'SM' },
      { key: 'visMedPoints', label: 'Marginal visibility points', max: 100 },
      { key: 'gustHighKt', label: 'High gust threshold (kt)', max: 80, unit: 'kt' },
      { key: 'gustHighPoints', label: 'High gust points', max: 100 },
      { key: 'gustMedKt', label: 'Moderate gust threshold (kt)', max: 80, unit: 'kt' },
      { key: 'gustMedPoints', label: 'Moderate gust points', max: 100 },
      { key: 'windHighKt', label: 'Strong wind threshold (kt)', max: 80, unit: 'kt' },
      { key: 'windHighPoints', label: 'Strong wind points', max: 100 },
      { key: 'tafFactor', label: 'TAF weighting factor', max: 2, step: 0.1 },
      { key: 'missingPoints', label: 'Weather unavailable points', max: 100 },
    ],
  },
  {
    group: 'notam',
    label: 'NOTAMs',
    description: 'Significant FAA NOTAMs at either airport.',
    fields: [
      { key: 'highEach', label: 'Points per high-severity', max: 100 },
      { key: 'highMax', label: 'High-severity cap', max: 200 },
      { key: 'mediumEach', label: 'Points per medium-severity', max: 100 },
      { key: 'mediumMax', label: 'Medium-severity cap', max: 200 },
    ],
  },
  {
    group: 'aircraft',
    label: 'Aircraft',
    description: 'Airworthiness from squawks and MEL deferrals.',
    fields: [
      { key: 'aogPoints', label: 'AOG points', max: 200 },
      { key: 'aogBlocks', label: 'AOG forces NO-GO', type: 'boolean' },
      { key: 'restrictedPoints', label: 'Restricted (open MEL) points', max: 200 },
      { key: 'restrictedBlocks', label: 'Restricted forces NO-GO', type: 'boolean' },
      { key: 'groundingSquawkPoints', label: 'Grounding squawk points', max: 200 },
      { key: 'groundingSquawkBlocks', label: 'Grounding squawk forces NO-GO', type: 'boolean' },
      { key: 'openSquawkEach', label: 'Points per open squawk', max: 100 },
      { key: 'openSquawkMax', label: 'Open squawk cap', max: 200 },
    ],
  },
  {
    group: 'crew',
    label: 'Crew',
    description: 'Assignment, Part 135 duty legality, and currency.',
    fields: [
      { key: 'missingPicPoints', label: 'No PIC assigned', max: 200 },
      { key: 'missingPicBlocks', label: 'No PIC forces NO-GO', type: 'boolean' },
      { key: 'missingSicPoints', label: 'No SIC assigned', max: 200 },
      { key: 'missingSicBlocks', label: 'No SIC forces NO-GO', type: 'boolean' },
      { key: 'unresolvedPoints', label: 'Crew name unmatched to profile', max: 100 },
      { key: 'dutyIllegalPoints', label: 'Duty illegal', max: 200 },
      { key: 'dutyIllegalBlocks', label: 'Duty illegal forces NO-GO', type: 'boolean' },
      { key: 'dutyWarningPoints', label: 'Duty warning', max: 100 },
      { key: 'currencyExpiredPoints', label: 'Currency expired', max: 200 },
      { key: 'currencyExpiredBlocks', label: 'Currency expired forces NO-GO', type: 'boolean' },
      { key: 'currencyWarningPoints', label: 'Currency warning', max: 100 },
      { key: 'notFitPoints', label: 'Not fit for duty', max: 200 },
      { key: 'notFitBlocks', label: 'Not fit forces NO-GO', type: 'boolean' },
    ],
  },
  {
    group: 'ops',
    label: 'Operations',
    description: 'Schedule shape, readiness gaps, and dispatch posture.',
    fields: [
      { key: 'holdPoints', label: 'Ops HOLD points', max: 200 },
      { key: 'holdBlocks', label: 'Ops HOLD forces NO-GO', type: 'boolean' },
      { key: 'gapCriticalPoints', label: 'Readiness gap — critical', max: 100 },
      { key: 'gapWarnPoints', label: 'Readiness gap — warn', max: 100 },
      { key: 'gapInfoPoints', label: 'Readiness gap — info', max: 100 },
      { key: 'paxThreshold', label: 'High pax threshold', max: 30 },
      { key: 'paxPoints', label: 'High pax points', max: 100 },
      { key: 'internationalPoints', label: 'International / non-CONUS', max: 100 },
      { key: 'circadianPoints', label: 'Circadian low window points', max: 100 },
      { key: 'circadianStartUtc', label: 'Circadian window start (UTC hr)', max: 23 },
      { key: 'circadianEndUtc', label: 'Circadian window end (UTC hr)', max: 23 },
      { key: 'repoLegPoints', label: 'Repo / ferry leg points', max: 100 },
      { key: 'longBlockHours', label: 'Long block threshold (h)', max: 20, step: 0.5, unit: 'h' },
      { key: 'longBlockPoints', label: 'Long block points', max: 100 },
      { key: 'veryLongBlockHours', label: 'Very long block threshold (h)', max: 20, step: 0.5, unit: 'h' },
      { key: 'veryLongBlockPoints', label: 'Very long block points', max: 100 },
      { key: 'multiLegThreshold', label: 'Multi-leg day threshold', max: 12 },
      { key: 'multiLegPoints', label: 'Multi-leg day points', max: 100 },
    ],
  },
]);

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function bool(value, fallback) {
  if (value === true || value === false) return value;
  return fallback;
}

/**
 * Merge a stored (possibly partial or hand-edited) config over the defaults,
 * clamping every number so a bad value cannot make scores meaningless.
 */
export function normalizeFratConfig(stored) {
  const d = DEFAULT_FRAT_CONFIG;
  const s = stored && typeof stored === 'object' ? stored : {};

  const levelLow = clamp(num(s.levels?.low, d.levels.low), 1, 999);
  const levelModerate = clamp(num(s.levels?.moderate, d.levels.moderate), levelLow + 1, 1000);
  const levelHigh = clamp(num(s.levels?.high, d.levels.high), levelModerate + 1, 1001);

  const mergeNums = (groupKey) => {
    const out = {};
    for (const [key, fallback] of Object.entries(d[groupKey])) {
      const incoming = s[groupKey]?.[key];
      if (typeof fallback === 'boolean') {
        out[key] = bool(incoming, fallback);
      } else if (typeof fallback === 'number') {
        out[key] = clamp(num(incoming, fallback), 0, 1000);
      } else if (fallback && typeof fallback === 'object') {
        out[key] = {};
        for (const [subKey, subFallback] of Object.entries(fallback)) {
          out[key][subKey] = clamp(num(incoming?.[subKey], subFallback), 0, 1000);
        }
      } else {
        out[key] = fallback;
      }
    }
    return out;
  };

  const checklist = {};
  for (const item of FRAT_CHECKLIST) {
    const def = d.checklist[item.id] || { points: 10, required: true, enabled: true };
    const incoming = s.checklist?.[item.id] || {};
    checklist[item.id] = {
      points: clamp(num(incoming.points, def.points), 0, 1000),
      required: bool(incoming.required, def.required),
      enabled: bool(incoming.enabled, def.enabled),
      blocks: bool(incoming.blocks, def.blocks === true),
    };
  }

  return {
    version: FRAT_VERSION,
    levels: { low: levelLow, moderate: levelModerate, high: levelHigh },
    severeIsNoGo: bool(s.severeIsNoGo, d.severeIsNoGo),
    factors: Object.fromEntries(FRAT_FACTOR_OPTIONS.map((factor) => [
      factor.id,
      bool(s.factors?.[factor.id], true),
    ])),
    weather: mergeNums('weather'),
    notam: mergeNums('notam'),
    aircraft: mergeNums('aircraft'),
    crew: mergeNums('crew'),
    ops: mergeNums('ops'),
    checklist,
    updatedAt: s.updatedAt || null,
    updatedByName: s.updatedByName || null,
  };
}

/** Level bands derived from a config. */
export function fratLevels(config) {
  const cfg = config?.levels ? config : normalizeFratConfig(config);
  return [
    { id: 'low', label: 'LOW', max: cfg.levels.low, tone: 'green' },
    { id: 'moderate', label: 'MODERATE', max: cfg.levels.moderate, tone: 'amber' },
    { id: 'high', label: 'HIGH', max: cfg.levels.high, tone: 'orange' },
    { id: 'severe', label: 'SEVERE', max: Infinity, tone: 'red' },
  ];
}

export function fratLevelForScore(score, config) {
  const n = Math.max(0, Number(score) || 0);
  const levels = fratLevels(config);
  for (const level of levels) {
    if (n <= level.max) return level;
  }
  return levels[levels.length - 1];
}

function pushFactor(factors, {
  id, category, label, points, detail, severity = 'info', blocker = false,
}) {
  const pts = Number(points) || 0;
  if (!pts && !blocker) return;
  factors.push({
    id,
    category,
    label,
    points: pts,
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

/** Configurable late-night / early-morning window in UTC. */
function inCircadianWindow(isoOrDate, ops) {
  const h = hourUtc(isoOrDate);
  if (h == null) return false;
  const start = ops.circadianStartUtc;
  const end = ops.circadianEndUtc;
  if (start === end) return false;
  // Window wraps midnight when start > end (e.g. 22 → 05).
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

function categoryPoints(cat, weather) {
  const key = String(cat || '').toUpperCase();
  const points = weather.categoryPoints[key] || 0;
  const severity = points >= 20 ? 'critical' : points >= 10 ? 'warn' : 'info';
  return { points, severity };
}

function scoreAirportWeather(factors, side, wx, weather, enabled) {
  if (!weather.enabled) return;
  if (!wx?.ok && !wx?.metar && !wx?.parsed) {
    if (enabled.weatherMissing) {
      pushFactor(factors, {
        id: `wx-missing-${side}`,
        category: 'Weather',
        label: `${side} weather unavailable`,
        points: weather.missingPoints,
        detail: 'Could not load METAR — treat as unknown risk',
        severity: 'warn',
      });
    }
    return;
  }
  const metar = wx.metar || wx.parsed || {};
  const cat = metar.flightCategory || wx.parsed?.flightCategory;
  const scored = categoryPoints(cat, weather);
  if (enabled.weatherCategory && scored.points) {
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
  if (enabled.weatherCeiling && ceiling != null && ceiling < weather.ceilingLowFt) {
    pushFactor(factors, {
      id: `wx-ceil-${side}`,
      category: 'Weather',
      label: `${side} ceiling ${ceiling} ft`,
      points: weather.ceilingLowPoints,
      severity: 'critical',
    });
  } else if (enabled.weatherCeiling && ceiling != null && ceiling < weather.ceilingMedFt) {
    pushFactor(factors, {
      id: `wx-ceil-${side}`,
      category: 'Weather',
      label: `${side} ceiling ${ceiling} ft`,
      points: weather.ceilingMedPoints,
      severity: 'warn',
    });
  }
  const vis = metar.visibilitySm;
  if (enabled.weatherVisibility && vis != null && vis < weather.visLowSm) {
    pushFactor(factors, {
      id: `wx-vis-${side}`,
      category: 'Weather',
      label: `${side} visibility ${vis} SM`,
      points: weather.visLowPoints,
      severity: 'critical',
    });
  } else if (enabled.weatherVisibility && vis != null && vis < weather.visMedSm) {
    pushFactor(factors, {
      id: `wx-vis-${side}`,
      category: 'Weather',
      label: `${side} visibility ${vis} SM`,
      points: weather.visMedPoints,
      severity: 'warn',
    });
  }
  const gust = metar.windGustKt;
  const wind = metar.windKt;
  if (enabled.weatherGust && gust != null && gust >= weather.gustHighKt) {
    pushFactor(factors, {
      id: `wx-gust-${side}`,
      category: 'Weather',
      label: `${side} gusts ${gust} kt`,
      points: weather.gustHighPoints,
      severity: 'warn',
    });
  } else if (enabled.weatherGust && gust != null && gust >= weather.gustMedKt) {
    pushFactor(factors, {
      id: `wx-gust-${side}`,
      category: 'Weather',
      label: `${side} gusts ${gust} kt`,
      points: weather.gustMedPoints,
      severity: 'info',
    });
  } else if (enabled.weatherWind && wind != null && wind >= weather.windHighKt) {
    pushFactor(factors, {
      id: `wx-wind-${side}`,
      category: 'Weather',
      label: `${side} wind ${wind} kt`,
      points: weather.windHighPoints,
      severity: 'info',
    });
  }

  // Worst forecast category across TAF periods, weighted down from observed.
  const periods = wx.taf?.periods || wx.parsed?.tafPeriods || [];
  let worstTaf = null;
  let worstPts = 0;
  for (const p of periods) {
    const { points } = categoryPoints(p.flightCategory, weather);
    if (points > worstPts) {
      worstPts = points;
      worstTaf = p.flightCategory;
    }
  }
  const tafPoints = Math.round(worstPts * weather.tafFactor);
  if (enabled.weatherTaf && tafPoints > 0 && worstPts >= (weather.categoryPoints.IFR || 15)) {
    pushFactor(factors, {
      id: `wx-taf-${side}`,
      category: 'Weather',
      label: `${side} TAF ${worstTaf}`,
      points: tafPoints,
      detail: 'Forecast period indicates reduced conditions',
      severity: worstPts >= (weather.categoryPoints.LIFR || 25) ? 'critical' : 'warn',
    });
  }
}

function scoreNotams(factors, side, notams, cfg, enabled) {
  if (!cfg.enabled) return;
  const significant = notams?.significantOnly
    || (Array.isArray(notams?.notams) ? notams.notams.filter((n) => n.severity === 'high' || n.severity === 'medium') : []);
  if (!Array.isArray(significant) || !significant.length) return;
  const high = significant.filter((n) => n.severity === 'high').length;
  const medium = significant.filter((n) => n.severity === 'medium').length;
  if (enabled.notamHigh && high > 0) {
    pushFactor(factors, {
      id: `notam-high-${side}`,
      category: 'NOTAM',
      label: `${side}: ${high} high-severity NOTAM${high === 1 ? '' : 's'}`,
      points: Math.min(cfg.highMax, high * cfg.highEach),
      severity: 'critical',
    });
  }
  if (enabled.notamMedium && medium > 0) {
    pushFactor(factors, {
      id: `notam-med-${side}`,
      category: 'NOTAM',
      label: `${side}: ${medium} medium NOTAM${medium === 1 ? '' : 's'}`,
      points: Math.min(cfg.mediumMax, medium * cfg.mediumEach),
      severity: 'warn',
    });
  }
}

function scoreAircraft(factors, aircraftStatus, squawkSummary, cfg, enabled) {
  if (!cfg.enabled) return;
  const status = aircraftStatus?.status || 'UNKNOWN';
  if (enabled.aircraftAog && status === 'AOG') {
    pushFactor(factors, {
      id: 'ac-aog',
      category: 'Aircraft',
      label: 'Aircraft AOG / grounded',
      points: cfg.aogPoints,
      detail: (aircraftStatus.reasons || []).slice(0, 2).join('; ') || null,
      severity: 'critical',
      blocker: cfg.aogBlocks,
    });
  } else if (enabled.aircraftRestricted && status === 'RESTRICTED') {
    pushFactor(factors, {
      id: 'ac-restricted',
      category: 'Aircraft',
      label: `Aircraft restricted (${aircraftStatus.melOpen || 0} open MEL)`,
      points: cfg.restrictedPoints,
      detail: (aircraftStatus.reasons || []).slice(0, 2).join('; ') || null,
      severity: 'warn',
      blocker: cfg.restrictedBlocks,
    });
  }
  const grounding = squawkSummary?.grounding || 0;
  const open = squawkSummary?.openSquawks || 0;
  if (
    enabled.aircraftGroundingSquawk
    && grounding > 0
    && (status !== 'AOG' || !enabled.aircraftAog)
  ) {
    pushFactor(factors, {
      id: 'ac-ground-squawk',
      category: 'Aircraft',
      label: `${grounding} grounding squawk${grounding === 1 ? '' : 's'}`,
      points: cfg.groundingSquawkPoints,
      severity: 'critical',
      blocker: cfg.groundingSquawkBlocks,
    });
  } else if (enabled.aircraftOpenSquawk && open > 0) {
    pushFactor(factors, {
      id: 'ac-squawk',
      category: 'Aircraft',
      label: `${open} open squawk${open === 1 ? '' : 's'}`,
      points: Math.min(cfg.openSquawkMax, open * cfg.openSquawkEach),
      severity: 'warn',
    });
  }
}

function scoreCrewMember(factors, role, crew, cfg, enabled) {
  if (!cfg.enabled) return;
  const isPic = role === 'PIC';
  if (!crew?.name && !crew?.resolved) {
    const counts = isPic ? enabled.crewMissingPic : enabled.crewMissingSic;
    if (counts) {
      pushFactor(factors, {
        id: `crew-missing-${role}`,
        category: 'Crew',
        label: `No ${role} assigned`,
        points: isPic ? cfg.missingPicPoints : cfg.missingSicPoints,
        severity: isPic ? 'critical' : 'warn',
        blocker: isPic ? cfg.missingPicBlocks : cfg.missingSicBlocks,
      });
    }
    return;
  }
  if (enabled.crewUnresolved && crew.name && !crew.resolved) {
    pushFactor(factors, {
      id: `crew-unresolved-${role}`,
      category: 'Crew',
      label: `${role} not matched to a user profile`,
      points: cfg.unresolvedPoints,
      detail: crew.name,
      severity: 'info',
    });
  }
  const legality = crew.legality;
  if (enabled.crewDutyIllegal && legality?.status === 'illegal') {
    pushFactor(factors, {
      id: `crew-illegal-${role}`,
      category: 'Crew',
      label: `${role} duty status illegal`,
      points: cfg.dutyIllegalPoints,
      detail: (legality.blockers || []).map((b) => b.message || b.label || b.code || b).slice(0, 2).join('; ') || null,
      severity: 'critical',
      blocker: cfg.dutyIllegalBlocks,
    });
  } else if (enabled.crewDutyWarning && legality?.status === 'warning') {
    pushFactor(factors, {
      id: `crew-warn-${role}`,
      category: 'Crew',
      label: `${role} duty caution`,
      points: cfg.dutyWarningPoints,
      detail: (legality.warnings || []).map((w) => w.message || w.label || w.code || w).slice(0, 2).join('; ') || null,
      severity: 'warn',
    });
  }
  const currency = crew.currency;
  if (enabled.crewCurrencyExpired && (currency?.expiredCount > 0 || currency?.status === 'expired')) {
    pushFactor(factors, {
      id: `crew-currency-exp-${role}`,
      category: 'Crew',
      label: `${role} currency expired`,
      points: cfg.currencyExpiredPoints,
      detail: `${currency.expiredCount || 1} item(s)`,
      severity: 'critical',
      blocker: cfg.currencyExpiredBlocks,
    });
  } else if (enabled.crewCurrencyWarning && (currency?.warningCount > 0 || ['warning', 'critical'].includes(currency?.status))) {
    pushFactor(factors, {
      id: `crew-currency-warn-${role}`,
      category: 'Crew',
      label: `${role} currency warning`,
      points: cfg.currencyWarningPoints,
      severity: 'warn',
    });
  }
  if (enabled.crewNotFit && crew.fitForDuty === false) {
    pushFactor(factors, {
      id: `crew-fit-${role}`,
      category: 'Crew',
      label: `${role} marked not fit for duty`,
      points: cfg.notFitPoints,
      severity: 'critical',
      blocker: cfg.notFitBlocks,
    });
  }
}

function scoreOps(factors, trip, tripState, outstanding, cfg, enabled) {
  if (!cfg.enabled) return;
  const info = trip?.info || {};
  const category = String(info.category || '').toUpperCase();
  const legType = String(info.legType || '').toUpperCase();

  if (enabled.opsHold && tripState?.opsDisposition === 'hold') {
    pushFactor(factors, {
      id: 'ops-hold',
      category: 'Operations',
      label: 'Ops disposition: HOLD',
      points: cfg.holdPoints,
      detail: tripState.opsDispositionReason || null,
      severity: 'critical',
      blocker: cfg.holdBlocks,
    });
  }

  if (enabled.opsReadiness) {
    for (const gap of outstanding || []) {
      const pts = gap.severity === 'critical'
        ? cfg.gapCriticalPoints
        : gap.severity === 'warn'
          ? cfg.gapWarnPoints
          : cfg.gapInfoPoints;
      pushFactor(factors, {
        id: `ops-${gap.code}`,
        category: 'Operations',
        label: gap.label || gap.code,
        points: pts,
        severity: gap.severity === 'critical' ? 'warn' : 'info',
      });
    }
  }

  if (enabled.opsPax && legType === 'REVENUE' && Number(info.pax || 0) >= cfg.paxThreshold) {
    pushFactor(factors, {
      id: 'ops-pax-high',
      category: 'Operations',
      label: `${info.pax} passengers`,
      points: cfg.paxPoints,
      severity: 'info',
    });
  }

  if (enabled.opsInternational && (!isUsDomesticAirport(info.from) || !isUsDomesticAirport(info.to))) {
    pushFactor(factors, {
      id: 'ops-intl',
      category: 'Operations',
      label: 'International / non-CONUS airport',
      points: cfg.internationalPoints,
      detail: `${info.from || '?'} → ${info.to || '?'}`,
      severity: 'info',
    });
  }

  if (enabled.opsCircadian && inCircadianWindow(trip?.start, cfg)) {
    pushFactor(factors, {
      id: 'ops-circadian',
      category: 'Operations',
      label: `Departure in circadian low window (UTC ${cfg.circadianStartUtc}–${cfg.circadianEndUtc})`,
      points: cfg.circadianPoints,
      severity: 'warn',
    });
  }

  if (enabled.opsRepo && (category === 'REPO' || category === 'FERRY')) {
    pushFactor(factors, {
      id: 'ops-repo',
      category: 'Operations',
      label: `${category} leg`,
      points: cfg.repoLegPoints,
      severity: 'info',
    });
  }

  try {
    const start = trip?.start instanceof Date ? trip.start.getTime() : new Date(trip?.start).getTime();
    const end = trip?.end instanceof Date ? trip.end.getTime() : new Date(trip?.end).getTime();
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const hours = (end - start) / 3600_000;
      const veryLong = hours >= cfg.veryLongBlockHours;
      if (enabled.opsLongBlock && hours >= cfg.longBlockHours) {
        pushFactor(factors, {
          id: 'ops-long-block',
          category: 'Operations',
          label: `Scheduled block ~${hours.toFixed(1)} h`,
          points: veryLong ? cfg.veryLongBlockPoints : cfg.longBlockPoints,
          severity: veryLong ? 'warn' : 'info',
        });
      }
    }
  } catch {
    /* ignore */
  }

  if (enabled.opsMultiLeg && trip?.sameDayLegCount >= cfg.multiLegThreshold) {
    pushFactor(factors, {
      id: 'ops-multi-leg',
      category: 'Operations',
      label: `${trip.sameDayLegCount} legs same day on this tail`,
      points: cfg.multiLegPoints,
      severity: 'info',
    });
  }
}

function scoreChecklist(factors, answers, checklistCfg) {
  const map = answers && typeof answers === 'object' ? answers : {};
  for (const item of FRAT_CHECKLIST) {
    const cfg = checklistCfg[item.id];
    if (!cfg?.enabled) continue;
    const raw = map[item.id];
    if (raw == null) continue;
    // invert: true means "yes I reviewed" is good; adverse when false/no
    const adverse = item.invert ? raw === false || raw === 'no' : raw === true || raw === 'yes';
    if (adverse) {
      pushFactor(factors, {
        id: `check-${item.id}`,
        category: item.group === 'IMSAFE' ? 'Human factors' : 'Checklist',
        label: item.label,
        points: cfg.points,
        severity: cfg.points >= 20 ? 'critical' : 'warn',
        blocker: cfg.blocks === true,
      });
    }
  }
}

/** Checklist items a crew member must answer under the active config. */
export function requiredChecklistItems(config) {
  const cfg = normalizeFratConfig(config);
  return FRAT_CHECKLIST.filter((item) => {
    const c = cfg.checklist[item.id];
    return c?.enabled && c?.required;
  });
}

/**
 * Compute a FRAT result from gathered inputs.
 *
 * @param {object} input
 * @param {object} input.trip — { start, end, info, sameDayLegCount? }
 * @param {object} [input.config] — stored/normalized scoring config
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
  const config = normalizeFratConfig(input.config);
  const factors = [];
  const trip = input.trip || {};
  const info = trip.info || {};

  scoreAirportWeather(factors, 'Departure', input.originWx, config.weather, config.factors);
  scoreAirportWeather(factors, 'Arrival', input.destWx, config.weather, config.factors);
  scoreNotams(factors, info.from || 'DEP', input.originNotams, config.notam, config.factors);
  scoreNotams(factors, info.to || 'ARR', input.destNotams, config.notam, config.factors);
  scoreAircraft(factors, input.aircraftStatus, input.squawkSummary, config.aircraft, config.factors);
  scoreCrewMember(factors, 'PIC', input.pic || { name: info.pic }, config.crew, config.factors);
  if (String(info.legType || '').toUpperCase() === 'REVENUE' || info.sic) {
    scoreCrewMember(factors, 'SIC', input.sic || { name: info.sic }, config.crew, config.factors);
  }
  scoreOps(factors, trip, input.tripState, input.outstanding, config.ops, config.factors);
  scoreChecklist(factors, input.checklist, config.checklist);

  const score = factors.reduce((sum, f) => sum + (Number(f.points) || 0), 0);
  const level = fratLevelForScore(score, config);
  const blockers = factors.filter((f) => f.blocker);
  const unanswered = requiredChecklistItems(config)
    .filter((item) => input.checklist?.[item.id] == null)
    .map((item) => item.id);

  const severeBlocks = config.severeIsNoGo && level.id === 'severe';

  return {
    version: FRAT_VERSION,
    score,
    level: level.id,
    levelLabel: level.label,
    tone: level.tone,
    factors: factors.sort((a, b) => (b.points || 0) - (a.points || 0)),
    blockers,
    go: blockers.length === 0 && !severeBlocks && unanswered.length === 0,
    unanswered,
    thresholds: { ...config.levels },
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
    thresholds: result.thresholds || null,
    computedAt: result.computedAt || Date.now(),
  };
}
