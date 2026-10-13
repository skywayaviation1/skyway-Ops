// Revision history for a submitted load manifest (form S-5/R-37).
//
// A filing is not overwritten. The document's top-level fields are the
// current revision; `revisions[]` keeps every prior filing, including a
// snapshot of the form and the field-level diff that produced the next one.
//
// Who may amend: the same people who can submit (crew) plus ops and admins.
// The S-5 is filled out at the end of the flying day, so a same-day correction
// stays open after the legs have landed. The record closes — admin only, with
// a warning — once the flight day is over, or while a linked leg is still airborne.

const HEADER_FIELDS = [
  ['hobbsOut', 'Hobbs out'],
  ['hobbsIn', 'Hobbs in'],
  ['hobbsTotal', 'Hobbs total'],
  ['waitTime', 'Wait time'],
  ['timeOut', 'Time out'],
  ['timeIn', 'Time in'],
  ['timeTotal', 'Time total'],
  ['dutyTimeIn', 'Duty time in'],
  ['dutyTimeOut', 'Duty time out'],
  ['dutyTimeTotal', 'Duty time total'],
];

const LEG_FIELDS = [
  ['from', 'From'],
  ['to', 'To'],
  ['airport', 'Airport'],
  ['timeOut', 'Time out'],
  ['timeIn', 'Time in'],
  ['total', 'Total'],
  ['cycles', 'Cycles'],
  ['nightLdgs', 'Night landings'],
  ['toWeight', 'T/O weight'],
  ['maxAllowable', 'Max allowable'],
  ['fwdCG', 'Fwd C.G. limit'],
  ['toCG', 'T/O C.G.'],
  ['aftCG', 'Aft C.G. limit'],
  ['numPax', '# passengers'],
  ['configuration', 'Configuration'],
  ['legType', 'Leg type'],
];

const CLOSED_REASON = {
  day: 'This flight day is complete. Only an admin can amend a closed manifest.',
  airborne: 'A leg on this manifest is still airborne. Only an admin can amend it until the flight is down.',
};

export const ADMIN_AMEND_WARNING = 'This flight has departed or the flight day is complete. Amending changes the official filed record. Recipients get an AMENDED revision and are told to use the new version.';

function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

function same(a, b) {
  return text(a) === text(b);
}

function actor(user) {
  return {
    by: user?.name || '',
    byUid: user?.uid || user?.id || '',
    byEmail: user?.email || '',
  };
}

function documentId(pax) {
  const explicit = pax.idNumber || pax.documentNumber || pax.govId
    || pax.passport || pax.passportNumber || pax.identification || '';
  if (text(explicit)) return text(explicit);
  const raw = text(pax.id);
  if (!raw) return '';
  // Internal row ids ("p1") and generated keys are not government ID numbers.
  if (/^p\d+$/i.test(raw)) return '';
  if (/^[0-9a-f-]{16,}$/i.test(raw)) return '';
  return raw;
}

/** Normalize one passenger slot. Strings are names. Objects may carry DOB, weight, and ID. */
export function normalizePassenger(pax) {
  if (pax == null) return null;
  if (typeof pax === 'string') {
    const name = text(pax);
    return name ? { name, dob: '', weight: '', id: '' } : null;
  }
  if (typeof pax !== 'object') return null;
  const name = text(pax.name || `${pax.firstName || ''} ${pax.lastName || ''}`);
  const dob = text(pax.dob || pax.dateOfBirth);
  const weight = text(pax.weight ?? pax.paxWeight);
  const id = documentId(pax);
  if (!name && !dob && !weight && !id) return null;
  return { name, dob, weight, id };
}

function passengerList(list) {
  return (Array.isArray(list) ? list : []).map(normalizePassenger);
}

function signatureSnapshot(sig) {
  if (!sig || typeof sig !== 'object') return null;
  if (!text(sig.name) && !sig.signatureImg) return null;
  return {
    name: text(sig.name),
    uid: sig.uid || '',
    email: text(sig.email),
    timestamp: sig.timestamp || null,
    hasSignature: Boolean(sig.signatureImg),
  };
}

function legSnapshot(leg) {
  const src = leg && typeof leg === 'object' ? leg : {};
  const out = {};
  for (const [key] of LEG_FIELDS) out[key] = src[key] == null ? '' : src[key];
  out.tripUid = src.tripUid || null;
  out.passengers = passengerList(src.passengers);
  return out;
}

/** Form fields that make up one filing. Signature images stay on the live document only. */
export function manifestContentSnapshot(manifest) {
  const src = manifest && typeof manifest === 'object' ? manifest : {};
  const snap = {
    tail: src.tail || '',
    date: src.date || '',
  };
  for (const [key] of HEADER_FIELDS) snap[key] = src[key] == null ? '' : src[key];
  snap.legs = (Array.isArray(src.legs) ? src.legs : []).map(legSnapshot);
  snap.picSig = signatureSnapshot(src.picSig);
  snap.sicSig = signatureSnapshot(src.sicSig);
  return snap;
}

function change(path, label, before, after, kind) {
  let summary;
  if (kind === 'added') summary = `${label}: ${after}`;
  else if (kind === 'removed') summary = `${label}: ${before}`;
  else summary = `${label}: ${before} → ${after}`;
  return { path, label, before: before ?? '', after: after ?? '', kind, summary };
}

function diffPassengers(beforeList, afterList, legLabel, pathBase) {
  const out = [];
  const before = passengerList(beforeList);
  const after = passengerList(afterList);
  const len = Math.max(before.length, after.length);
  for (let i = 0; i < len; i++) {
    const prev = before[i];
    const next = after[i];
    const slot = `${legLabel} passenger ${i + 1}`;
    const path = `${pathBase}.passengers[${i}]`;
    if (!prev && next) {
      out.push(change(path, `${legLabel} passenger added`, '', next.name || 'passenger', 'added'));
      continue;
    }
    if (prev && !next) {
      out.push(change(path, `${legLabel} passenger removed`, prev.name || 'passenger', '', 'removed'));
      continue;
    }
    if (!prev && !next) continue;
    if (!same(prev.name, next.name)) {
      out.push(change(`${path}.name`, `${slot} name`, prev.name, next.name, 'changed'));
    }
    if (!same(prev.dob, next.dob)) {
      out.push(change(`${path}.dob`, `${slot} DOB`, prev.dob || '—', next.dob || '—', 'changed'));
    }
    if (!same(prev.weight, next.weight)) {
      out.push(change(`${path}.weight`, `${slot} weight`, prev.weight || '—', next.weight || '—', 'changed'));
    }
    if (!same(prev.id, next.id)) {
      out.push(change(`${path}.id`, `${slot} ID`, prev.id || '—', next.id || '—', 'changed'));
    }
  }
  return out;
}

function legRoute(leg) {
  const from = text(leg?.from) || '?';
  const to = text(leg?.to) || '?';
  return `${from} → ${to}`;
}

function pairLegs(beforeLegs, afterLegs) {
  const usedAfter = new Set();
  const pairs = [];
  const removed = [];
  beforeLegs.forEach((leg, index) => {
    let match = -1;
    if (leg.tripUid) {
      match = afterLegs.findIndex((other, idx) => !usedAfter.has(idx) && other.tripUid && other.tripUid === leg.tripUid);
    }
    if (match < 0 && afterLegs[index] && !usedAfter.has(index)) {
      const candidate = afterLegs[index];
      const conflict = leg.tripUid && candidate.tripUid && leg.tripUid !== candidate.tripUid;
      if (!conflict) match = index;
    }
    if (match < 0) {
      removed.push({ index, leg });
      return;
    }
    usedAfter.add(match);
    pairs.push({ beforeIndex: index, afterIndex: match, before: leg, after: afterLegs[match] });
  });
  const added = [];
  afterLegs.forEach((leg, index) => {
    if (!usedAfter.has(index)) added.push({ index, leg });
  });
  return { pairs, removed, added };
}

function diffSignature(role, before, after) {
  const label = role.toUpperCase();
  const path = `${role}Sig`;
  if (!before && after) return [change(path, `${label} signature added`, '', after.name || label, 'added')];
  if (before && !after) return [change(path, `${label} signature removed`, before.name || label, '', 'removed')];
  if (!before && !after) return [];
  const out = [];
  if (!same(before.name, after.name) || !same(before.email, after.email)) {
    const from = before.name || before.email || '—';
    const to = after.name || after.email || '—';
    out.push(change(path, `${label} signature`, from, to, 'changed'));
  } else if (before.hasSignature !== after.hasSignature) {
    out.push(change(`${path}.image`, `${label} signature redrawn`, before.hasSignature ? 'signed' : 'unsigned', after.hasSignature ? 'signed' : 'unsigned', 'changed'));
  }
  return out;
}

/** Field-level diff between two content snapshots (or full manifest docs). */
export function diffManifestContents(beforeManifest, afterManifest) {
  const before = manifestContentSnapshot(beforeManifest);
  const after = manifestContentSnapshot(afterManifest);
  const out = [];

  for (const [key, label] of HEADER_FIELDS) {
    if (!same(before[key], after[key])) {
      out.push(change(key, label, text(before[key]) || '—', text(after[key]) || '—', 'changed'));
    }
  }

  const beforeLegs = before.legs || [];
  const afterLegs = after.legs || [];
  const { pairs, removed, added } = pairLegs(beforeLegs, afterLegs);

  for (const { beforeIndex, afterIndex, before: prev, after: next } of pairs) {
    const legLabel = `Leg ${afterIndex + 1}`;
    const path = `legs[${beforeIndex}]`;
    for (const [key, label] of LEG_FIELDS) {
      if (!same(prev[key], next[key])) {
        out.push(change(`${path}.${key}`, `${legLabel} ${label}`, text(prev[key]) || '—', text(next[key]) || '—', 'changed'));
      }
    }
    out.push(...diffPassengers(prev.passengers, next.passengers, legLabel, path));
  }
  for (const { leg } of removed) {
    out.push(change('legs', 'Leg removed', legRoute(leg), '', 'removed'));
  }
  for (const { index, leg } of added) {
    out.push(change(`legs[${index}]`, `Leg ${index + 1} added`, '', legRoute(leg), 'added'));
  }

  out.push(...diffSignature('pic', before.picSig, after.picSig));
  out.push(...diffSignature('sic', before.sicSig, after.sicSig));
  return out;
}

export function summarizeDiff(diff) {
  const lines = (Array.isArray(diff) ? diff : []).map(item => item.summary).filter(Boolean);
  if (lines.length === 0) return '';
  if (lines.length <= 8) return lines.join('\n');
  return `${lines.slice(0, 8).join('\n')}\n… and ${lines.length - 8} more changes`;
}

export function currentRevisionNumber(manifest) {
  const n = Number(manifest?.revision);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  if (manifest?.status === 'submitted') return 1;
  return 0;
}

export function revisionLabel(manifest) {
  const n = currentRevisionNumber(manifest);
  if (manifest?.status === 'submitted' && n > 1) return `Amended (Rev ${n})`;
  if (manifest?.status === 'submitted') return 'Submitted';
  return 'Draft';
}

/** History rows for the UI. Legacy filings with no array still show as Rev 1. */
export function revisionHistory(manifest) {
  if (Array.isArray(manifest?.revisions) && manifest.revisions.length > 0) {
    return [...manifest.revisions].sort((a, b) => Number(a.revision) - Number(b.revision));
  }
  if (manifest?.status === 'submitted') {
    return [{
      revision: 1,
      kind: 'original',
      at: manifest.submittedAt || null,
      by: manifest.submittedBy || '',
      byUid: manifest.submittedByUid || '',
      byEmail: manifest.submittedByEmail || '',
      note: '',
      summary: 'Original submission',
      diff: [],
    }];
  }
  return [];
}

export function validateManifestSubmit(manifest) {
  const errors = [];
  if (!manifest?.picSig || !manifest?.sicSig) {
    errors.push('Both PIC and SIC must sign before submitting.');
  }
  if (!(manifest?.legs || []).length) {
    errors.push('Manifest has no legs. Add at least one leg before submitting.');
  }
  return errors;
}

function historyEntry(revision, kind, user, now, extra) {
  return {
    revision,
    kind,
    at: now,
    ...actor(user),
    note: '',
    summary: '',
    diff: [],
    snapshot: null,
    ...extra,
  };
}

function copyHistory(list) {
  return (Array.isArray(list) ? list : []).map(entry => ({
    ...entry,
    diff: Array.isArray(entry.diff) ? entry.diff.map(item => ({ ...item })) : [],
    snapshot: entry.snapshot ? manifestContentSnapshot(entry.snapshot) : entry.snapshot ?? null,
  }));
}

/**
 * First filing. Revision 1's snapshot is the original; later amendments append.
 */
export function buildOriginalSubmission(draft, user, now = Date.now()) {
  const snapshot = manifestContentSnapshot(draft);
  const entry = historyEntry(1, 'original', user, now, {
    summary: 'Original submission',
    snapshot,
  });
  return {
    manifest: {
      ...draft,
      status: 'submitted',
      revision: 1,
      amended: false,
      changeSummary: '',
      amendmentNote: '',
      amendedAt: null,
      amendedBy: '',
      amendedByUid: '',
      amendedByEmail: '',
      submittedAt: now,
      submittedBy: user?.name || '',
      submittedByUid: user?.uid || user?.id || '',
      submittedByEmail: user?.email || '',
      revisions: [entry],
    },
  };
}

/**
 * Next revision. Refuses a no-op. Copies every previous revision through
 * unchanged and appends the new snapshot plus its diff.
 */
export function buildResubmission({ baseline, draft, note, user, now = Date.now() }) {
  const diff = diffManifestContents(baseline, draft);
  if (diff.length === 0) {
    return {
      ok: false,
      error: 'Nothing changed from the filed revision. Edit the manifest before resubmitting.',
    };
  }
  const summary = summarizeDiff(diff);
  const history = copyHistory(baseline?.revisions);
  const before = manifestContentSnapshot(baseline);
  const original = history.find(entry => Number(entry.revision) === 1);
  if (!original) {
    history.unshift(historyEntry(1, 'original', {
      name: baseline?.submittedBy || '',
      uid: baseline?.submittedByUid || '',
      email: baseline?.submittedByEmail || '',
    }, baseline?.submittedAt || baseline?.updatedAt || now, {
      summary: 'Original submission',
      snapshot: before,
    }));
  } else if (!original.snapshot) {
    // Legacy filings recorded the revision row without a form snapshot.
    original.snapshot = before;
  }
  const nextRev = currentRevisionNumber(baseline) + 1;
  const trimmedNote = text(note);
  const entry = historyEntry(nextRev, 'amendment', user, now, {
    note: trimmedNote,
    summary,
    diff,
    snapshot: manifestContentSnapshot(draft),
  });
  const kept = history.filter(item => Number(item.revision) !== nextRev);
  kept.push(entry);
  kept.sort((a, b) => Number(a.revision) - Number(b.revision));

  return {
    ok: true,
    summary,
    diff,
    manifest: {
      ...draft,
      status: 'submitted',
      revision: nextRev,
      amended: true,
      changeSummary: summary,
      amendmentNote: trimmedNote,
      amendedAt: now,
      amendedBy: user?.name || '',
      amendedByUid: user?.uid || user?.id || '',
      amendedByEmail: user?.email || '',
      submittedAt: baseline?.submittedAt || now,
      submittedBy: baseline?.submittedBy || user?.name || '',
      submittedByUid: baseline?.submittedByUid || '',
      submittedByEmail: baseline?.submittedByEmail || '',
      revisions: kept,
    },
  };
}

/**
 * @param {object} args
 * @param {object} args.manifest
 * @param {string} args.role
 * @param {string} args.today YYYY-MM-DD in the app timezone
 * @param {Record<string, {airborne?: boolean, departed?: boolean, completed?: boolean, date?: string}>} [args.legStatusByUid]
 */
export function amendmentAccess({ manifest, role, today, legStatusByUid = {} }) {
  const allowedRole = role === 'crew' || role === 'ops' || role === 'admin';
  if (!allowedRole) {
    return {
      allowed: false,
      closed: false,
      warning: '',
      reason: 'Only crew, operations, and admins can amend a manifest.',
    };
  }
  if (manifest?.status !== 'submitted') {
    return {
      allowed: false,
      closed: false,
      warning: '',
      reason: 'Only a submitted manifest can be amended.',
    };
  }

  const manifestDate = text(manifest?.date);
  let closedReason = '';
  if (manifestDate && today && manifestDate < today) closedReason = 'day';

  if (!closedReason) {
    for (const leg of manifest?.legs || []) {
      if (!leg?.tripUid) continue;
      const info = legStatusByUid[leg.tripUid];
      if (!info) continue;
      if (info.airborne) {
        closedReason = 'airborne';
        break;
      }
      const legDate = text(info.date);
      const flown = Boolean(info.departed || info.completed);
      if (flown && legDate && today && legDate < today) {
        closedReason = 'day';
        break;
      }
    }
  }

  if (!closedReason) {
    return { allowed: true, closed: false, warning: '', reason: '' };
  }
  if (role === 'admin') {
    return { allowed: true, closed: true, warning: ADMIN_AMEND_WARNING, reason: '' };
  }
  return {
    allowed: false,
    closed: true,
    warning: '',
    reason: CLOSED_REASON[closedReason] || CLOSED_REASON.day,
  };
}

/** True when a linked leg is off the ground and not yet down or marked complete. */
export function isLegAirborne(state) {
  const statuses = state?.statuses || {};
  const up = Boolean(statuses.wheels_up || statuses.taxi_dep);
  const down = Boolean(statuses.landed || state?.completed || state?.archived);
  return up && !down;
}
