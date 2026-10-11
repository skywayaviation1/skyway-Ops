// Inline fixes for the administrator "Requires attention" cards.
// Findings are grouped by pilot. Each card can repair that finding, and the
// ledger updates from the server response so the card disappears immediately.

import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Undo2 } from 'lucide-react';
import {
  applyPlanToPeriods,
  counterparts,
  dutyTimeline,
  etInputToUtcMs,
  fixKindForIssue,
  fmtHours,
  issuesFor,
  planFindingFix,
  utcMsToEtInput,
} from './duty-findings.js';
import DutyScheduleResync from './DutyScheduleResync.jsx';
import { Button, Card, EmptyState, StatusChip, cx, notify } from './ui.jsx';

function fmtWhen(ms) {
  if (!Number.isFinite(ms)) return 'Open';
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function postFix(payload) {
  const { auth } = await import('./firebase.js');
  if (!auth.currentUser) throw new Error('You must be signed in');
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch('/api/duty-finding-fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...payload }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.error || `Duty fix failed (${response.status})`);
  return result;
}

function rememberPreview(records) {
  if (typeof window === 'undefined') return;
  if (!window.__DUTY_PREVIEW_PERIODS__) return;
  window.__DUTY_PREVIEW_PERIODS__ = applyPlanToPeriods(window.__DUTY_PREVIEW_PERIODS__, { ok: true, records });
}

export default function DutyAttentionBoard({
  visible = [],
  catalog = [],
  now = Date.now(),
  trips = [],
  pilots = [],
  onApplied,
}) {
  const [openKey, setOpenKey] = useState('');
  const [reason, setReason] = useState('');
  const [dutyOn, setDutyOn] = useState('');
  const [dutyOff, setDutyOff] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [dropId, setDropId] = useState('');
  const [verifyOver14, setVerifyOver14] = useState(false);
  const [busy, setBusy] = useState('');
  const [audits, setAudits] = useState([]);
  const [bulk, setBulk] = useState(null);

  const issues = useMemo(() => issuesFor(catalog, now), [catalog, now]);
  const cards = useMemo(() => {
    const visibleIds = new Set(visible.map((period) => period.id));
    const rows = [];
    catalog.forEach((period) => {
      if (!visibleIds.has(period.id)) return;
      (issues.get(period.id) || []).filter((issue) => !issue.approved).forEach((issue) => {
        rows.push({ period, issue });
      });
    });
    return rows;
  }, [catalog, visible, issues]);

  const groups = useMemo(() => {
    const map = new Map();
    cards.forEach((card) => {
      const key = card.period.pilotUid || card.period.id;
      if (!map.has(key)) {
        map.set(key, {
          uid: key,
          name: card.period.pilotName || 'Unknown pilot',
          cards: [],
          periods: [],
        });
      }
      const group = map.get(key);
      group.cards.push(card);
      if (!group.periods.some((period) => period.id === card.period.id)) group.periods.push(card.period);
    });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [cards]);

  useEffect(() => {
    let cancelled = false;
    postFix({ mode: 'list' }).then((result) => {
      if (!cancelled) setAudits(result.audits || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const applyResult = (result) => {
    if (Array.isArray(result.records) && result.records.length && onApplied) onApplied(result.records);
    rememberPreview(result.records || []);
    if (result.auditId) {
      setAudits((current) => [{
        id: result.auditId,
        at: Date.now(),
        byName: 'You',
        reason: reason || result.summary,
        kind: result.mode === 'undo' ? 'undo' : 'fix',
        summary: result.summary,
        undoneAt: null,
      }, ...current.filter((audit) => audit.id !== result.auditId)].slice(0, 20));
    }
    setOpenKey('');
    setBulk(null);
    notify.success(result.summary || 'Duty record updated.');
  };

  const run = async (payload, busyId) => {
    if (!String(payload.reason || reason).trim()) {
      notify.error('A reason is required.');
      return;
    }
    setBusy(busyId);
    try {
      const local = planFindingFix({ ...payload, periods: catalog, now, reason: payload.reason || reason });
      if (!local.ok) throw new Error(local.error);
      const result = await postFix({
        mode: 'apply',
        ...payload,
        reason: payload.reason || reason,
        fingerprint: payload.fingerprint || local.fingerprint,
      });
      applyResult(result);
    } catch (err) {
      notify.error(err?.message || 'Could not apply the fix');
    } finally {
      setBusy('');
    }
  };

  const undo = async (audit) => {
    const note = window.prompt('Reason for undoing this fix');
    if (!note || !note.trim()) return;
    setBusy(`undo-${audit.id}`);
    try {
      const result = await postFix({ mode: 'undo', auditId: audit.id, reason: note.trim() });
      applyResult(result);
      setAudits((current) => current.map((row) => (row.id === audit.id ? { ...row, undoneAt: Date.now() } : row)));
    } catch (err) {
      notify.error(err?.message || 'Could not undo');
    } finally {
      setBusy('');
    }
  };

  const previewBulk = async (group) => {
    const note = reason.trim();
    if (!note) {
      notify.error('Enter a reason before previewing overlap repair.');
      return;
    }
    setBusy(`bulk-${group.uid}`);
    try {
      const result = await postFix({
        mode: 'preview',
        kind: 'fix-overlaps',
        pilotUid: group.uid,
        reason: note,
      });
      setBulk({ uid: group.uid, ...result, reason: note });
    } catch (err) {
      notify.error(err?.message || 'No automatic overlap repair');
    } finally {
      setBusy('');
    }
  };

  return (
    <section data-testid="attention-board" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-content-muted" />
          <h2 className="text-sm font-semibold text-content">Requires attention</h2>
          <span className="font-mono text-2xs text-content-subtle">{cards.length}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DutyScheduleResync trips={trips} pilots={pilots} />
        </div>
      </div>

      {audits.length > 0 && (
        <Card className="p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Recent fixes</p>
          <ul className="mt-2 space-y-2">
            {audits.slice(0, 5).map((audit) => (
              <li key={audit.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="min-w-0 text-content">
                  <span className="font-semibold">{audit.summary || audit.kind}</span>
                  <span className="mt-0.5 block text-2xs text-content-muted">{audit.reason}</span>
                </span>
                {audit.undoneAt ? (
                  <StatusChip size="sm">Undone</StatusChip>
                ) : audit.kind === 'undo' ? null : (
                  <Button variant="outline" size="sm" icon={Undo2} disabled={busy === `undo-${audit.id}`} onClick={() => undo(audit)} data-testid="undo-fix">
                    Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {groups.length === 0 ? (
        <Card><EmptyState icon={CheckCircle2} title="No exceptions in this range" description="No compliance or data-quality findings were detected." /></Card>
      ) : (
        <>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Reason for the next fix</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this record being corrected?"
              className="h-10 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-content"
              data-testid="fix-reason"
            />
          </label>
          {groups.map((group) => (
        <div key={group.uid} className="space-y-3" data-testid={`pilot-findings-${group.uid}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-content">{group.name}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone="danger" size="sm">{group.cards.length} finding{group.cards.length === 1 ? '' : 's'}</StatusChip>
              {group.cards.some((card) => card.issue.code === 'OVERLAP') && (
                <Button variant="outline" size="sm" disabled={busy === `bulk-${group.uid}`} onClick={() => previewBulk(group)} data-testid="bulk-overlaps">
                  Fix all overlaps
                </Button>
              )}
            </div>
          </div>
          <PilotTimeline periods={catalog.filter((period) => period.pilotUid === group.uid)} now={now} />
          {bulk?.uid === group.uid && (
            <Card className="border-accent-border bg-accent-soft p-3" data-testid="bulk-preview">
              <p className="text-sm font-semibold text-content">{bulk.summary}</p>
              {(bulk.warnings || []).map((warning) => (
                <p key={warning} className="mt-1 text-2xs text-content-muted">{warning}</p>
              ))}
              <ul className="mt-2 space-y-1 text-xs text-content">
                {(bulk.bulkActions || []).map((action) => (
                  <li key={`${action.kind}-${action.periodId}-${action.otherId}`}>
                    {action.kind} · {action.periodId}{action.dropId ? ` → remove ${action.dropId}` : ''}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!!busy}
                  data-testid="bulk-apply"
                  onClick={() => run({
                    kind: 'fix-overlaps',
                    pilotUid: group.uid,
                    reason: bulk.reason,
                    fingerprint: bulk.fingerprint,
                  }, 'bulk-apply')}
                >
                  Apply overlap repair
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setBulk(null)}>Cancel</Button>
              </div>
            </Card>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            {group.cards.map((card) => (
              <FindingCard
                key={`${card.period.id}-${card.issue.code}`}
                card={card}
                catalog={catalog}
                now={now}
                open={openKey === `${card.period.id}:${card.issue.code}`}
                onToggle={() => {
                  const key = `${card.period.id}:${card.issue.code}`;
                  setOpenKey((current) => (current === key ? '' : key));
                  setDutyOn(utcMsToEtInput(card.period.dutyOnAt));
                  setDutyOff(utcMsToEtInput(card.period.dutyOffAt) || utcMsToEtInput(card.period.dutyOnAt + 8 * 3600 * 1000));
                  setPartnerId(card.period.partnerPeriodId || '');
                  setDropId('');
                  setVerifyOver14(false);
                }}
                dutyOn={dutyOn}
                dutyOff={dutyOff}
                setDutyOn={setDutyOn}
                setDutyOff={setDutyOff}
                partnerId={partnerId}
                setPartnerId={setPartnerId}
                dropId={dropId}
                setDropId={setDropId}
                verifyOver14={verifyOver14}
                setVerifyOver14={setVerifyOver14}
                busy={busy}
                onRun={run}
              />
            ))}
          </div>
        </div>
          ))}
        </>
      )}
    </section>
  );
}

function PilotTimeline({ periods, now }) {
  const days = useMemo(() => dutyTimeline(periods, now).slice(-14), [periods, now]);
  if (days.length === 0) return null;
  return (
    <div data-testid="duty-timeline" className="space-y-1.5 rounded-xl border border-edge bg-surface p-3">
      {days.map((day) => (
        <div key={day.day} className="grid grid-cols-[3.2rem_1fr] items-center gap-2">
          <span className="font-mono text-[10px] text-content-subtle">{day.label}</span>
          <div className="relative h-7 overflow-hidden rounded bg-surface-sunken">
            {day.slices.map((slice) => (
              <div
                key={`${slice.id}-${slice.start}`}
                title={`${slice.pilotName} ${slice.tail} ${fmtWhen(slice.dutyOnAt)}–${fmtWhen(slice.dutyOffAt)}`}
                className={cx(
                  'absolute top-1 h-5 rounded-sm',
                  slice.overlap ? 'bg-danger' : 'bg-accent',
                )}
                style={{
                  left: `${slice.start * 100}%`,
                  width: `${Math.max((slice.end - slice.start) * 100, 1.2)}%`,
                }}
              />
            ))}
          </div>
        </div>
      ))}
      <p className="text-[10px] text-content-subtle">Eastern day. Red is an overlap.</p>
    </div>
  );
}

function FindingCard({
  card, catalog, now, open, onToggle,
  dutyOn, dutyOff, setDutyOn, setDutyOff,
  partnerId, setPartnerId, dropId, setDropId,
  verifyOver14, setVerifyOver14, busy, onRun,
}) {
  const { period, issue } = card;
  const kind = fixKindForIssue(issue.code);
  const others = counterparts(period, catalog, now);
  const partners = catalog.filter((candidate) => candidate.pilotUid && candidate.pilotUid !== period.pilotUid);
  return (
    <Card
      className={cx('p-4', issue.tone === 'danger' ? 'border-danger-border bg-danger-soft' : 'border-warning-border bg-warning-soft')}
      data-testid="finding-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-content">{period.pilotName || 'Unknown pilot'}</p>
          <p className="mt-0.5 font-mono text-2xs text-content-muted">
            {fmtWhen(period.dutyOnAt)} · {period.tail || 'No tail'} · {period.role || 'No role'}
          </p>
        </div>
        {kind && (
          <Button variant="outline" size="sm" onClick={onToggle} data-testid="finding-fix">
            {open ? 'Close' : 'Fix'}
          </Button>
        )}
      </div>
      <div className="mt-3">
        <StatusChip tone={issue.tone} size="sm">{issue.label}</StatusChip>
      </div>
      {open && kind === 'overlap' && (
        <div className="mt-3 space-y-3" data-testid="overlap-compare">
          {others.length === 0 ? <p className="text-xs text-content-muted">The other record is outside this range.</p> : others.map(({ other }) => (
            <div key={other.id} className="grid gap-2 md:grid-cols-2">
              <RecordColumn period={period} now={now} />
              <RecordColumn period={other} now={now} />
              <div className="flex flex-wrap gap-2 md:col-span-2">
                <Button variant="outline" size="sm" disabled={!!busy} data-testid="fix-merge" onClick={() => onRun({ kind: 'merge', periodId: period.id, otherId: other.id }, `merge-${other.id}`)}>Merge</Button>
                <Button variant="outline" size="sm" disabled={!!busy} data-testid="fix-trim" onClick={() => onRun({ kind: 'trim', periodId: period.id, otherId: other.id }, `trim-${other.id}`)}>Trim</Button>
                <Button variant="outline" size="sm" disabled={!!busy} data-testid="fix-delete" onClick={() => onRun({ kind: 'delete-duplicate', periodId: period.id, otherId: other.id, dropId: dropId || other.id }, `drop-${other.id}`)}>Delete duplicate</Button>
              </div>
              <label className="text-2xs text-content-muted md:col-span-2">
                Duplicate to remove
                <select value={dropId || other.id} onChange={(event) => setDropId(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-edge bg-surface px-2 text-sm text-content">
                  <option value={other.id}>{other.pilotName} · {fmtWhen(other.dutyOnAt)} · {fmtHours(Math.max(0, (other.dutyOffAt || now) - other.dutyOnAt))}</option>
                  <option value={period.id}>{period.pilotName} · {fmtWhen(period.dutyOnAt)} · {fmtHours(Math.max(0, (period.dutyOffAt || now) - period.dutyOnAt))}</option>
                </select>
              </label>
            </div>
          ))}
          <p className="text-2xs leading-relaxed text-content-muted">Merge keeps the larger flight time and the combined window. Trim moves the later duty-on to the earlier duty-off. Delete removes the selected record from the live ledger. Undo restores it.</p>
        </div>
      )}
      {open && (kind === 'set-off' || kind === 'edit-times') && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {kind === 'edit-times' && (
            <label className="text-[10px] uppercase tracking-wider text-content-subtle">
              Duty on (Eastern)
              <input type="datetime-local" value={dutyOn} onChange={(event) => setDutyOn(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-edge bg-surface px-2 text-sm normal-case tracking-normal text-content" data-testid="fix-duty-on" />
            </label>
          )}
          <label className="text-[10px] uppercase tracking-wider text-content-subtle">
            Duty off (Eastern)
            <input type="datetime-local" value={dutyOff} onChange={(event) => setDutyOff(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-edge bg-surface px-2 text-sm normal-case tracking-normal text-content" data-testid="fix-duty-off" />
          </label>
          <label className="flex items-start gap-2 text-2xs text-content sm:col-span-2">
            <input type="checkbox" checked={verifyOver14} onChange={(event) => setVerifyOver14(event.target.checked)} className="mt-0.5" />
            The corrected window really exceeded 14 hours.
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={!!busy}
            data-testid={kind === 'set-off' ? 'fix-set-off' : 'fix-edit-times'}
            onClick={() => onRun({
              kind,
              periodId: period.id,
              dutyOnAt: kind === 'edit-times' ? etInputToUtcMs(dutyOn) : period.dutyOnAt,
              dutyOffAt: etInputToUtcMs(dutyOff),
              over14Verified: verifyOver14,
            }, kind)}
          >
            {kind === 'set-off' ? 'Set duty-off' : 'Save times'}
          </Button>
        </div>
      )}
      {open && kind === 'link' && (
        <div className="mt-3 space-y-2">
          <PartnerSelect periods={partners} value={partnerId} onChange={setPartnerId} />
          <Button variant="primary" size="sm" disabled={!!busy || !partnerId} data-testid="fix-link-partner" onClick={() => onRun({ kind: 'link', periodId: period.id, partnerPeriodId: partnerId }, 'link')}>
            Link partner
          </Button>
          <p className="text-2xs text-content-muted">Writes a reciprocal crew link and judges both pilots on the two-pilot limits. Duty and flight times stay as recorded.</p>
        </div>
      )}
      {open && kind === 'reciprocal' && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-content">Points at {period.partnerPeriodId}. The other record does not point back.</p>
          <Button variant="primary" size="sm" disabled={!!busy} data-testid="fix-reciprocal" onClick={() => onRun({ kind: 'reciprocal', periodId: period.id }, 'reciprocal')}>
            Make reciprocal
          </Button>
        </div>
      )}
      {open && kind === 'override-declined' && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-content-muted">Marks the record admin-attested. The decline note stays on the audit snapshot. Times are not changed.</p>
          <Button variant="primary" size="sm" disabled={!!busy} data-testid="fix-override" onClick={() => onRun({ kind: 'override-declined', periodId: period.id }, 'override')}>
            Admin override
          </Button>
        </div>
      )}
    </Card>
  );
}

function RecordColumn({ period, now }) {
  const end = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now;
  return (
    <div className="rounded-lg border border-edge bg-surface p-2 text-xs">
      <p className="font-semibold text-content">{period.pilotName}</p>
      <p className="mt-1 font-mono text-2xs text-content-muted">{period.tail || 'No tail'} · {period.role || 'Crew'} · {period.crewType || '—'}</p>
      <p className="mt-1 text-content">{fmtWhen(period.dutyOnAt)} → {Number.isFinite(period.dutyOffAt) ? fmtWhen(period.dutyOffAt) : 'No duty-off'}</p>
      <p className="font-mono text-2xs text-content">{fmtHours(Math.max(0, end - period.dutyOnAt))} duty · {fmtHours(period.flightTimeMs)} flight</p>
    </div>
  );
}

export function DutyLinkPartner({ period, periods = [], now = Date.now(), onApplied }) {
  const [partnerId, setPartnerId] = useState(period?.partnerPeriodId || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const options = periods.filter((candidate) => candidate.id !== period?.id && candidate.pilotUid && candidate.pilotUid !== period?.pilotUid);
  if (!period) return null;
  const run = async (kind) => {
    if (!reason.trim()) {
      notify.error('A reason is required.');
      return;
    }
    setBusy(true);
    try {
      const local = planFindingFix({
        kind,
        periods,
        periodId: period.id,
        partnerPeriodId: partnerId,
        reason,
        now,
      });
      if (!local.ok) throw new Error(local.error);
      const result = await postFix({
        mode: 'apply',
        kind,
        periodId: period.id,
        partnerPeriodId: partnerId,
        reason,
        fingerprint: local.fingerprint,
      });
      rememberPreview(result.records || []);
      if (onApplied) onApplied(result.records || []);
      setReason('');
      notify.success(result.summary || 'Crew link updated.');
    } catch (err) {
      notify.error(err?.message || 'Could not update the crew link');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="mb-4 p-3" data-testid="link-partner-panel">
      <h3 className="text-sm font-semibold text-content">Link partner</h3>
      <p className="mt-1 text-2xs text-content-muted">Pair this record with another pilot. Both links are written, and both limits are recalculated. Unlink or swap from here.</p>
      <div className="mt-3 space-y-2">
        <PartnerSelect periods={options} value={partnerId} onChange={setPartnerId} />
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (required)"
          className="h-10 w-full rounded-lg border border-edge bg-surface px-3 text-sm text-content"
          data-testid="link-partner-reason"
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={busy || !partnerId} onClick={() => run(period.partnerPeriodId && period.partnerPeriodId !== partnerId ? 'swap' : 'link')} data-testid="link-partner-apply">
            {period.partnerPeriodId && partnerId && period.partnerPeriodId !== partnerId ? 'Swap partner' : 'Link'}
          </Button>
          {period.partnerPeriodId && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run('unlink')} data-testid="unlink-partner">
              Unlink
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function PartnerSelect({ periods, value, onChange }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full rounded-lg border border-edge bg-surface px-2 text-sm text-content" data-testid="partner-select">
      <option value="">Choose a duty record</option>
      {periods.map((period) => (
        <option key={period.id} value={period.id}>
          {period.pilotName} · {fmtWhen(period.dutyOnAt)} · {period.tail || 'No tail'} · {period.role || 'Crew'}
        </option>
      ))}
    </select>
  );
}
