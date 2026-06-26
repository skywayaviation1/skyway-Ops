// src/AdminDutyTools.jsx
//
// Three admin features for fixing missed/incorrect pilot duty:
//
//   1. ADD/EDIT DUTY DAY — pick a pilot, pick a date, manually enter duty
//      on/off times (Eastern) + legs (from-to + block time). Save creates
//      or updates a duty period in `duty-periods-v2`.
//
//   2. COPY FROM PILOT — inside the day editor, an "imported their
//      partner's record" button lets admin pick another pilot who flew
//      WITH the target pilot that day (PIC/SIC pair) and copy their
//      duty record into the form, so the missing pilot's record matches
//      what their crewmate already logged.
//
//   3. JETINSIGHT PASTE IMPORTER — admin pastes a multi-day JetInsight
//      flight-duty block, picks the year+month it covers, the pilot it
//      belongs to. Parser extracts each day's duty on/off, FT, and legs.
//      Per-day conflict resolver: if a record already exists for that
//      pilot on that date, admin chooses Overwrite or Skip. Then commits
//      all approved periods at once.
//
// ALL TIMES ARE EASTERN. JetInsight may show "Zulu" in its header but
// Skyway operates ET, and Jake confirmed he's entering ET wall-clock
// times in this tool. Conversion to UTC ms uses Intl + IANA
// 'America/New_York' so DST is handled correctly across the spring/fall
// transitions.

import React, { useEffect, useMemo, useState } from 'react';
import {
  collection, query, where, getDocs, doc, setDoc, deleteDoc,
  addDoc, Timestamp, serverTimestamp,
} from 'firebase/firestore';
import {
  X, Plus, Edit2, Trash2, Copy, Loader2, AlertTriangle, Check,
  ChevronDown, Calendar, Upload, User as UserIcon, ArrowRight,
} from 'lucide-react';

// db is imported lazily inside async paths to avoid pulling firebase into
// any module that statically imports this file before sign-in.

/* ═══════════════════════════════════════════════════════════════════
   TIMEZONE HELPERS — ET ↔ UTC
   ═══════════════════════════════════════════════════════════════════ */

// Given a date+time as wall-clock Eastern values, return the matching
// UTC millisecond timestamp. Handles EDT and EST correctly across DST
// by asking Intl what the offset is on that date.
function etWallClockToUtcMs(year, month, day, hour, minute) {
  // Build a candidate UTC instant using those wall-clock components.
  // It won't be the right answer yet — it's "the moment if those numbers
  // were UTC". We adjust by the gap between that candidate and what the
  // ET timezone says the corresponding wall-clock is.
  const candidate = Date.UTC(year, month - 1, day, hour, minute);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date(candidate)).map(p => [p.type, p.value])
  );
  const renderedHour = parts.hour === '24' ? 0 : parseInt(parts.hour, 10);
  const rendered = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    renderedHour,
    parseInt(parts.minute, 10),
  );
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  return candidate + (desired - rendered);
}

// Format a UTC ms back to ET HH:MM (24h) for display in the editor.
function utcMsToEtHHMM(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms)).replace('24:', '00:');
}

// Format a UTC ms to YYYY-MM-DD in ET.
function utcMsToEtDateString(ms) {
  if (!Number.isFinite(ms)) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(ms)).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Parse a YYYY-MM-DD date string + HH:MM time string (Eastern) into UTC ms.
function etInputToUtcMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  if ([y, mo, d, h, mi].some(n => !Number.isFinite(n))) return null;
  return etWallClockToUtcMs(y, mo, d, h, mi);
}

// HH:MM string → minutes count (for block-time inputs).
function hhmmToMinutes(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function minutesToHhmm(min) {
  if (!Number.isFinite(min) || min < 0) return '00:00';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════════════
   FIRESTORE — duty-periods-v2 reads + writes
   ═══════════════════════════════════════════════════════════════════ */

const DUTY_COLLECTION = 'duty-periods-v2';

// Read all duty periods for a pilot whose dutyOnAt falls in [startMs, endMs).
async function fetchPeriodsByPilot(pilotUid, startMs, endMs) {
  const { db } = await import('./firebase.js');
  const q = query(
    collection(db, DUTY_COLLECTION),
    where('pilotUid', '==', pilotUid),
    where('dutyOnAt', '>=', startMs),
    where('dutyOnAt', '<', endMs),
  );
  const snap = await getDocs(q);
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  out.sort((a, b) => a.dutyOnAt - b.dutyOnAt);
  return out;
}

// Save a duty period. If `period.id` is provided, overwrites that doc;
// otherwise creates a new one with an auto-id.
async function saveDutyPeriod(period) {
  const { db } = await import('./firebase.js');
  const { id, ...data } = period;
  const payload = {
    ...data,
    // Audit fields — non-breaking add. Existing readers ignore them.
    updatedAt: Date.now(),
  };
  if (id) {
    // Collision-safe upsert. The old setDoc(merge:false) overwrote the whole
    // doc, so re-importing a month wiped any edits/partner links/flight-time on
    // the existing record. safeCreatePeriodDoc skips identical re-imports and,
    // on a real difference, UPDATES the time/flight fields while preserving
    // adminEdits + partnerPeriodId. Pass period.__onConflict ('skip' | 'new')
    // to change behavior from a per-day chooser.
    const { safeCreatePeriodDoc } = await import('./firebase-duty-v2.js');
    const res = await safeCreatePeriodDoc(id, { ...payload, id }, {
      onConflict: period.__onConflict || 'overwrite',
      editedBy: period.__editedBy || 'JetInsight import',
      note: 'JetInsight import',
    });
    return res.id;
  }
  payload.createdAt = Date.now();
  const ref = await addDoc(collection(db, DUTY_COLLECTION), payload);
  return ref.id;
}

async function deleteDutyPeriod(id) {
  const { db } = await import('./firebase.js');
  await deleteDoc(doc(db, DUTY_COLLECTION, id));
}

/* ═══════════════════════════════════════════════════════════════════
   JETINSIGHT PARSER
   ═══════════════════════════════════════════════════════════════════ */

// Day-of-week + ordinal-date header. Anchors each day in the paste.
const DAY_HEADER_RE = /\b(MON|TUE|WED|THU|FRI|SAT|SUN)\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;

// Flight duty header: "Flight duty 11:00 - 23:00"
const FLIGHT_DUTY_RE = /Flight\s+duty\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/i;

// Per-leg row: "11:30 - 12:36   IAD - AVL   01:06"
// Airports can be 3 or 4 letters (FAA + ICAO).
const LEG_RE =
  /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s+([A-Z]{3,4})\s*-\s*([A-Z]{3,4})\s+(\d{1,2}):(\d{2})/g;

/**
 * Parse a JetInsight Flight Duty paste into duty period objects.
 *
 * @param {string} text  Raw paste from JetInsight
 * @param {number} year  Year of the month being imported (4-digit)
 * @param {number} month 1-12 month being imported
 * @param {object} pilot { uid, name }
 * @returns {Array} Array of parsed period objects (no Firestore IDs yet)
 */
export function parseJetInsightPaste(text, year, month, pilot) {
  if (!text || !pilot?.uid) return [];

  // Anchor positions of each day header in the text. We then slice the
  // text between adjacent headers and parse each chunk independently.
  const anchors = [];
  let m;
  DAY_HEADER_RE.lastIndex = 0;
  while ((m = DAY_HEADER_RE.exec(text)) !== null) {
    anchors.push({ index: m.index, dow: m[1].toUpperCase(), day: parseInt(m[2], 10) });
  }

  const periods = [];
  for (let i = 0; i < anchors.length; i++) {
    const startIdx = anchors[i].index;
    const endIdx = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
    const chunk = text.slice(startIdx, endIdx);
    const day = anchors[i].day;

    const dutyM = chunk.match(FLIGHT_DUTY_RE);
    if (!dutyM) continue; // empty day (e.g. SAT 6th with no flight duty)

    const onH = parseInt(dutyM[1], 10);
    const onM = parseInt(dutyM[2], 10);
    const offH = parseInt(dutyM[3], 10);
    const offM = parseInt(dutyM[4], 10);

    const dutyOnAt = etWallClockToUtcMs(year, month, day, onH, onM);
    // Duty off crossing midnight: e.g. on at 14:00, off at 02:30 next
    // day. Detect by off-time numerically earlier than on-time.
    const dutyOffEndedNextDay = offH < onH || (offH === onH && offM < onM);
    const dutyOffAt = etWallClockToUtcMs(
      year, month, day + (dutyOffEndedNextDay ? 1 : 0), offH, offM,
    );

    // Walk legs. JetInsight prints them in chronological order. A leg
    // whose off-block hour is numerically less than the previous leg's
    // hour means we crossed midnight.
    const legs = [];
    let legDayOffset = 0;
    let prevHour = onH;
    LEG_RE.lastIndex = 0;
    let legM;
    while ((legM = LEG_RE.exec(chunk)) !== null) {
      const offBlockH = parseInt(legM[1], 10);
      const offBlockMM = parseInt(legM[2], 10);
      const onBlockH = parseInt(legM[3], 10);
      const onBlockMM = parseInt(legM[4], 10);
      const from = legM[5];
      const to = legM[6];
      const blockH = parseInt(legM[7], 10);
      const blockMM = parseInt(legM[8], 10);

      // Day rollover for the off-block time (start of leg)
      if (offBlockH < prevHour) legDayOffset++;
      const offBlockAt = etWallClockToUtcMs(
        year, month, day + legDayOffset, offBlockH, offBlockMM,
      );
      // On-block (end of leg) — may roll over again within the leg
      const onBlockExtraDay = onBlockH < offBlockH ? 1 : 0;
      const onBlockAt = etWallClockToUtcMs(
        year, month, day + legDayOffset + onBlockExtraDay, onBlockH, onBlockMM,
      );

      legs.push({
        from, to,
        offBlockAt, onBlockAt,
        blockTimeMs: ((blockH * 60) + blockMM) * 60 * 1000,
      });

      prevHour = onBlockH;
    }

    const flightTimeMs = legs.reduce((s, l) => s + l.blockTimeMs, 0);

    periods.push({
      pilotUid: pilot.uid,
      pilotName: pilot.name || '',
      dutyOnAt,
      dutyOffAt,
      flightTimeMs,
      legs,
      assignmentType: 'regular',
      crewType: 'two',
      tail: null,
      tripId: null,
      role: null,
      overrideStatus: null,
      extensionReason: null,
      // Audit
      importedFromJetInsight: true,
      sourceDay: day,
      sourceDow: anchors[i].dow,
    });
  }
  return periods;
}

/* ═══════════════════════════════════════════════════════════════════
   UI BITS — small reusable pieces
   ═══════════════════════════════════════════════════════════════════ */

function PilotPicker({ users, value, onChange, placeholder = 'Select pilot…' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = useMemo(
    () => users.find(u => u.uid === value) || null,
    [users, value]
  );
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter(u => u.uid && u.approved !== false)
      .filter(u => !q
        || (u.name || '').toLowerCase().includes(q)
        || (u.jetinsightName || '').toLowerCase().includes(q)
        || (u.email || '').toLowerCase().includes(q))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [users, query]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 bg-slate-950 border border-slate-700 hover:border-cyan-500/40 px-3 py-2 text-sm text-slate-100"
      >
        <span className={selected ? 'text-slate-100' : 'text-slate-500'}>
          {selected ? (selected.name || selected.email) : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-slate-900 border border-slate-700 max-h-72 overflow-y-auto">
          <div className="p-2 border-b border-slate-800 sticky top-0 bg-slate-900">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
            />
          </div>
          {candidates.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm italic">No matches</div>
          ) : (
            candidates.map(u => (
              <button
                key={u.uid}
                type="button"
                onClick={() => { onChange(u.uid); setOpen(false); setQuery(''); }}
                className={`w-full text-left p-2.5 border-b border-slate-800 last:border-b-0 hover:bg-slate-800 ${
                  u.uid === value ? 'bg-cyan-500/10' : ''
                }`}
              >
                <div className="text-sm text-slate-100">{u.name || u.email}</div>
                <div className="text-[10px] text-slate-500"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {(u.role || 'crew').toUpperCase()}
                  {u.jetinsightName && u.jetinsightName !== u.name
                    ? ` · JI: ${u.jetinsightName}`
                    : ''}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <div className="text-[10px] tracking-widest text-slate-500 mb-1"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</div>
      {children}
      {hint && <div className="text-[10px] text-slate-500 mt-1">{hint}</div>}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      type="text"
      {...props}
      className={`w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100 focus:border-cyan-500/60 outline-none ${props.className || ''}`}
    />
  );
}

/* ═══════════════════════════════════════════════════════════════════
   DAY EDITOR MODAL
   ═══════════════════════════════════════════════════════════════════ */

function DayEditorModal({ pilot, users, initial, onSave, onCancel, onDelete }) {
  const [dateStr, setDateStr] = useState(
    initial?.dutyOnAt ? utcMsToEtDateString(initial.dutyOnAt) : ''
  );
  const [dutyOnHHMM, setDutyOnHHMM] = useState(
    initial?.dutyOnAt ? utcMsToEtHHMM(initial.dutyOnAt) : ''
  );
  const [dutyOffHHMM, setDutyOffHHMM] = useState(
    initial?.dutyOffAt ? utcMsToEtHHMM(initial.dutyOffAt) : ''
  );
  const [tail, setTail] = useState(initial?.tail || '');
  const [role, setRole] = useState(initial?.role || '');
  const [legs, setLegs] = useState(
    Array.isArray(initial?.legs) && initial.legs.length > 0
      ? initial.legs.map(l => ({
          from: l.from || '',
          to: l.to || '',
          offBlockHHMM: l.offBlockAt ? utcMsToEtHHMM(l.offBlockAt) : '',
          onBlockHHMM: l.onBlockAt ? utcMsToEtHHMM(l.onBlockAt) : '',
          blockHHMM: minutesToHhmm(Math.round((l.blockTimeMs || 0) / 60000)),
        }))
      : []
  );
  const [showCopyPanel, setShowCopyPanel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const totalFlightHHMM = useMemo(
    () => minutesToHhmm(legs.reduce((s, l) => s + hhmmToMinutes(l.blockHHMM), 0)),
    [legs]
  );

  const addLeg = () => setLegs(L => [...L, {
    from: '', to: '', offBlockHHMM: '', onBlockHHMM: '', blockHHMM: '',
  }]);
  const removeLeg = i => setLegs(L => L.filter((_, idx) => idx !== i));
  const patchLeg = (i, patch) =>
    setLegs(L => L.map((l, idx) => idx === i ? { ...l, ...patch } : l));

  const handleSave = async () => {
    setErr(null);
    if (!dateStr) { setErr('Date is required.'); return; }
    if (!dutyOnHHMM) { setErr('Duty on time is required.'); return; }

    const dutyOnAt = etInputToUtcMs(dateStr, dutyOnHHMM);
    if (!dutyOnAt) { setErr('Invalid duty on time format.'); return; }

    let dutyOffAt = null;
    if (dutyOffHHMM) {
      // If duty off HH:MM is numerically less than duty on, assume next-day.
      const [onH, onM] = dutyOnHHMM.split(':').map(Number);
      const [offH, offM] = dutyOffHHMM.split(':').map(Number);
      const nextDay = offH < onH || (offH === onH && offM < onM);
      const [y, mo, d] = dateStr.split('-').map(Number);
      dutyOffAt = etWallClockToUtcMs(y, mo, d + (nextDay ? 1 : 0), offH, offM);
    }

    const builtLegs = legs
      .filter(l => l.from && l.to)
      .map(l => {
        const [y, mo, d] = dateStr.split('-').map(Number);
        let offBlockAt = null, onBlockAt = null;
        if (l.offBlockHHMM) {
          const [oh, om] = l.offBlockHHMM.split(':').map(Number);
          offBlockAt = etWallClockToUtcMs(y, mo, d, oh, om);
        }
        if (l.onBlockHHMM) {
          const [oh, om] = l.onBlockHHMM.split(':').map(Number);
          onBlockAt = etWallClockToUtcMs(y, mo, d, oh, om);
        }
        return {
          from: l.from.toUpperCase().trim(),
          to: l.to.toUpperCase().trim(),
          offBlockAt, onBlockAt,
          blockTimeMs: hhmmToMinutes(l.blockHHMM) * 60 * 1000,
        };
      });

    const flightTimeMs = builtLegs.reduce((s, l) => s + l.blockTimeMs, 0);

    const period = {
      ...(initial?.id ? { id: initial.id } : {}),
      pilotUid: pilot.uid,
      pilotName: pilot.name || '',
      dutyOnAt,
      dutyOffAt,
      flightTimeMs,
      legs: builtLegs,
      assignmentType: initial?.assignmentType || 'regular',
      crewType: initial?.crewType || 'two',
      tail: tail.trim().toUpperCase() || null,
      tripId: initial?.tripId || null,
      role: role || null,
      overrideStatus: initial?.overrideStatus || null,
      extensionReason: initial?.extensionReason || null,
      ...(initial?.importedFromJetInsight ? { importedFromJetInsight: true } : {}),
      ...(initial?.createdAt ? { createdAt: initial.createdAt } : {}),
      adminEditedAt: Date.now(),
    };

    setSaving(true);
    try {
      await onSave(period);
    } catch (e) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-3">
      <div className="w-full max-w-3xl bg-slate-900 border border-slate-700 flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between p-3 border-b border-slate-800 shrink-0">
          <h3 className="text-sm tracking-widest text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {initial?.id ? 'EDIT DUTY DAY' : 'NEW DUTY DAY'} · {pilot.name}
          </h3>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">

          {showCopyPanel && (
            <CopyFromPilotPanel
              dateStr={dateStr}
              targetPilotUid={pilot.uid}
              users={users}
              onApply={(srcPeriod) => {
                // Pre-fill from source pilot's record, keep target identity.
                setDutyOnHHMM(utcMsToEtHHMM(srcPeriod.dutyOnAt));
                setDutyOffHHMM(srcPeriod.dutyOffAt ? utcMsToEtHHMM(srcPeriod.dutyOffAt) : '');
                setTail(srcPeriod.tail || '');
                if (Array.isArray(srcPeriod.legs)) {
                  setLegs(srcPeriod.legs.map(l => ({
                    from: l.from || '',
                    to: l.to || '',
                    offBlockHHMM: l.offBlockAt ? utcMsToEtHHMM(l.offBlockAt) : '',
                    onBlockHHMM: l.onBlockAt ? utcMsToEtHHMM(l.onBlockAt) : '',
                    blockHHMM: minutesToHhmm(Math.round((l.blockTimeMs || 0) / 60000)),
                  })));
                }
                setShowCopyPanel(false);
              }}
              onClose={() => setShowCopyPanel(false)}
            />
          )}

          {/* Top metadata row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="DATE (ET)">
              <input
                type="date"
                value={dateStr}
                onChange={e => setDateStr(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              />
            </Field>
            <Field label="TAIL (OPTIONAL)">
              <TextInput
                value={tail}
                onChange={e => setTail(e.target.value)}
                placeholder="e.g. N444AM"
              />
            </Field>
            <Field label="ROLE (OPTIONAL)">
              <select
                value={role}
                onChange={e => setRole(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100"
              >
                <option value="">—</option>
                <option value="PIC">PIC</option>
                <option value="SIC">SIC</option>
              </select>
            </Field>
          </div>

          {/* Duty times */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="DUTY ON (ET HH:MM)">
              <TextInput
                value={dutyOnHHMM}
                onChange={e => setDutyOnHHMM(e.target.value)}
                placeholder="11:30"
              />
            </Field>
            <Field label="DUTY OFF (ET HH:MM)">
              <TextInput
                value={dutyOffHHMM}
                onChange={e => setDutyOffHHMM(e.target.value)}
                placeholder="23:24"
                hint=""
              />
            </Field>
            <Field label="FLIGHT TIME (HH:MM)">
              <div className="w-full bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-cyan-300"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                {totalFlightHHMM}
              </div>
            </Field>
          </div>

          {/* Copy from pilot button */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowCopyPanel(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] tracking-widest border border-cyan-500/30 hover:border-cyan-400 text-cyan-300 hover:text-cyan-200"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
              title="Copy duty data from another pilot who flew with this pilot that day"
            >
              <Copy className="w-3 h-3" /> COPY FROM PILOT
            </button>
            <div className="text-[10px] text-slate-500">
              Pull duty + legs from a crewmate who logged correctly.
            </div>
          </div>

          {/* Legs */}
          <div className="border border-slate-800 bg-slate-950/40 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs tracking-widest text-slate-300"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                LEGS ({legs.length})
              </h4>
              <button
                type="button"
                onClick={addLeg}
                className="flex items-center gap-1 px-2 py-1 text-[10px] tracking-widest border border-slate-700 hover:border-cyan-500/40 text-slate-300 hover:text-cyan-300"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                <Plus className="w-3 h-3" /> ADD LEG
              </button>
            </div>
            {legs.length === 0 ? (
              <div className="text-center text-slate-500 text-xs italic py-4">
                No legs. Add legs to compute flight time, or leave empty for ground duty.
              </div>
            ) : (
              <div className="space-y-2">
                {legs.map((leg, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-2">
                      <Field label="FROM">
                        <TextInput value={leg.from} onChange={e => patchLeg(i, { from: e.target.value })} placeholder="IAD" />
                      </Field>
                    </div>
                    <div className="col-span-2">
                      <Field label="TO">
                        <TextInput value={leg.to} onChange={e => patchLeg(i, { to: e.target.value })} placeholder="AVL" />
                      </Field>
                    </div>
                    <div className="col-span-2">
                      <Field label="OFF BLK">
                        <TextInput value={leg.offBlockHHMM} onChange={e => patchLeg(i, { offBlockHHMM: e.target.value })} placeholder="11:30" />
                      </Field>
                    </div>
                    <div className="col-span-2">
                      <Field label="ON BLK">
                        <TextInput value={leg.onBlockHHMM} onChange={e => patchLeg(i, { onBlockHHMM: e.target.value })} placeholder="12:36" />
                      </Field>
                    </div>
                    <div className="col-span-3">
                      <Field label="BLOCK TIME">
                        <TextInput value={leg.blockHHMM} onChange={e => patchLeg(i, { blockHHMM: e.target.value })} placeholder="01:06" />
                      </Field>
                    </div>
                    <div className="col-span-1 flex justify-end pb-1">
                      <button
                        type="button"
                        onClick={() => removeLeg(i)}
                        className="text-red-400 hover:text-red-300"
                        title="Remove leg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {err && (
            <div className="border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>{err}</div>
            </div>
          )}
        </div>

        <div className="p-3 border-t border-slate-800 flex items-center justify-between gap-2 shrink-0">
          <div>
            {initial?.id && (
              <button
                type="button"
                onClick={async () => {
                  if (!confirm('Delete this duty period? This cannot be undone.')) return;
                  setSaving(true);
                  try { await onDelete(initial.id); }
                  finally { setSaving(false); }
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-[11px] tracking-widest text-red-400 hover:text-red-300 border border-red-500/40 hover:border-red-400"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                <Trash2 className="w-3 h-3" /> DELETE
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 text-[11px] tracking-widest text-slate-400 hover:text-slate-200"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >CANCEL</button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950 disabled:opacity-50 inline-flex items-center gap-2"
              style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              SAVE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   COPY-FROM-PILOT PANEL (inside the day editor)
   ═══════════════════════════════════════════════════════════════════ */

function CopyFromPilotPanel({ dateStr, targetPilotUid, users, onApply, onClose }) {
  const [sourceUid, setSourceUid] = useState(null);
  const [period, setPeriod] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const candidates = users.filter(u => u.uid && u.uid !== targetPilotUid && u.approved !== false);

  useEffect(() => {
    if (!sourceUid || !dateStr) { setPeriod(null); return; }
    let cancelled = false;
    setLoading(true); setErr(null);
    (async () => {
      try {
        // Query the source pilot's duty for an ET day window. ET-midnight
        // to next ET-midnight, in UTC ms.
        const [y, mo, d] = dateStr.split('-').map(Number);
        const start = etWallClockToUtcMs(y, mo, d, 0, 0);
        const end = etWallClockToUtcMs(y, mo, d + 1, 0, 0);
        // Widen by 12h on each side to catch duty that started late prior
        // day or crossed into next day.
        const periods = await fetchPeriodsByPilot(
          sourceUid, start - 12 * 3600 * 1000, end + 12 * 3600 * 1000
        );
        if (cancelled) return;
        // Pick the one whose dutyOnAt is closest to or within this ET day.
        const inDay = periods.find(p => p.dutyOnAt >= start && p.dutyOnAt < end);
        setPeriod(inDay || periods[0] || null);
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Lookup failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceUid, dateStr]);

  return (
    <div className="border border-cyan-500/30 bg-cyan-500/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs tracking-widest text-cyan-300"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          COPY FROM ANOTHER PILOT
        </h4>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
          <X className="w-4 h-4" />
        </button>
      </div>
      <Field label={`PILOT WHO LOGGED CORRECTLY (on ${dateStr || '—'})`}>
        <PilotPicker
          users={candidates}
          value={sourceUid}
          onChange={setSourceUid}
          placeholder="Select crewmate…"
        />
      </Field>

      {loading && (
        <div className="text-slate-500 text-xs flex items-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      )}
      {err && <div className="text-red-300 text-xs">{err}</div>}

      {!loading && sourceUid && !period && (
        <div className="text-slate-500 text-xs italic">
          No duty record found for that pilot on or near {dateStr}.
        </div>
      )}

      {period && (
        <div className="bg-slate-950/60 border border-slate-800 p-2.5 space-y-1.5 text-xs">
          <div className="text-slate-300">
            <span className="text-slate-500">Duty:&nbsp;</span>
            {utcMsToEtHHMM(period.dutyOnAt)} → {period.dutyOffAt ? utcMsToEtHHMM(period.dutyOffAt) : '(open)'}
            &nbsp;ET
          </div>
          <div className="text-slate-300">
            <span className="text-slate-500">Flight time:&nbsp;</span>
            {minutesToHhmm(Math.round((period.flightTimeMs || 0) / 60000))}
          </div>
          {period.tail && (
            <div className="text-slate-300">
              <span className="text-slate-500">Tail:&nbsp;</span>{period.tail}
            </div>
          )}
          {Array.isArray(period.legs) && period.legs.length > 0 && (
            <div className="text-slate-300">
              <span className="text-slate-500">Legs:&nbsp;</span>
              {period.legs.map(l => `${l.from}→${l.to}`).join(', ')}
            </div>
          )}
          <button
            type="button"
            onClick={() => onApply(period)}
            className="mt-2 px-3 py-1.5 text-[10px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950 inline-flex items-center gap-1.5"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
          >
            <Check className="w-3 h-3" /> USE THIS DATA
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   JETINSIGHT IMPORT TAB
   ═══════════════════════════════════════════════════════════════════ */

function JetInsightImportTab({ pilot, users }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [pasteText, setPasteText] = useState('');
  const [parsed, setParsed] = useState([]); // [{period, conflict, decision: 'overwrite' | 'skip' | 'add'}]
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const [err, setErr] = useState(null);

  const handleParse = async () => {
    setErr(null); setDoneMsg('');
    if (!pilot?.uid) { setErr('Pick a pilot first.'); return; }
    if (!pasteText.trim()) { setErr('Paste JetInsight data first.'); return; }
    setParsing(true);
    try {
      const periods = parseJetInsightPaste(pasteText, year, month, pilot);
      if (periods.length === 0) {
        setErr('No duty days found. Check year/month and that the paste includes "Flight duty" rows.');
        setParsed([]);
        return;
      }
      // Check conflicts: query existing periods for this pilot across
      // the parsed range and match by ET-date.
      const minOn = Math.min(...periods.map(p => p.dutyOnAt));
      const maxOn = Math.max(...periods.map(p => p.dutyOnAt));
      const existing = await fetchPeriodsByPilot(
        pilot.uid, minOn - 24 * 3600 * 1000, maxOn + 24 * 3600 * 1000
      );
      const existingByDate = new Map();
      for (const e of existing) {
        const d = utcMsToEtDateString(e.dutyOnAt);
        if (!existingByDate.has(d)) existingByDate.set(d, []);
        existingByDate.get(d).push(e);
      }
      const rows = periods.map(p => {
        const dStr = utcMsToEtDateString(p.dutyOnAt);
        const conflicts = existingByDate.get(dStr) || [];
        return {
          period: p,
          dateStr: dStr,
          conflict: conflicts[0] || null,
          // Default: if conflict, default to overwrite; else add.
          decision: conflicts[0] ? 'overwrite' : 'add',
        };
      });
      setParsed(rows);
    } catch (e) {
      setErr(e?.message || 'Parse failed');
    } finally {
      setParsing(false);
    }
  };

  const handleImport = async () => {
    setErr(null); setDoneMsg('');
    setImporting(true);
    let written = 0, skipped = 0;
    try {
      for (const row of parsed) {
        if (row.decision === 'skip') { skipped++; continue; }
        if (row.decision === 'overwrite' && row.conflict?.id) {
          await saveDutyPeriod({ ...row.period, id: row.conflict.id });
        } else {
          await saveDutyPeriod(row.period);
        }
        written++;
      }
      setDoneMsg(`Imported ${written} day${written === 1 ? '' : 's'}${skipped > 0 ? `, skipped ${skipped}` : ''}.`);
      setParsed([]);
      setPasteText('');
    } catch (e) {
      setErr(e?.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="YEAR">
          <TextInput
            value={year}
            onChange={e => setYear(parseInt(e.target.value, 10) || now.getFullYear())}
          />
        </Field>
        <Field label="MONTH (1–12)">
          <TextInput
            value={month}
            onChange={e => setMonth(Math.max(1, Math.min(12, parseInt(e.target.value, 10) || 1)))}
          />
        </Field>
      </div>

      <Field
        label="PASTE JETINSIGHT FLIGHT-DUTY TEXT"
        hint="Copy the entire visible week or month from portal.jetinsight.com. Headers like 'MON 1st' through 'SUN 7th' anchor each day."
      >
        <textarea
          value={pasteText}
          onChange={e => setPasteText(e.target.value)}
          rows={10}
          className="w-full bg-slate-950 border border-slate-700 p-2 text-xs text-slate-100 font-mono focus:border-cyan-500/60 outline-none"
          placeholder="MON 1st
Flight duty   11:00 - 23:00
13.0   5.3   11.0
11:30 - 12:36   IAD - AVL   01:06
…"
        />
      </Field>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleParse}
          disabled={parsing || importing || !pilot?.uid}
          className="px-4 py-2 text-[11px] tracking-widest border border-cyan-500/40 hover:border-cyan-400 text-cyan-300 hover:text-cyan-200 disabled:opacity-50 inline-flex items-center gap-2"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          {parsing && <Loader2 className="w-3 h-3 animate-spin" />}
          PARSE PREVIEW
        </button>
        {parsed.length > 0 && (
          <button
            type="button"
            onClick={handleImport}
            disabled={importing}
            className="px-4 py-2 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950 disabled:opacity-50 inline-flex items-center gap-2"
            style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
          >
            {importing && <Loader2 className="w-3 h-3 animate-spin" />}
            IMPORT {parsed.filter(r => r.decision !== 'skip').length} DAY{parsed.filter(r => r.decision !== 'skip').length === 1 ? '' : 'S'}
          </button>
        )}
      </div>

      {err && (
        <div className="border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>{err}</div>
        </div>
      )}
      {doneMsg && (
        <div className="border border-cyan-500/40 bg-cyan-500/10 p-2 text-xs text-cyan-300 flex items-start gap-2">
          <Check className="w-4 h-4 shrink-0 mt-0.5" />
          <div>{doneMsg}</div>
        </div>
      )}

      {parsed.length > 0 && (
        <div className="border border-slate-800 bg-slate-950/40">
          <div className="p-3 border-b border-slate-800 text-xs tracking-widest text-slate-300"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            PARSED DAYS — REVIEW & RESOLVE CONFLICTS
          </div>
          <div className="divide-y divide-slate-800">
            {parsed.map((row, i) => {
              const legSummary = row.period.legs?.length
                ? row.period.legs.map(l => `${l.from}→${l.to}`).join(' · ')
                : '(no legs)';
              return (
                <div key={i} className="p-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-100">
                      <span className="text-slate-500 text-[10px] tracking-widest mr-2"
                        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {row.period.sourceDow} {row.dateStr}
                      </span>
                      {utcMsToEtHHMM(row.period.dutyOnAt)} → {row.period.dutyOffAt ? utcMsToEtHHMM(row.period.dutyOffAt) : '(open)'} ET
                      &nbsp;·&nbsp;FT {minutesToHhmm(Math.round((row.period.flightTimeMs || 0) / 60000))}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{legSummary}</div>
                    {row.conflict && (
                      <div className="text-[11px] text-yellow-400 mt-1 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        Existing record on this date: {utcMsToEtHHMM(row.conflict.dutyOnAt)} → {row.conflict.dutyOffAt ? utcMsToEtHHMM(row.conflict.dutyOffAt) : '(open)'}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    <select
                      value={row.decision}
                      onChange={e => setParsed(P => P.map((r, idx) => idx === i ? { ...r, decision: e.target.value } : r))}
                      className="bg-slate-950 border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                    >
                      {row.conflict ? (
                        <>
                          <option value="overwrite">OVERWRITE</option>
                          <option value="skip">SKIP</option>
                        </>
                      ) : (
                        <>
                          <option value="add">ADD NEW</option>
                          <option value="skip">SKIP</option>
                        </>
                      )}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ADD/EDIT TAB — list of recent periods + editor
   ═══════════════════════════════════════════════════════════════════ */

function EditDutyTab({ pilot, users }) {
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null); // null | period | 'NEW'
  const [err, setErr] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!pilot?.uid) { setPeriods([]); return; }
    let cancelled = false;
    setLoading(true); setErr(null);
    (async () => {
      try {
        // Last 90 days. Admin can re-pick pilot to refresh further back
        // if needed; we keep it bounded for performance.
        const end = Date.now() + 7 * 24 * 3600 * 1000; // include near-future scheduled
        const start = end - 90 * 24 * 3600 * 1000;
        const list = await fetchPeriodsByPilot(pilot.uid, start, end);
        if (!cancelled) setPeriods(list.reverse()); // newest first
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Load failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pilot?.uid, refreshTick]);

  const onSavePeriod = async (period) => {
    const id = await saveDutyPeriod(period);
    setEditing(null);
    setRefreshTick(n => n + 1);
    return id;
  };
  const onDeletePeriod = async (id) => {
    await deleteDutyPeriod(id);
    setEditing(null);
    setRefreshTick(n => n + 1);
  };

  if (!pilot?.uid) {
    return (
      <div className="text-center text-slate-500 text-sm italic py-10">
        Pick a pilot above to see and edit their duty records.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-400">
          Last 90 days · {periods.length} record{periods.length === 1 ? '' : 's'}
        </div>
        <button
          type="button"
          onClick={() => setEditing('NEW')}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] tracking-widest bg-cyan-500 hover:bg-cyan-400 text-slate-950"
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}
        >
          <Plus className="w-3 h-3" /> ADD DUTY DAY
        </button>
      </div>

      {loading && (
        <div className="text-center text-slate-500 text-xs py-6 flex items-center justify-center gap-2">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      )}
      {err && (
        <div className="border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">{err}</div>
      )}

      {!loading && periods.length === 0 && !err && (
        <div className="text-center text-slate-500 text-sm italic py-8">
          No duty records in the last 90 days. Use ADD DUTY DAY or the IMPORT tab.
        </div>
      )}

      <div className="space-y-1.5">
        {periods.map(p => (
          <div
            key={p.id}
            className="border border-slate-800 bg-slate-950/40 hover:border-cyan-500/30 p-3 flex items-center justify-between gap-3 cursor-pointer"
            onClick={() => setEditing(p)}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm text-slate-100">
                <span className="text-slate-500 text-[10px] tracking-widest mr-2"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {utcMsToEtDateString(p.dutyOnAt)}
                </span>
                {utcMsToEtHHMM(p.dutyOnAt)} → {p.dutyOffAt ? utcMsToEtHHMM(p.dutyOffAt) : <span className="text-cyan-400">(open)</span>}
                {' '}ET
                &nbsp;·&nbsp;FT {minutesToHhmm(Math.round((p.flightTimeMs || 0) / 60000))}
                {p.tail && <>&nbsp;·&nbsp;<span className="text-slate-300">{p.tail}</span></>}
                {p.role && <>&nbsp;·&nbsp;<span className="text-slate-400">{p.role}</span></>}
              </div>
              {Array.isArray(p.legs) && p.legs.length > 0 && (
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {p.legs.map(l => `${l.from}→${l.to}`).join(' · ')}
                </div>
              )}
              {p.importedFromJetInsight && (
                <div className="text-[10px] text-cyan-500/70 mt-0.5">imported from JetInsight</div>
              )}
            </div>
            <Edit2 className="w-4 h-4 text-slate-500 shrink-0" />
          </div>
        ))}
      </div>

      {editing && (
        <DayEditorModal
          pilot={pilot}
          users={users}
          initial={editing === 'NEW' ? null : editing}
          onSave={onSavePeriod}
          onCancel={() => setEditing(null)}
          onDelete={onDeletePeriod}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN MODAL
   ═══════════════════════════════════════════════════════════════════ */

export default function AdminDutyTools({ users, onClose }) {
  const [pilotUid, setPilotUid] = useState(null);
  const [tab, setTab] = useState('edit'); // 'edit' | 'import'

  const pilot = useMemo(() => {
    const u = users.find(x => x.uid === pilotUid);
    return u ? { uid: u.uid, name: u.name || u.email || u.uid } : null;
  }, [users, pilotUid]);

  return (
    <div className="fixed inset-0 bg-black/70 z-40 flex items-center justify-center p-3">
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 flex flex-col max-h-[95vh]">
        <div className="flex items-center justify-between p-3 border-b border-slate-800 shrink-0">
          <h2 className="text-sm tracking-widest text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            ADMIN DUTY TOOLS
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Pilot picker — required first step */}
        <div className="p-4 border-b border-slate-800 shrink-0 bg-slate-950/40">
          <Field
            label="PILOT"
            hint="Required. Everything below operates on this pilot's duty records."
          >
            <PilotPicker users={users} value={pilotUid} onChange={setPilotUid} />
          </Field>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 shrink-0">
          <button
            type="button"
            onClick={() => setTab('edit')}
            className={`flex items-center gap-2 px-4 py-3 text-xs tracking-widest border-b-2 ${
              tab === 'edit'
                ? 'text-cyan-400 border-cyan-400'
                : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Calendar className="w-3.5 h-3.5" />
            ADD / EDIT DAYS
          </button>
          <button
            type="button"
            onClick={() => setTab('import')}
            className={`flex items-center gap-2 px-4 py-3 text-xs tracking-widest border-b-2 ${
              tab === 'import'
                ? 'text-cyan-400 border-cyan-400'
                : 'text-slate-500 border-transparent hover:text-slate-300'
            }`}
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Upload className="w-3.5 h-3.5" />
            IMPORT JETINSIGHT
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {tab === 'edit' && <EditDutyTab pilot={pilot} users={users} />}
          {tab === 'import' && (
            pilot
              ? <JetInsightImportTab pilot={pilot} users={users} />
              : (
                <div className="text-center text-slate-500 text-sm italic py-10">
                  Pick a pilot above to enable importing.
                </div>
              )
          )}
        </div>

        <div className="p-3 border-t border-slate-800 shrink-0 text-[10px] text-slate-500"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          ALL TIMES ENTERED ARE EASTERN (ET). STORED AS UTC.
          &nbsp;·&nbsp;
          COLLECTION: duty-periods-v2
        </div>
      </div>
    </div>
  );
}
