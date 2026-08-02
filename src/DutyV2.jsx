// src/DutyV2.jsx
//
// =====================================================================
// PILOT DUTY CONSOLE (V2)
// =====================================================================
//
// What this is:
//   - Big green DUTY ON button — opens a confirmation form
//   - Big red DUTY OFF button — opens an end-of-duty form
//   - Live duty timer with color-coded warning bar
//   - Legality status panel (LEGAL / WARNING / ILLEGAL) computed from
//     all the pilot's recent periods + outside flying
//   - History strip with editable past periods
//   - Outside commercial flying logger (separate compact section)
//
// What this is NOT:
//   - It does not enforce blocking on the pilot side. If the engine
//     says illegal, the pilot can still record duty (we want the data
//     captured) but the UI shows a giant red banner and requires
//     acknowledgment + override request before submission.
//
// Data sources:
//   - firebase-duty-v2.js for all reads/writes
//   - duty-legality.js for the legality computation
//
// Audit:
//   - Every action goes through firebase-duty-v2 which appends to
//     adminEdits[]. This UI never writes directly to Firestore.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Square, AlertTriangle, CheckCircle2, Edit3, Plus, X,
  ChevronDown, ChevronUp, Clock, Plane, MapPin, Shield, Users, UserCheck,
  Hourglass, XCircle,
} from 'lucide-react';
import {
  subscribePeriodsForPilot,
  subscribeOutsideFlyingForPilot,
  startDuty as fbStartDuty,
  startDutyPair as fbStartDutyPair,
  confirmPendingDuty as fbConfirmPendingDuty,
  declinePendingDuty as fbDeclinePendingDuty,
  endDuty as fbEndDuty,
  endDutyPair as fbEndDutyPair,
  editPeriod as fbEditPeriod,
  requestOverride as fbRequestOverride,
  addOutsideFlying as fbAddOutsideFlying,
} from './firebase-duty-v2.js';
import { evaluateCurrent, LIMITS } from './duty-legality.js';
import { DutyExportButtons } from './DutyExport.jsx';
import TzAwareDateTimeInput from './TzAwareInput.jsx';
import { Button, Card, InfoRow, StatusChip, cx } from './ui.jsx';

const MS_HR = 3600 * 1000;
const MS_DAY = 24 * MS_HR;

// ---- Time formatting helpers ----

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function fmtTime(t) {
  if (!t) return '—';
  const d = t instanceof Date ? t : new Date(t);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function roundToFive(d = new Date()) {
  return new Date(Math.round(d.getTime() / 300000) * 300000);
}

function toLocalInputValue(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInputValue(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

// =====================================================================
// FUZZY NAME MATCH — find a crew user from a trip's SIC name string
// =====================================================================
//
// Trip data has `info.sic` as a free-text name string from JetInsight,
// e.g. "Nicholas Riley Albritton". We want to find the matching user
// account so we can create a paired duty period for them.
//
// Algorithm — keep it deliberately simple and conservative:
//   1. Tokenize both names: split on whitespace, lowercase, strip
//      punctuation, drop tokens of length 1 (middle initials etc).
//   2. Score each candidate user by COUNT of overlapping tokens
//      between input and user's display name.
//   3. Return best match only if:
//        - score >= 2  (must share at least 2 name tokens — typically
//          first + last; resists false matches on just a last name)
//        - AND the gap between best and second-best score is >= 1
//          (i.e. one match is clearly better than another)
//   4. Otherwise return null and let the PIC pick from dropdown.
//
// This is intentionally biased toward "ask the PIC" over "guess wrong."
// The penalty for a wrong auto-match is that the PIC creates a duty
// period for the wrong pilot, who would then have to decline. Better
// to show a dropdown than risk wrong matches.

function tokenizeName(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')           // strip punctuation, keep letters
    .split(/\s+/)
    .filter(t => t.length >= 2);            // drop initials and empty tokens
}

function nameOf(user) {
  return user?.name || user?.displayName || user?.email || '';
}

export function matchUserByName(nameString, candidateUsers) {
  const target = tokenizeName(nameString);
  if (target.length < 2) return null;          // need at least 2 tokens to match
  if (!Array.isArray(candidateUsers) || candidateUsers.length === 0) return null;

  const targetSet = new Set(target);
  const scored = candidateUsers.map(u => {
    const tokens = tokenizeName(nameOf(u));
    const overlap = tokens.filter(t => targetSet.has(t)).length;
    return { user: u, score: overlap, total: tokens.length };
  });
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  if (!best || best.score < 2) return null;       // not enough overlap
  if (second && best.score - second.score < 1) {
    // ambiguous — two users tied (e.g. two pilots named "John")
    return null;
  }
  return { user: best.user, confidence: best.score };
}

// ---- Top-level component ----

export default function DutyV2({ currentUser, myTrips = [], users = [] }) {
  const uid = currentUser?.uid || currentUser?.id;
  const name = currentUser?.name || currentUser?.displayName || 'Unknown';

  const [periods, setPeriods] = useState([]);
  const [outside, setOutside] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Live timer — tick every 30s so elapsed counters stay current.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to this pilot's periods + outside flying.
  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    const unsubA = subscribePeriodsForPilot(uid, (list) => {
      setPeriods(list);
      setLoading(false);
    });
    const unsubB = subscribeOutsideFlyingForPilot(uid, setOutside);
    return () => { unsubA(); unsubB(); };
  }, [uid]);

  // The current period is the one with status='on'. There should be
  // The current period is the one with status='on'. There should be
  // at most one at any time (startDuty enforces this).
  //
  // PAIRING NOTE: a pending period (confirmStatus='pending', created
  // for this pilot by a partner's startDutyPair) has status='on' but
  // is NOT a real active duty period yet. We separate the two so the
  // UI can render a confirmation card for pending and an OnDutyCard
  // only for self-attested.
  const current = useMemo(
    () => periods.find(p => p.status === 'on' && p.confirmStatus !== 'pending' && p.confirmStatus !== 'declined') || null,
    [periods]
  );
  const pending = useMemo(
    () => periods.find(p => p.status === 'on' && p.confirmStatus === 'pending') || null,
    [periods]
  );
  // Look up the partner's pending/active period so the PIC can see
  // "SIC has not yet confirmed" on their own card. Optional — not
  // critical for compliance, but useful for situational awareness.
  const partnerPeriod = useMemo(() => {
    if (!current?.partnerPeriodId) return null;
    return periods.find(p => p.id === current.partnerPeriodId) || null;
  }, [periods, current?.partnerPeriodId]);

  // Compute legality for the pilot's current state. This drives the
  // top-of-card status pill and the warnings panel. Note: the engine
  // automatically excludes pending/declined periods, so a SIC sitting
  // on a pending invite sees their PRE-pair legality (which is correct
  // — they're not legally on duty until they confirm).
  const legality = useMemo(
    () => evaluateCurrent(periods, outside, now,
      // crewType defaults to 'two' here; will be re-evaluated per period
      // for legality of the active period itself
      current?.crewType || 'two'),
    [periods, outside, now, current?.crewType]
  );

  // UI form state. Single source of truth — only one form is open at a time.
  // 'start' | 'end' | `edit:${periodId}:${field}` | 'override' | 'outside' | null
  const [openForm, setOpenForm] = useState(null);

  // ---- Handlers (wrap firebase functions, surface errors) ----

  const doStart = async (opts) => {
    setBusy(true); setError(null);
    try {
      // If the form's submission includes a partner, this is a paired
      // duty start: PIC immediately on-duty, SIC gets a pending record.
      // Otherwise normal single-pilot flow.
      if (opts.partner && opts.partner.pilotUid) {
        const partner = opts.partner;
        const picOpts = { ...opts, pilotUid: uid, pilotName: name };
        delete picOpts.partner;
        const sicOpts = {
          pilotUid: partner.pilotUid,
          pilotName: partner.pilotName,
          // SIC inherits dutyOnAt + priorRest as defaults; SIC adjusts on confirm
          priorRestMs: opts.priorRestMs,
        };
        await fbStartDutyPair(picOpts, sicOpts);
      } else {
        await fbStartDuty({ pilotUid: uid, pilotName: name, ...opts });
      }
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to start duty');
    } finally { setBusy(false); }
  };

  // SIC confirms a pending pair — flips confirmStatus and attests fit-for-duty.
  const doConfirmPending = async (opts) => {
    if (!pending?.id) return;
    setBusy(true); setError(null);
    try {
      await fbConfirmPendingDuty(pending.id, { ...opts, confirmedBy: name });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to confirm');
    } finally { setBusy(false); }
  };

  // SIC declines — marks period declined, drops out of active duty queries.
  const doDeclinePending = async (reason) => {
    if (!pending?.id) return;
    setBusy(true); setError(null);
    try {
      await fbDeclinePendingDuty(pending.id, { reason });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to decline');
    } finally { setBusy(false); }
  };

  const doEnd = async (opts) => {
    if (!current?.id) return;
    setBusy(true); setError(null);
    try {
      // endDutyPair closes BOTH paired pilots atomically (server-side) so the
      // partner doesn't get stranded on duty. Falls back to a clear error if
      // the endpoint is unreachable.
      await fbEndDutyPair(current.id, { ...opts, endedBy: name });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to end duty');
    } finally { setBusy(false); }
  };

  const doEdit = async (periodId, field, value, note) => {
    setBusy(true); setError(null);
    try {
      await fbEditPeriod(periodId, field, value, { editedBy: name, note });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to update');
    } finally { setBusy(false); }
  };

  const doRequestOverride = async (reason) => {
    if (!current?.id) return;
    setBusy(true); setError(null);
    try {
      await fbRequestOverride(current.id, { requestedBy: name, reason });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to request override');
    } finally { setBusy(false); }
  };

  const doAddOutside = async (opts) => {
    setBusy(true); setError(null);
    try {
      await fbAddOutsideFlying({ pilotUid: uid, pilotName: name, ...opts });
      setOpenForm(null);
    } catch (e) {
      setError(e.message || 'Failed to log outside flying');
    } finally { setBusy(false); }
  };

  if (loading) {
    return (
      <Card>
        <div className="text-2xs text-content-muted">Loading duty…</div>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger-border bg-danger-soft px-3 py-2.5">
          <span className="text-2xs text-danger">{error}</span>
          <button onClick={() => setError(null)} className="text-danger hover:opacity-70" aria-label="Dismiss">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Legality sits inside the on-duty view (under the clock, where the
          pilot is already looking). Off duty and pending states show it here. */}
      {!current && <LegalityPanel legality={legality} />}

      {/* Active state card — three branches:
          1. PENDING: someone (the PIC) auto-enrolled this pilot. They
             see a confirmation card with one CONFIRM tap.
          2. CURRENT (self-attested on duty): normal on-duty card.
          3. Neither: off-duty / available card. */}
      {pending ? (
        <PendingConfirmCard
          period={pending}
          now={now}
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          onConfirm={doConfirmPending}
          onDecline={doDeclinePending}
        />
      ) : current ? (
        <OnDutyCard
          period={current}
          now={now}
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          legality={legality}
          partnerPeriod={partnerPeriod}
          onEnd={doEnd}
          onEdit={doEdit}
          onRequestOverride={doRequestOverride}
        />
      ) : (
        <OffDutyCard
          busy={busy}
          openForm={openForm}
          setOpenForm={setOpenForm}
          periods={periods}
          now={now}
          onStart={doStart}
          myTrips={myTrips}
          users={users}
          currentUserUid={uid}
        />
      )}

      {/* Outside flying section */}
      <OutsideFlyingSection
        outside={outside}
        busy={busy}
        openForm={openForm}
        setOpenForm={setOpenForm}
        onAdd={doAddOutside}
      />

      {/* History strip */}
      <DutyHistoryStrip
        periods={periods.filter(p => p.id !== current?.id && p.id !== pending?.id)}
        busy={busy}
        openForm={openForm}
        setOpenForm={setOpenForm}
        onEdit={doEdit}
      />

      {/* Export your own duty records — CSV or printable PDF. Defaults
          to last 365 days (Skyway retention). For custom date ranges
          or another pilot's records, use the EXPORT button on the
          ops crew board. */}
      <div className="border-t border-edge pt-3">
        <div className="mb-2 text-2xs font-semibold text-content-muted">Export your duty records</div>
        <DutyExportButtons pilotUid={uid} pilotName={name} />
      </div>
    </div>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

function legalityTone(status) {
  if (status === 'illegal') return 'danger';
  if (status === 'warning') return 'warning';
  return 'success';
}

function legalityLabel(status) {
  if (status === 'illegal') return 'Illegal';
  if (status === 'warning') return 'Caution';
  return 'Legal';
}

/**
 * FAR 135 state. When everything is clear this is a single chip — the whole
 * point is that "legal" needs one glance, not a panel. Findings only expand
 * into a list when there is actually something to read.
 */
function LegalityPanel({ legality, align = 'left' }) {
  const tone = legalityTone(legality.status);
  const visibleChecks = legality.checks.filter(c => c.severity !== 'info');

  if (visibleChecks.length === 0) {
    return (
      <div className={cx('flex', align === 'center' ? 'justify-center' : 'justify-start')}>
        <StatusChip tone={tone} icon={tone === 'success' ? CheckCircle2 : AlertTriangle} size="lg">
          {legalityLabel(legality.status)}
        </StatusChip>
      </div>
    );
  }

  return (
    <Card className={cx(
      'p-3',
      tone === 'danger' ? 'border-danger-border bg-danger-soft' : 'border-warning-border bg-warning-soft',
    )}>
      <div className="flex items-center gap-2">
        <Shield className={cx('h-4 w-4 shrink-0', tone === 'danger' ? 'text-danger' : 'text-warning')} />
        <span className="text-sm font-semibold text-content">{legalityLabel(legality.status)}</span>
        <span className="ml-auto text-2xs text-content-muted">{legality.summary}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {visibleChecks.map((c, i) => (
          <div key={i} className="flex items-start gap-2 text-2xs leading-relaxed text-content-muted">
            <AlertTriangle className={cx(
              'mt-0.5 h-3 w-3 shrink-0',
              c.severity === 'block' ? 'text-danger' : 'text-warning',
            )} />
            <span>{c.message}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Duty clock. A conic-gradient arc rather than an SVG ring: one element,
 * no viewBox math, and it inherits the theme tokens directly.
 */
function DutyRing({ elapsedMs, maxMs, label }) {
  const pct = Math.max(0, Math.min(100, (elapsedMs / maxMs) * 100));
  const over = elapsedMs >= maxMs;
  return (
    <div
      className="relative mx-auto flex aspect-square w-[min(168px,45vw)] shrink-0 items-center justify-center rounded-full"
      style={{
        background: `conic-gradient(${over ? 'var(--sw-danger)' : 'var(--sw-accent)'} ${pct * 3.6}deg, var(--sw-surface-raised) 0deg)`,
      }}
      role="img"
      aria-label={`${label} of ${Math.round(maxMs / MS_HR)} hours maximum`}
    >
      <div className="absolute inset-[10px] rounded-full bg-surface" />
      <div className="relative z-[1] text-center">
        <div className={cx(
          'font-mono text-4xl font-semibold tabular-nums tracking-tight',
          over ? 'animate-pulse text-danger' : 'text-content',
        )}>
          {label}
        </div>
        <div className="mt-1.5 text-2xs text-content-muted">of {Math.round(maxMs / MS_HR)}:00 max</div>
      </div>
    </div>
  );
}

/** `06:42` — the ring reads as a clock, so it gets clock formatting. */
function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 60000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function OffDutyCard({ busy, openForm, setOpenForm, periods, now, onStart, myTrips, users, currentUserUid }) {
  const starting = openForm === 'start';
  // Show rest-status info: if most-recent closed period ended within
  // 10 hours, the pilot is technically still resting.
  const lastClosed = periods.find(p => p.status === 'off');
  const restAvailableMs = lastClosed?.dutyOffAt
    ? (now - lastClosed.dutyOffAt)
    : null;

  // The rest line is the only thing a pilot needs before tapping Start, so
  // it sits under the button as a caption rather than in a header subtitle.
  const restCaption = restAvailableMs != null
    ? `Last duty ended ${fmtElapsed(restAvailableMs)} ago${restAvailableMs >= 10 * MS_HR ? ' — legal' : ''}`
    : 'No recorded duty in the last 30 days';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-content">Duty</h3>
        <StatusChip tone="neutral">Off duty</StatusChip>
      </div>
      {!starting && (
        <>
          <Button
            onClick={() => setOpenForm('start')}
            disabled={busy}
            variant="success"
            size="xl"
            block
            icon={Play}
          >
            Start Duty
          </Button>
          <p className={cx(
            'mt-2.5 text-center text-2xs',
            restAvailableMs != null && restAvailableMs < 10 * MS_HR ? 'text-warning' : 'text-content-muted',
          )}>
            {restCaption}
          </p>
        </>
      )}
      {starting && (
        <StartDutyForm
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onConfirm={onStart}
          myTrips={myTrips}
          users={users}
          currentUserUid={currentUserUid}
        />
      )}
    </Card>
  );
}

function OnDutyCard({ period, now, busy, openForm, setOpenForm, legality, partnerPeriod, onEnd, onEdit, onRequestOverride }) {
  const elapsed = now - (period.dutyOnAt || now);
  const elapsedHrs = elapsed / MS_HR;

  // Duty-budget math — used for the ring + countdown.
  //
  // DUTY_MAX_MS represents the 14h cap from 135.267(c). For regular
  // assignments this is the legal limit; for unscheduled (135.267(b))
  // there is no 14h cap — the bar/countdown are informational only.
  // We always render the bar so the pilot has a visual sense of how
  // long they've been on, regardless of assignment type.
  const DUTY_MAX_MS = 14 * MS_HR;
  const remainingMs = Math.max(0, DUTY_MAX_MS - elapsed);
  const isRegular = period.assignmentType === 'regular';
  // The countdown label changes by assignment type so the pilot
  // doesn't read "X left" as a regulatory commitment for unscheduled.
  const remainingLabel = isRegular ? 'LEFT' : 'TO 14H REF';

  const ending = openForm === 'end';
  const editingOn = openForm === `edit:${period.id}:dutyOnAt`;
  const requestingOverride = openForm === 'override';

  // Partner status — visible to the PIC after a paired-duty start.
  // If the partner's period is still pending, the PIC sees a banner
  // reminding them their SIC has not yet confirmed fit-for-duty.
  // If declined, banner shows the SIC declined and the PIC is now solo.
  const partnerStatus = partnerPeriod?.confirmStatus;
  const partnerNeedsConfirm = partnerStatus === 'pending';
  const partnerDeclined = partnerStatus === 'declined';

  return (
    <div className="space-y-3.5">
      {/* The clock is the screen. Everything else is supporting detail. */}
      <DutyRing elapsedMs={elapsed} maxMs={DUTY_MAX_MS} label={fmtClock(elapsed)} />

      <LegalityPanel legality={legality} align="center" />

      <p className="text-center text-2xs text-content-muted">
        {elapsedHrs < 14
          ? <><span className="font-mono text-content">{fmtElapsed(remainingMs)}</span> {remainingLabel.toLowerCase()} · {period.assignmentType === 'regular' ? '14-hour regular assignment' : 'Unscheduled assignment'}</>
          : <span className="text-danger">{fmtElapsed(elapsed - DUTY_MAX_MS)} over 14 hours — an approved override is required to continue.</span>}
      </p>

      {/* Three rows, because these are the three numbers a pilot is actually
          checking. Tail, base and seat are identity, not state — they go in
          the caption underneath. */}
      <Card padded={false} className="divide-y divide-edge overflow-hidden">
        <InfoRow icon={Clock} label="Started" value={fmtTime(period.dutyOnAt)} />
        <InfoRow icon={Hourglass} label="Rest before" value={period.priorRestMs ? fmtElapsed(period.priorRestMs) : '—'} />
        <InfoRow
          icon={Plane}
          label="Flight time today"
          value={period.flightTimeMs ? (period.flightTimeMs / MS_HR).toFixed(1) : '0.0'}
        />
      </Card>

      {(period.tail || period.location || period.role) && (
        <p className="text-center font-mono text-2xs text-content-muted">
          {[period.tail, period.location, period.role].filter(Boolean).join(' · ')}
        </p>
      )}

      {/* Partner status banner — only visible when this is a paired duty.
          Three states: confirmed (subtle info), pending (amber warning),
          declined (red, partner backed out — PIC is now effectively solo). */}
      {partnerPeriod && (
        <div className={`text-2xs px-3 py-2.5 rounded-lg border flex items-start gap-2 ${
          partnerNeedsConfirm
            ? 'border-warning-border bg-warning-soft text-warning'
            : partnerDeclined
              ? 'border-danger-border bg-danger-soft text-danger'
              : 'border-success-border bg-success-soft text-success'
        }`}>
          {partnerNeedsConfirm && (
            <>
              <Hourglass className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span><strong>{partnerPeriod.pilotName}</strong> has not confirmed pending duty yet.</span>
            </>
          )}
          {partnerDeclined && (
            <>
              <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span><strong>{partnerPeriod.pilotName}</strong> declined the pair. You are flying single-pilot.</span>
            </>
          )}
          {!partnerNeedsConfirm && !partnerDeclined && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>Paired with <strong>{partnerPeriod.pilotName}</strong> ({partnerPeriod.role || 'SIC'})</span>
            </>
          )}
        </div>
      )}

      {editingOn && (
        <InlineTimeEditor
          label="ADJUST DUTY-ON TIME"
          initialMs={period.dutyOnAt}
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onSave={(ms, note) => onEdit(period.id, 'dutyOnAt', ms, note)}
        />
      )}

      {/* Override request when illegal */}
      {legality.status === 'illegal' && period.overrideStatus !== 'approved' && !requestingOverride && !ending && !editingOn && (
        <Card className="border-danger-border bg-danger-soft p-3">
          <div className="text-sm font-semibold text-danger">Override required</div>
          <p className="mt-1 text-2xs leading-relaxed text-content-muted">
            Continuing duty in this state requires written approval from your Chief Pilot or Director of Operations.
          </p>
          {period.overrideStatus === 'requested' ? (
            <p className="mt-2 text-2xs text-warning">
              Requested by {period.overrideRequestedBy} at {fmtTime(period.overrideRequestedAt)} — awaiting CP/DO approval.
            </p>
          ) : (
            <Button variant="danger-outline" size="sm" className="mt-2.5" onClick={() => setOpenForm('override')}>
              Request override
            </Button>
          )}
        </Card>
      )}
      {requestingOverride && (
        <OverrideRequestForm
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onConfirm={onRequestOverride}
        />
      )}

      {/* End duty */}
      {!ending && !editingOn && !requestingOverride && (
        <>
          <Button
            onClick={() => setOpenForm('end')}
            disabled={busy}
            variant="danger"
            size="xl"
            block
            icon={Square}
          >
            End Duty
          </Button>
          <button
            type="button"
            onClick={() => setOpenForm(`edit:${period.id}:dutyOnAt`)}
            className="mx-auto flex items-center gap-1.5 text-2xs text-content-subtle transition-colors hover:text-accent"
          >
            <Edit3 className="h-3 w-3" /> Adjust duty-on time
          </button>
        </>
      )}
      {ending && (
        <EndDutyForm
          period={period}
          busy={busy}
          onCancel={() => setOpenForm(null)}
          onConfirm={onEnd}
        />
      )}
    </div>
  );
}

// =====================================================================
// PendingConfirmCard — SIC sees this when PIC auto-enrolled them
// =====================================================================
//
// Shown to the SIC when their partner (PIC) has called startDutyPair
// and created a pending duty period for them. The SIC reviews the
// PIC's details, adjusts prior rest if needed, attests fit-for-duty,
// and taps CONFIRM. Or they can DECLINE if for any reason they aren't
// actually flying this trip.
//
// Confirming flips confirmStatus → 'self-attested' and the legality
// engine immediately starts counting this period. Declining sets
// confirmStatus → 'declined' and the doc remains as an audit trail.

function PendingConfirmCard({ period, now, busy, openForm, setOpenForm, onConfirm, onDecline }) {
  // Inherit prior rest from PIC's submission as the default. SIC can
  // override if their actual rest was different.
  const inheritedPriorRestHrs = period.priorRestMs
    ? (period.priorRestMs / MS_HR).toFixed(1)
    : '10';
  const [priorRestHours, setPriorRestHours] = useState(inheritedPriorRestHrs);
  const [fitForDuty, setFitForDuty] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');

  const priorRestMs = (() => {
    const n = parseFloat(priorRestHours);
    return Number.isFinite(n) && n >= 0 ? n * MS_HR : null;
  })();

  // Time since PIC initiated — informational
  const elapsedSinceInitiated = now - (period.createdAt || period.dutyOnAt || now);

  return (
    <div className="border border-cyan-500/50 bg-cyan-500/5 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-cyan-400" />
          <span className="text-[10px] tracking-widest text-cyan-300" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>
            PENDING DUTY CONFIRMATION
          </span>
        </div>
        <span className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {elapsedSinceInitiated >= 0 && elapsedSinceInitiated < 86400000
            ? `${fmtElapsed(elapsedSinceInitiated)} ago`
            : ''}
        </span>
      </div>

      <div className="text-sm text-slate-200 mb-3">
        Your captain started a paired duty period. Review and confirm to go on duty.
      </div>

      {/* PIC's details, pre-filled */}
      <div className="border border-slate-700 bg-slate-950/50 p-3 mb-3 text-[11px] space-y-1"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div><span className="text-slate-500 inline-block w-24">DUTY ON:</span> <span className="text-slate-100">{fmtTime(period.dutyOnAt)}</span></div>
        <div><span className="text-slate-500 inline-block w-24">LOCATION:</span> <span className="text-slate-100">{period.location || '—'}</span></div>
        {period.tail && <div><span className="text-slate-500 inline-block w-24">TAIL:</span> <span className="text-slate-100">{period.tail}</span></div>}
        {period.tripId && <div><span className="text-slate-500 inline-block w-24">TRIP:</span> <span className="text-slate-100">{period.tripId}</span></div>}
        <div><span className="text-slate-500 inline-block w-24">ASSIGNMENT:</span> <span className="text-slate-100">{period.assignmentType === 'regular' ? 'Regular (14h)' : 'Unscheduled'}</span></div>
        <div><span className="text-slate-500 inline-block w-24">YOUR ROLE:</span> <span className="text-slate-100">{period.role || 'SIC'}</span></div>
      </div>

      {!declining ? (
        <>
          {/* Prior rest — pre-filled but adjustable */}
          <div className="mb-3">
            <Label>PRIOR REST (hours) — adjust if different from PIC's value</Label>
            <input
              type="number"
              step="0.5"
              min="0"
              max="48"
              value={priorRestHours}
              onChange={(e) => setPriorRestHours(e.target.value)}
              className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            />
            <div className="text-[10px] text-slate-500 mt-1">
              Inherited {inheritedPriorRestHrs}h from your PIC's submission. Change if your actual rest was different.
            </div>
          </div>

          {/* Fit-for-duty attestation — this is YOUR legal attestation */}
          <label className="flex items-center gap-2 p-3 border border-amber-500/30 bg-amber-500/5 cursor-pointer mb-3">
            <input
              type="checkbox"
              checked={fitForDuty}
              onChange={(e) => setFitForDuty(e.target.checked)}
              className="w-4 h-4 accent-amber-500"
            />
            <span className="text-[11px] text-amber-200">
              <strong>FIT FOR DUTY.</strong> I am not fatigued, ill, medicated, or otherwise impaired,
              and I have had the rest period indicated above.
            </span>
          </label>

          <div className="flex gap-2">
            <button
              onClick={() => onConfirm({ fitForDuty: true, priorRestMs })}
              disabled={busy || !fitForDuty}
              className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold tracking-widest disabled:opacity-40 flex items-center justify-center gap-2"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              <UserCheck className="w-4 h-4" />
              {busy ? 'CONFIRMING…' : 'CONFIRM DUTY ON'}
            </button>
            <button
              onClick={() => setDeclining(true)}
              disabled={busy}
              className="px-4 py-3 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-sm tracking-widest disabled:opacity-40"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              DECLINE
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Decline confirmation */}
          <div className="text-[11px] text-amber-300 mb-2">
            Declining tells your PIC they need to find another SIC or fly single-pilot.
            This action is logged. You can optionally include a reason.
          </div>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Optional: why you're declining (e.g. wrong trip, not flying today, need different rest)"
            rows={2}
            className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400 mb-2"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => onDecline(declineReason.trim() || null)}
              disabled={busy}
              className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {busy ? 'DECLINING…' : 'CONFIRM DECLINE'}
            </button>
            <button
              onClick={() => setDeclining(false)}
              disabled={busy}
              className="px-4 py-2.5 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              BACK
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// =====================================================================
// Forms
// =====================================================================

function StartDutyForm({ busy, onCancel, onConfirm, myTrips = [], users = [], currentUserUid }) {
  // dutyOnAt is held as a UTC millisecond timestamp throughout the form.
  // The TzAwareDateTimeInput component handles converting between this
  // and the user-visible local-time string in their chosen timezone.
  // Default: 5-minute-rounded current time.
  const [dutyOnAt, setDutyOnAt] = useState(() => Math.round(Date.now() / 300000) * 300000);
  const [location, setLocation] = useState('');
  const [tail, setTail] = useState('');
  const [tripId, setTripId] = useState('');
  const [role, setRole] = useState('PIC');
  const [crewType, setCrewType] = useState('two');
  // Default to 'regular' (135.267(c) 14h duty period). Skyway operates as
  // assigned/regular duty in the vast majority of cases — pilots arrive
  // at the FBO under a planned assignment with documented duty-on time.
  // True unscheduled assignments (pilot pulled off rest without warning
  // for an emergent trip) are rare and should be the deliberate choice.
  const [assignmentType, setAssignmentType] = useState('regular');
  const [fitForDuty, setFitForDuty] = useState(false);
  const [priorRestHours, setPriorRestHours] = useState('10');

  // ---- Partner selection state ----
  //
  // When the role is PIC and crewType is 'two', show a partner picker
  // for the SIC. The picker has three modes:
  //   - 'none'   — single-pilot day, no SIC partner (default if crewType=single)
  //   - 'auto'   — system found a confident match from the trip's info.sic
  //                name string and pre-selected the user
  //   - 'manual' — user is picking from dropdown
  //
  // partnerUid is the actually-selected user UID (or null for none).
  // partnerLocked indicates whether the picker was auto-resolved from
  // a trip match (so we show a "auto-detected" hint).
  const [partnerUid, setPartnerUid] = useState(null);
  const [partnerSourceTripId, setPartnerSourceTripId] = useState(null);

  // Eligible crew users to show in the dropdown — exclude self.
  // Only users whose role is 'crew' (per Skyway's role model).
  const crewUsers = useMemo(
    () => (users || []).filter(u => {
      const uuid = u.uid || u.id;
      if (!uuid || uuid === currentUserUid) return false;
      const role = (u.role || '').toLowerCase();
      // Include crew + admin-impersonated-as-crew. Skyway accounts where
      // role isn't set are excluded — they probably aren't pilots.
      return role === 'crew' || role === 'pilot';
    }),
    [users, currentUserUid]
  );

  // Look up trip metadata when the user types a trip ID. We accept either
  // a JetInsight tripId (string match against trip.id) or a short label
  // (substring match against trip.uid). Use the FIRST exact match.
  const matchedTrip = useMemo(() => {
    const q = tripId.trim();
    if (!q) return null;
    return (myTrips || []).find(t => {
      const id = t.id || t.uid || '';
      const tripUid = (t.info && (t.info.uid || t.info.tripId)) || '';
      return id === q || tripUid === q || id.includes(q) || tripUid.includes(q);
    }) || null;
  }, [tripId, myTrips]);

  // When matchedTrip changes AND role=PIC AND crewType=two, attempt to
  // auto-detect the partner from trip.info.sic name string. Only set
  // partnerUid if there's a HIGH-CONFIDENCE match (≥2 token overlap,
  // not ambiguous with another user). Otherwise leave it null so the
  // PIC sees the dropdown.
  //
  // Trip data may also use trip.info.pic if the current user is filling
  // out a duty period as SIC — but in practice the PIC is the one who
  // initiates paired duty, so we look for the SIC field.
  useEffect(() => {
    // Reset partnerUid when trip changes — don't keep stale selection
    if (!matchedTrip) {
      // Clear auto-detected partner only if it was auto-set from a previous trip
      if (partnerSourceTripId && partnerSourceTripId !== tripId) {
        setPartnerUid(null);
        setPartnerSourceTripId(null);
      }
      return;
    }
    if (role !== 'PIC' || crewType !== 'two') return;
    // Auto-populate location and tail from the trip if not already filled
    if (matchedTrip.info?.from && !location) {
      setLocation(matchedTrip.info.from);
    }
    if (matchedTrip.info?.tail && !tail) {
      setTail(matchedTrip.info.tail);
    }
    const sicName = matchedTrip.info?.sic;
    if (!sicName) return;
    const match = matchUserByName(sicName, crewUsers);
    if (match) {
      setPartnerUid(match.user.uid || match.user.id);
      setPartnerSourceTripId(tripId);
    }
    // If no confident match, leave partnerUid null — PIC will see dropdown.
  }, [matchedTrip, role, crewType, crewUsers, tripId]);

  // Resolved partner object — for display
  const partnerUser = useMemo(
    () => partnerUid ? crewUsers.find(u => (u.uid || u.id) === partnerUid) : null,
    [partnerUid, crewUsers]
  );

  const onAtMs = dutyOnAt; // already UTC ms; renamed alias kept for clarity
  const priorRestMs = (() => {
    const n = parseFloat(priorRestHours);
    return Number.isFinite(n) && n >= 0 ? n * MS_HR : null;
  })();

  // Show partner picker only when this pilot is PIC of a 2-pilot crew.
  // SIC starting solo (without their PIC) is allowed but unusual — they
  // get a single-pilot record. PIC always sees the partner picker.
  const showPartnerPicker = role === 'PIC' && crewType === 'two';

  const canSubmit = Boolean(
    location.trim() &&
    crewType &&
    assignmentType &&
    fitForDuty &&
    onAtMs != null &&
    onAtMs <= Date.now() + 60000   // not in the far future
  );

  const submit = () => {
    if (!canSubmit) return;
    const payload = {
      location: location.trim(),
      tail: tail.trim() || null,
      tripId: tripId.trim() || null,
      role,
      crewType,
      assignmentType,
      fitForDuty: true,
      priorRestMs,
      dutyOnAt: onAtMs,
    };
    // If partner is selected, include it so the handler routes to
    // startDutyPair instead of startDuty. Otherwise normal solo flow.
    if (showPartnerPicker && partnerUid && partnerUser) {
      payload.partner = {
        pilotUid: partnerUid,
        pilotName: partnerUser.name || partnerUser.displayName || 'Unknown',
      };
    }
    onConfirm(payload);
  };

  return (
    <div className="space-y-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Label>DUTY-ON TIME</Label>
      <TzAwareDateTimeInput
        value={dutyOnAt}
        onChange={setDutyOnAt}
      />

      <Label>LOCATION (airport code or freeform)</Label>
      <input
        type="text"
        value={location}
        onChange={(e) => setLocation(e.target.value.toUpperCase().slice(0, 30))}
        placeholder="e.g. KAPF, hotel, home base"
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>TAIL (optional)</Label>
          <input
            type="text"
            value={tail}
            onChange={(e) => setTail(e.target.value.toUpperCase().slice(0, 10))}
            placeholder="N444AM"
            className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          />
        </div>
        <div>
          <Label>TRIP ID (optional)</Label>
          <input
            type="text"
            value={tripId}
            onChange={(e) => setTripId(e.target.value)}
            placeholder="L32LW0"
            className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          />
          {matchedTrip && (
            <div className="text-2xs text-success mt-1 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3 shrink-0" />
              {matchedTrip.info?.from || ''}→{matchedTrip.info?.to || ''}
              {matchedTrip.info?.tail && ` · ${matchedTrip.info.tail}`}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>ROLE</Label>
          <Toggle options={['PIC', 'SIC']} value={role} onChange={setRole} />
        </div>
        <div>
          <Label>CREW</Label>
          <Toggle
            options={[{ value: 'single', label: '1 PILOT' }, { value: 'two', label: '2 PILOTS' }]}
            value={crewType}
            onChange={setCrewType}
          />
        </div>
      </div>

      {showPartnerPicker && (
        <PartnerPicker
          crewUsers={crewUsers}
          partnerUid={partnerUid}
          setPartnerUid={setPartnerUid}
          partnerUser={partnerUser}
          autoDetected={Boolean(partnerSourceTripId && partnerSourceTripId === tripId)}
          matchedTripSicName={matchedTrip?.info?.sic || null}
        />
      )}

      <div>
        <Label>ASSIGNMENT TYPE</Label>
        <Toggle
          options={[
            { value: 'unscheduled', label: 'UNSCHEDULED' },
            { value: 'regular', label: 'REGULAR (14h)' },
          ]}
          value={assignmentType}
          onChange={setAssignmentType}
        />
        <div className="text-[10px] text-slate-500 mt-1">
          {assignmentType === 'unscheduled'
            ? '135.267(b) — no 14h duty cap; 10h continuous rest required immediately before assignment.'
            : '135.267(c) — up to 14h duty period; 10h continuous rest required in the 24h before planned completion.'}
        </div>
      </div>

      <div>
        <Label>PRIOR REST (hours)</Label>
        <input
          type="number"
          step="0.5"
          min="0"
          max="48"
          value={priorRestHours}
          onChange={(e) => setPriorRestHours(e.target.value)}
          className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
        />
        <div className="text-[10px] text-slate-500 mt-1">
          Your continuous rest immediately before this duty. Need ≥10h normally.
        </div>
      </div>

      <label className="flex items-center gap-2 p-3 border border-amber-500/30 bg-amber-500/5 cursor-pointer">
        <input
          type="checkbox"
          checked={fitForDuty}
          onChange={(e) => setFitForDuty(e.target.checked)}
          className="w-4 h-4 accent-amber-500"
        />
        <span className="text-[11px] text-amber-200">
          <strong>FIT FOR DUTY.</strong> I am not fatigued, ill, medicated, or otherwise impaired,
          and I have had the rest period indicated above.
        </span>
      </label>

      {showPartnerPicker && partnerUser && (
        <div className="text-[10px] text-cyan-300 bg-cyan-500/5 border border-cyan-500/30 p-2">
          When you confirm, <strong>{partnerUser.name || partnerUser.displayName}</strong> will
          receive a pending-duty card to confirm their own fit-for-duty.
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={submit}
          disabled={busy || !canSubmit}
          className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
        >
          {busy ? 'STARTING…' : 'CONFIRM DUTY ON'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-3 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// PartnerPicker — SIC selection for paired-duty start
// =====================================================================
//
// Behavior:
//   - If auto-detected (the parent already set partnerUid from a trip
//     SIC name match), show a "✓ AUTO-DETECTED" pill + the partner's
//     name, with a CHANGE button to switch to manual mode.
//   - If partnerUid is null, show a dropdown of all eligible crew users.
//   - Always provide a "NONE (single-pilot)" option for cases where
//     the PIC is flying solo despite the 2-pilot crew toggle.

function PartnerPicker({ crewUsers, partnerUid, setPartnerUid, partnerUser, autoDetected, matchedTripSicName }) {
  return (
    <div>
      <Label>SIC (PARTNER FOR THIS DUTY)</Label>
      {autoDetected && partnerUser ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between p-2.5 border border-cyan-500/40 bg-cyan-500/5">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-cyan-400" />
              <div>
                <div className="text-sm text-slate-100">
                  {partnerUser.name || partnerUser.displayName}
                </div>
                <div className="text-[10px] text-cyan-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  AUTO-DETECTED FROM TRIP
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPartnerUid(null)}
              className="text-[10px] text-slate-400 hover:text-cyan-300 px-2 py-1 border border-slate-700 hover:border-cyan-400"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              CHANGE
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <select
            value={partnerUid || ''}
            onChange={(e) => setPartnerUid(e.target.value || null)}
            className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
          >
            <option value="">— NONE (single pilot today) —</option>
            {crewUsers.map(u => (
              <option key={u.uid || u.id} value={u.uid || u.id}>
                {u.name || u.displayName || u.email}
              </option>
            ))}
          </select>
          {matchedTripSicName && !partnerUid && (
            <div className="text-[10px] text-amber-400">
              Trip says SIC is "{matchedTripSicName}" but couldn't find a clear match. Pick manually above.
            </div>
          )}
          {!matchedTripSicName && (
            <div className="text-[10px] text-slate-500">
              No SIC found in trip data. Pick partner manually or leave as single pilot.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EndDutyForm({ period, busy, onCancel, onConfirm }) {
  const [dutyOffAt, setDutyOffAt] = useState(() => Math.round(Date.now() / 300000) * 300000);
  const [flightTimeHours, setFlightTimeHours] = useState(
    period.flightTimeMs ? (period.flightTimeMs / MS_HR).toFixed(1) : '0'
  );
  const [excursionReason, setExcursionReason] = useState('');

  const offAtMs = dutyOffAt;
  const ftMs = (() => {
    const n = parseFloat(flightTimeHours);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * MS_HR) : 0;
  })();

  const elapsed = offAtMs != null ? offAtMs - period.dutyOnAt : 0;
  const over14 = elapsed > 14 * MS_HR;
  const limit = period.crewType === 'two' ? LIMITS.TWO_PILOT_FLIGHT_MAX_MS : LIMITS.SINGLE_PILOT_FLIGHT_MAX_MS;
  const overFlight = ftMs > limit;

  const canSubmit = offAtMs != null && offAtMs > period.dutyOnAt && offAtMs <= Date.now() + 60000;

  return (
    <div className="space-y-3 mt-2" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Label>DUTY-OFF TIME</Label>
      <TzAwareDateTimeInput
        value={dutyOffAt}
        onChange={setDutyOffAt}
      />
      {canSubmit && (
        <div className="text-[11px] text-slate-400">
          Total duty: <span className={over14 ? 'text-red-400 font-semibold' : 'text-slate-200'}>{fmtElapsed(elapsed)}</span>
          {over14 && <span className="text-red-400"> · OVER 14h</span>}
        </div>
      )}

      <Label>FLIGHT TIME (hours, block)</Label>
      <input
        type="number"
        step="0.1"
        min="0"
        max="24"
        value={flightTimeHours}
        onChange={(e) => setFlightTimeHours(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-400"
      />
      <div className="text-[10px] text-slate-500">
        Sum of block time across legs in this duty period. Limit for{' '}
        {period.crewType === 'two' ? 'two-pilot' : 'single-pilot'}: {limit / MS_HR}h.
      </div>

      {overFlight && (
        <>
          <div className="border border-red-500/40 bg-red-500/10 p-2">
            <div className="text-[10px] tracking-widest text-red-300 mb-1" style={{ fontWeight: 700 }}>
              FLIGHT TIME EXCEEDED LIMIT
            </div>
            <div className="text-[11px] text-red-200">
              An excursion is only permitted if outside pilot/operator control (weather, ATC, mechanical, passenger delay).
              Pilot-caused excursions are violations.
            </div>
          </div>
          <Label>EXCURSION REASON</Label>
          <textarea
            value={excursionReason}
            onChange={(e) => setExcursionReason(e.target.value)}
            placeholder="Required — describe the outside-control circumstance"
            rows={2}
            className="w-full bg-slate-950/80 border border-red-500/40 px-3 py-2 text-sm text-slate-100"
            style={{ fontFamily: 'DM Sans, sans-serif' }}
          />
        </>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onConfirm({
            dutyOffAt: offAtMs,
            flightTimeMs: ftMs,
            excursionReason: overFlight ? (excursionReason.trim() || null) : null,
          })}
          disabled={busy || !canSubmit || (overFlight && !excursionReason.trim())}
          className="flex-1 py-3 bg-red-600 hover:bg-red-500 text-white text-sm font-bold tracking-widest disabled:opacity-40"
        >
          {busy ? 'ENDING…' : 'CONFIRM DUTY OFF'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-3 border border-slate-700 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function OverrideRequestForm({ busy, onCancel, onConfirm }) {
  const [reason, setReason] = useState('');
  return (
    <div className="space-y-2 mt-2 p-3 border border-red-500/40 bg-red-500/5"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <Label>OVERRIDE REQUEST REASON</Label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Explain why this assignment must proceed despite the legality finding"
        rows={3}
        className="w-full bg-slate-950/80 border border-red-500/40 px-3 py-2 text-sm text-slate-100"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      />
      <div className="text-[10px] text-amber-300">
        This sends a request to Chief Pilot / Director of Operations. You must NOT
        continue duty until approval is granted.
      </div>
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || !reason.trim()}
          className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm font-bold disabled:opacity-40"
        >
          {busy ? 'SENDING…' : 'SEND OVERRIDE REQUEST'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

function InlineTimeEditor({ label, initialMs, busy, onCancel, onSave }) {
  const [ms, setMs] = useState(() => Number.isFinite(initialMs) ? initialMs : Date.now());
  const [note, setNote] = useState('');
  const inFuture = ms != null && ms > Date.now() + 60000;
  return (
    <div className="space-y-2 mt-2 p-3 border border-cyan-500/30 bg-cyan-500/5"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {label && <Label>{label}</Label>}
      <TzAwareDateTimeInput value={ms} onChange={setMs} />
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional reason for edit (logged)"
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-[11px] text-slate-100"
        style={{ fontFamily: 'DM Sans, sans-serif' }}
      />
      {inFuture && <div className="text-[10px] text-red-400">Time is in the future.</div>}
      <div className="flex gap-2">
        <button
          onClick={() => onSave(ms, note.trim() || null)}
          disabled={busy || ms == null || inFuture}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'SAVING…' : 'SAVE'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300 hover:border-slate-500"
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Outside flying
// =====================================================================

function OutsideFlyingSection({ outside, busy, openForm, setOpenForm, onAdd }) {
  const [expanded, setExpanded] = useState(false);
  const adding = openForm === 'outside';
  // Only count outside flying in the last 30 days for the summary
  const recent = outside.filter(o => o.startAt > Date.now() - 30 * MS_DAY);

  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-surface">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-surface-raised"
      >
        <span className="text-2xs font-semibold text-content-muted">
          Outside commercial flying · {recent.length}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-content-subtle" /> : <ChevronDown className="w-4 h-4 text-content-subtle" />}
      </button>
      {expanded && (
        <div className="border-t border-edge p-3">
          {recent.length > 0 && (
            <div className="space-y-1 mb-2">
              {recent.slice(0, 10).map(o => (
                <div key={o.id} className="text-[11px] text-slate-400 flex justify-between"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  <span>{fmtTime(o.startAt)} → {fmtTime(o.endAt)}</span>
                  <span>{(o.flightTimeMs / MS_HR).toFixed(1)}h · {o.source}</span>
                </div>
              ))}
            </div>
          )}
          {!adding && (
            <button
              onClick={() => setOpenForm('outside')}
              className="text-[10px] tracking-widest text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              <Plus className="w-3 h-3" /> LOG OUTSIDE FLIGHT
            </button>
          )}
          {adding && (
            <OutsideFlyingForm
              busy={busy}
              onCancel={() => setOpenForm(null)}
              onConfirm={onAdd}
            />
          )}
        </div>
      )}
    </div>
  );
}

function OutsideFlyingForm({ busy, onCancel, onConfirm }) {
  // UTC ms timestamps — TZ handled by the input component
  const [startAt, setStartAt] = useState(() => Math.round(Date.now() / 300000) * 300000);
  const [endAt, setEndAt] = useState(() => Math.round(Date.now() / 300000) * 300000);
  const [flightTimeHours, setFlightTimeHours] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const startMs = startAt;
  const endMs = endAt;
  const ftMs = parseFloat(flightTimeHours) * MS_HR;
  const valid = startMs && endMs && endMs > startMs && Number.isFinite(ftMs) && ftMs > 0 && source.trim();

  return (
    <div className="space-y-2 mt-2 p-3 border border-slate-700"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      <div className="space-y-2">
        <div>
          <Label>START</Label>
          <TzAwareDateTimeInput value={startAt} onChange={setStartAt} compact />
        </div>
        <div>
          <Label>END</Label>
          <TzAwareDateTimeInput value={endAt} onChange={setEndAt} compact />
        </div>
      </div>
      <Label>FLIGHT TIME (hours)</Label>
      <input type="number" step="0.1" min="0" value={flightTimeHours} onChange={(e) => setFlightTimeHours(e.target.value)}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100" />
      <Label>OPERATOR / SOURCE</Label>
      <input type="text" value={source} onChange={(e) => setSource(e.target.value)}
        placeholder="e.g. Other Air Inc, personal flight"
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100" />
      <Label>NOTES (optional)</Label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
        className="w-full bg-slate-950/80 border border-slate-700 px-3 py-2 text-sm text-slate-100"
        style={{ fontFamily: 'DM Sans, sans-serif' }} />
      <div className="flex gap-2">
        <button
          onClick={() => onConfirm({ startAt: startMs, endAt: endMs, flightTimeMs: Math.round(ftMs), source: source.trim(), notes: notes.trim() })}
          disabled={busy || !valid}
          className="flex-1 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'SAVING…' : 'LOG FLIGHT'}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="px-4 py-2 border border-slate-700 text-sm text-slate-300">
          CANCEL
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// History
// =====================================================================

function DutyHistoryStrip({ periods, busy, openForm, setOpenForm, onEdit }) {
  const closed = periods.filter(p => p.status === 'off' && p.dutyOffAt).slice(0, 10);
  const [expanded, setExpanded] = useState(false);
  if (closed.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-surface">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-surface-raised"
      >
        <span className="text-2xs font-semibold text-content-muted">
          Recent duty · {closed.length}
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-content-subtle" /> : <ChevronDown className="w-4 h-4 text-content-subtle" />}
      </button>
      {expanded && (
        <div className="divide-y divide-edge border-t border-edge">
          {closed.map(p => (
            <HistoryRow key={p.id} period={p} busy={busy} openForm={openForm} setOpenForm={setOpenForm} onEdit={onEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ period, busy, openForm, setOpenForm, onEdit }) {
  const elapsed = (period.dutyOffAt || 0) - (period.dutyOnAt || 0);
  const ftH = (period.flightTimeMs || 0) / MS_HR;
  const editing = openForm?.startsWith(`edit:${period.id}:`);
  return (
    <div className="px-3 py-2">
      <div className="grid items-baseline gap-2 text-[11px]"
        style={{ gridTemplateColumns: '1fr 1fr 70px 70px 60px', fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="text-slate-300 tabular-nums">{fmtTime(period.dutyOnAt)}</div>
        <div className="text-slate-400 tabular-nums">{fmtTime(period.dutyOffAt)}</div>
        <div className={`text-right tabular-nums ${period.over14 ? 'text-red-400' : 'text-slate-300'}`}>
          {fmtElapsed(elapsed)}
        </div>
        <div className="text-right tabular-nums text-slate-400">{ftH.toFixed(1)}hFT</div>
        <div className="text-right">
          {!editing && (
            <button onClick={() => setOpenForm(`edit:${period.id}:dutyOnAt`)}
              className="text-[10px] text-slate-500 hover:text-cyan-400">EDIT</button>
          )}
        </div>
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <InlineTimeEditor label="DUTY-ON" initialMs={period.dutyOnAt} busy={busy}
            onCancel={() => setOpenForm(null)}
            onSave={(ms, note) => onEdit(period.id, 'dutyOnAt', ms, note)} />
          <InlineTimeEditor label="DUTY-OFF" initialMs={period.dutyOffAt} busy={busy}
            onCancel={() => setOpenForm(null)}
            onSave={(ms, note) => onEdit(period.id, 'dutyOffAt', ms, note)} />
        </div>
      )}
      {period.excursionReason && (
        <div className="text-[10px] text-amber-300/80 italic mt-1">
          Excursion: {period.excursionReason}
        </div>
      )}
      {period.overrideStatus === 'approved' && (
        <div className="text-[10px] text-emerald-300 mt-1">
          ✓ Override approved by {period.overrideApprovedBy}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Tiny shared UI atoms
// =====================================================================

function Label({ children }) {
  return (
    <div className="text-[10px] tracking-widest text-slate-500"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}>
      {children}
    </div>
  );
}

function Toggle({ options, value, onChange }) {
  const normalized = options.map(o => typeof o === 'string' ? { value: o, label: o } : o);
  return (
    <div className="flex gap-1 p-0.5 bg-slate-950/80 border border-slate-700">
      {normalized.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 py-1.5 text-[10px] tracking-widest ${
            value === o.value ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
          }`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
