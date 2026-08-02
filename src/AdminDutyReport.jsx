// Comprehensive administrator duty/compliance report.
//
// This is deliberately a report, not another editor. Admin editing remains in
// AdminDutyTools and DutyDayDetail; this surface answers:
//   - Who is on duty and who is currently legal?
//   - What duty/flight/rest was recorded in the selected period?
//   - Which records need compliance or data-quality review?
//   - What outside commercial flying and audit changes exist?

import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock,
  Download, FileText, Plane, Search, Shield, Users, X,
} from 'lucide-react';
import {
  subscribeDutyReportForAllPilots,
  subscribeOutsideReportForAllPilots,
  RETENTION_DAYS,
} from './firebase-duty-v2.js';
import { evaluateCurrent, LIMITS } from './duty-legality.js';
import {
  Button, Card, EmptyState, MetricTile, PageHeader, Spinner, StatusChip, cx, notify,
} from './ui.jsx';

const MS_HOUR = 3600 * 1000;
const MS_DAY = 24 * MS_HOUR;
const RANGE_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 365, label: '365 days' },
];

function hours(ms) {
  return Number.isFinite(ms) ? ms / MS_HOUR : 0;
}

function fmtHours(ms, digits = 1) {
  return `${hours(ms).toFixed(digits)}h`;
}

function fmtDateTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleDateString([], {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function durationMs(period, now = Date.now()) {
  if (!Number.isFinite(period?.dutyOnAt)) return 0;
  const end = Number.isFinite(period.dutyOffAt) ? period.dutyOffAt : now;
  return Math.max(0, end - period.dutyOnAt);
}

function confirmationCounts(period) {
  return !period.confirmStatus
    || period.confirmStatus === 'self-attested'
    || period.confirmStatus === 'admin-attested';
}

function findOverlaps(periods, now) {
  const ids = new Set();
  const byPilot = new Map();
  periods.forEach((p) => {
    if (!p.pilotUid || !Number.isFinite(p.dutyOnAt)) return;
    if (!byPilot.has(p.pilotUid)) byPilot.set(p.pilotUid, []);
    byPilot.get(p.pilotUid).push(p);
  });
  byPilot.forEach((list) => {
    const sorted = [...list].sort((a, b) => a.dutyOnAt - b.dutyOnAt);
    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i];
      const aEnd = Number.isFinite(a.dutyOffAt) ? a.dutyOffAt : now;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j];
        if (b.dutyOnAt >= aEnd) break;
        const bEnd = Number.isFinite(b.dutyOffAt) ? b.dutyOffAt : now;
        if (b.dutyOnAt < aEnd && bEnd > a.dutyOnAt) {
          ids.add(a.id);
          ids.add(b.id);
        }
      }
    }
  });
  return ids;
}

function recordIssues(period, periodById, overlapIds, now) {
  const issues = [];
  const duty = durationMs(period, now);
  const flightLimit = period.crewType === 'single'
    ? LIMITS.SINGLE_PILOT_FLIGHT_MAX_MS
    : LIMITS.TWO_PILOT_FLIGHT_MAX_MS;
  const flight = Number.isFinite(period.flightTimeMs) ? period.flightTimeMs : 0;

  const add = (code, label, tone = 'warning', kind = 'compliance') => {
    issues.push({ code, label, tone, kind });
  };

  if (!Number.isFinite(period.dutyOnAt)) add('MISSING_ON', 'Missing duty-on time', 'danger', 'data');
  if (period.status === 'off' && !Number.isFinite(period.dutyOffAt)) {
    add('MISSING_OFF', 'Closed record has no duty-off time', 'danger', 'data');
  }
  if (Number.isFinite(period.dutyOffAt) && period.dutyOffAt <= period.dutyOnAt) {
    add('INVALID_TIME', 'Duty-off is not after duty-on', 'danger', 'data');
  }
  if (overlapIds.has(period.id)) add('OVERLAP', 'Overlaps another record for this pilot', 'danger', 'data');

  if (period.confirmStatus === 'pending') add('PENDING', 'SIC confirmation pending', 'warning');
  if (period.confirmStatus === 'declined') add('DECLINED', 'Pilot declined paired duty', 'danger');
  if (confirmationCounts(period) && period.fitForDuty !== true) {
    add('FIT', 'Fit-for-duty attestation missing', 'danger');
  }
  if (confirmationCounts(period) && !Number.isFinite(period.priorRestMs)) {
    add('REST_MISSING', 'Prior rest not recorded', 'warning', 'data');
  } else if (confirmationCounts(period) && period.priorRestMs < LIMITS.REST_REQUIRED_BEFORE_MS) {
    add('REST_LOW', `Prior rest ${fmtHours(period.priorRestMs)} below 10h`, 'danger');
  }

  if (period.assignmentType === 'regular' && duty > LIMITS.REGULAR_DUTY_MAX_MS) {
    add('OVER_14', `Regular duty ${fmtHours(duty)} exceeds 14h`, 'danger');
  }
  if (period.status === 'on' && duty > 16 * MS_HOUR) {
    add('OPEN_LONG', `Duty still open after ${fmtHours(duty)}`, 'danger', 'data');
  }
  if (flight > flightLimit) {
    add('FLIGHT_LIMIT', `${fmtHours(flight)} flight exceeds ${fmtHours(flightLimit, 0)} ${period.crewType || 'crew'} limit`, 'danger');
    if (!period.excursionReason) {
      add('NO_EXCURSION_REASON', 'Flight-time excursion has no reason', 'danger', 'data');
    }
  }

  if (period.overrideStatus === 'requested') add('OVERRIDE_PENDING', 'Override awaiting approval', 'danger');
  if (period.overrideStatus === 'approved' && !period.overrideApprovedBy) {
    add('OVERRIDE_AUDIT', 'Approved override missing approver', 'danger', 'data');
  }

  if (period.partnerPeriodId) {
    const partner = periodById.get(period.partnerPeriodId);
    if (!partner) add('ORPHAN_PAIR', 'Linked partner record not found', 'danger', 'data');
    else if (partner.partnerPeriodId !== period.id) {
      add('ONE_WAY_PAIR', 'Partner link is not reciprocal', 'danger', 'data');
    }
  }

  if (!period.pilotUid || !period.pilotName) add('PILOT', 'Pilot identity incomplete', 'danger', 'data');
  if (!period.location) add('LOCATION', 'Location missing', 'warning', 'data');
  if (!period.role) add('ROLE', 'PIC/SIC role missing', 'warning', 'data');
  if (!['single', 'two'].includes(period.crewType)) add('CREW_TYPE', 'Crew type missing or invalid', 'warning', 'data');
  if (!['regular', 'unscheduled'].includes(period.assignmentType)) {
    add('ASSIGNMENT', 'Assignment type missing or invalid', 'warning', 'data');
  }

  return issues;
}

function statusTone(status) {
  if (status === 'illegal') return 'danger';
  if (status === 'warning') return 'warning';
  return 'success';
}

function csvCell(value) {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadReportCsv(periods, outside, issuesById, rangeDays) {
  const periodHeaders = [
    'Record Type', 'Period ID', 'Pilot UID', 'Pilot Name', 'Status',
    'Confirmation', 'Fit for Duty', 'Duty On', 'Duty Off', 'Duty Hours',
    'Prior Rest Hours', 'Flight Hours', 'Location', 'Tail', 'Trip ID', 'Role',
    'Crew Type', 'Assignment Type', 'Excursion Reason', 'Override Status',
    'Override Requested By', 'Override Requested At', 'Override Request Reason',
    'Override Approved By', 'Override Approved At', 'Override Approval Notes',
    'Partner Period ID', 'Pending Created By', 'Confirmed At', 'Declined At',
    'Declined Reason', 'Over 14', 'Issues', 'Admin Edits', 'Created At', 'Updated At',
    'Raw Record JSON',
  ];
  const rows = [periodHeaders.map(csvCell).join(',')];
  periods.forEach((p) => {
    rows.push([
      'Duty Period', p.id, p.pilotUid, p.pilotName, p.status,
      p.confirmStatus || 'legacy-self-attested', p.fitForDuty,
      fmtDateTime(p.dutyOnAt), fmtDateTime(p.dutyOffAt), hours(durationMs(p)).toFixed(2),
      Number.isFinite(p.priorRestMs) ? hours(p.priorRestMs).toFixed(2) : '',
      hours(p.flightTimeMs).toFixed(2), p.location, p.tail, p.tripId, p.role,
      p.crewType, p.assignmentType, p.excursionReason, p.overrideStatus,
      p.overrideRequestedBy, fmtDateTime(p.overrideRequestedAt), p.overrideRequestReason,
      p.overrideApprovedBy, fmtDateTime(p.overrideApprovedAt), p.overrideApprovalNotes,
      p.partnerPeriodId, p.pendingCreatedBy, fmtDateTime(p.confirmedAt),
      fmtDateTime(p.declinedAt), p.declinedReason, p.over14,
      (issuesById.get(p.id) || []).map(i => `${i.code}: ${i.label}`).join(' | '),
      p.adminEdits || [], fmtDateTime(p.createdAt), fmtDateTime(p.updatedAt), p,
    ].map(csvCell).join(','));
  });
  rows.push('');
  rows.push(['Outside Flying', 'ID', 'Pilot UID', 'Pilot Name', 'Start', 'End', 'Elapsed Hours', 'Flight Hours', 'Source', 'Notes', 'Created At', 'Updated At', 'Raw Record JSON'].map(csvCell).join(','));
  outside.forEach((o) => {
    rows.push([
      'Outside Flying', o.id, o.pilotUid, o.pilotName, fmtDateTime(o.startAt),
      fmtDateTime(o.endAt), hours((o.endAt || 0) - (o.startAt || 0)).toFixed(2),
      hours(o.flightTimeMs).toFixed(2), o.source, o.notes,
      fmtDateTime(o.createdAt), fmtDateTime(o.updatedAt), o,
    ].map(csvCell).join(','));
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `skyway-duty-admin-${rangeDays}d-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function printAdminReport({ summaries, periods, outside, issuesById, rangeDays, generatedBy }) {
  const issueCount = new Set(periods.filter(p => (issuesById.get(p.id) || []).length).map(p => p.id)).size;
  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>Skyway Duty Report</title>
  <style>
    @page{size:landscape;margin:12mm}*{box-sizing:border-box}body{font:11px Arial,sans-serif;color:#172033;margin:0}
    h1{font-size:22px;margin:0}h2{font-size:14px;margin:22px 0 7px}.muted{color:#667085}.meta{margin-top:4px}
    .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}.kpi{border:1px solid #d0d5dd;padding:9px}
    .kpi b{display:block;font-size:18px;margin-top:3px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d0d5dd;padding:5px;text-align:left;vertical-align:top}
    th{background:#f2f4f7;font-size:9px;text-transform:uppercase}.danger{color:#b42318;font-weight:bold}.warn{color:#b54708}.footer{margin-top:18px;border-top:1px solid #d0d5dd;padding-top:8px;font-size:9px;color:#667085}
  </style></head><body>
  <h1>Skyway Aviation · Administrator Duty Report</h1>
  <div class="meta muted">${esc(rangeDays)}-day window · Generated ${esc(new Date().toLocaleString())} by ${esc(generatedBy || 'Administrator')}</div>
  <div class="kpis">
    <div class="kpi">Pilots<b>${summaries.length}</b></div>
    <div class="kpi">Duty records<b>${periods.length}</b></div>
    <div class="kpi">Outside-flying records<b>${outside.length}</b></div>
    <div class="kpi">Records to review<b class="${issueCount ? 'danger' : ''}">${issueCount}</b></div>
  </div>
  <h2>Pilot summary</h2>
  <table><thead><tr><th>Pilot</th><th>Current</th><th>Legality</th><th>Periods</th><th>Duty</th><th>Flight</th><th>Outside</th><th>Avg rest</th><th>Exceptions</th><th>Edits</th></tr></thead>
  <tbody>${summaries.map(p => `<tr><td>${esc(p.name)}</td><td>${p.active ? `ON · ${esc(fmtHours(durationMs(p.active)))}` : 'Off'}</td><td>${esc(p.legality.status)}</td><td>${p.periodCount}</td><td>${esc(fmtHours(p.dutyMs))}</td><td>${esc(fmtHours(p.flightMs))}</td><td>${esc(fmtHours(p.outsideFlightMs))}</td><td>${Number.isFinite(p.avgRestMs) ? esc(fmtHours(p.avgRestMs)) : '—'}</td><td>${p.exceptions + p.dataIssues}</td><td>${p.edits}</td></tr>`).join('')}</tbody></table>
  <h2>Duty ledger</h2>
  <table><thead><tr><th>Pilot</th><th>Duty on</th><th>Duty off</th><th>Duty</th><th>Flight</th><th>Prior rest</th><th>Tail / trip</th><th>Crew / assignment</th><th>Confirmation</th><th>Override</th><th>Findings</th></tr></thead>
  <tbody>${periods.map(p => {
    const findings = issuesById.get(p.id) || [];
    return `<tr><td>${esc(p.pilotName)}</td><td>${esc(fmtDateTime(p.dutyOnAt))}</td><td>${esc(p.status === 'on' ? 'OPEN' : fmtDateTime(p.dutyOffAt))}</td><td>${esc(fmtHours(durationMs(p)))}</td><td>${esc(fmtHours(p.flightTimeMs))}</td><td>${Number.isFinite(p.priorRestMs) ? esc(fmtHours(p.priorRestMs)) : 'Missing'}</td><td>${esc(p.tail || '—')}<br>${esc(p.tripId || '')}</td><td>${esc(p.role || '—')} · ${esc(p.crewType || '—')}<br>${esc(p.assignmentType || '—')}</td><td>${esc(p.confirmStatus || 'legacy')}</td><td>${esc(p.overrideStatus || 'none')}</td><td class="${findings.some(i => i.tone === 'danger') ? 'danger' : findings.length ? 'warn' : ''}">${esc(findings.map(i => i.label).join('; ') || 'None')}</td></tr>`;
  }).join('')}</tbody></table>
  <div class="footer">
    Active legality checks shown by the application: 10-hour rest window, 14-hour regular duty, and quarterly 13×24-hour rest.
    The rolling 8/10-hour flight-time check is disabled in the production engine because the available period-level data cannot place flight time accurately inside a rolling 24-hour window.
    Per-record 8/10-hour overages are still flagged in this report. Prior rest is pilot-attested and shown separately from computed gaps.
  </div>
  <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250))</script>
  </body></html>`;
  const win = window.open('', '_blank');
  if (!win) throw new Error('Pop-up blocked. Allow pop-ups to print the duty report.');
  win.document.open();
  win.document.write(html);
  win.document.close();
}

export default function AdminDutyReport({ currentUser, users = [], onOpenAdminTools }) {
  const [periods, setPeriods] = useState([]);
  const [outside, setOutside] = useState([]);
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [outsideLoaded, setOutsideLoaded] = useState(false);
  const [rangeDays, setRangeDays] = useState(30);
  const [pilotFilter, setPilotFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Pull the full retention window once so the legality engine has enough
  // history for quarterly rest even when the visible report is only 7 days.
  useEffect(() => {
    const unsubPeriods = subscribeDutyReportForAllPilots(RETENTION_DAYS, (list) => {
      setPeriods(list);
      setPeriodsLoaded(true);
    });
    const unsubOutside = subscribeOutsideReportForAllPilots(RETENTION_DAYS, (list) => {
      setOutside(list);
      setOutsideLoaded(true);
    });
    return () => {
      unsubPeriods?.();
      unsubOutside?.();
    };
  }, []);

  const periodById = useMemo(() => new Map(periods.map(p => [p.id, p])), [periods]);
  const overlapIds = useMemo(() => findOverlaps(periods, now), [periods, now]);
  const issuesById = useMemo(() => {
    const map = new Map();
    periods.forEach((p) => map.set(p.id, recordIssues(p, periodById, overlapIds, now)));
    return map;
  }, [periods, periodById, overlapIds, now]);

  const cutoff = now - rangeDays * MS_DAY;
  const rangePeriods = useMemo(
    () => periods.filter(p => Number.isFinite(p.dutyOnAt) && p.dutyOnAt >= cutoff),
    [periods, cutoff],
  );
  const rangeOutside = useMemo(
    () => outside.filter(o => Number.isFinite(o.startAt) && o.startAt >= cutoff),
    [outside, cutoff],
  );

  const pilots = useMemo(() => {
    const map = new Map();
    users.forEach((u) => {
      if (['crew', 'pilot'].includes(String(u.role || '').toLowerCase())) {
        map.set(u.uid || u.id, { uid: u.uid || u.id, name: u.name || u.displayName || u.email });
      }
    });
    periods.forEach((p) => {
      if (p.pilotUid && !map.has(p.pilotUid)) {
        map.set(p.pilotUid, { uid: p.pilotUid, name: p.pilotName || p.pilotUid });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [users, periods]);

  const pilotSummaries = useMemo(() => pilots.map((pilot) => {
    const allPilotPeriods = periods.filter(p => p.pilotUid === pilot.uid);
    const visiblePeriods = rangePeriods.filter(p => p.pilotUid === pilot.uid);
    const allPilotOutside = outside.filter(o => o.pilotUid === pilot.uid);
    const visibleOutside = rangeOutside.filter(o => o.pilotUid === pilot.uid);
    const active = allPilotPeriods.find(p => p.status === 'on' && confirmationCounts(p));
    const legality = evaluateCurrent(
      allPilotPeriods,
      allPilotOutside,
      now,
      active?.crewType || 'two',
    );
    const dutyMs = visiblePeriods
      .filter(confirmationCounts)
      .reduce((sum, p) => sum + durationMs(p, now), 0);
    const flightMs = visiblePeriods
      .filter(confirmationCounts)
      .reduce((sum, p) => sum + (p.flightTimeMs || 0), 0);
    const outsideFlightMs = visibleOutside.reduce((sum, o) => sum + (o.flightTimeMs || 0), 0);
    const rests = visiblePeriods.map(p => p.priorRestMs).filter(Number.isFinite);
    const exceptions = visiblePeriods.reduce((sum, p) => (
      sum + (issuesById.get(p.id) || []).filter(i => i.kind === 'compliance').length
    ), 0);
    const dataIssues = visiblePeriods.reduce((sum, p) => (
      sum + (issuesById.get(p.id) || []).filter(i => i.kind === 'data').length
    ), 0);
    return {
      ...pilot,
      active,
      legality,
      periodCount: visiblePeriods.length,
      dutyMs,
      flightMs,
      outsideFlightMs,
      avgRestMs: rests.length ? rests.reduce((a, b) => a + b, 0) / rests.length : null,
      exceptions,
      dataIssues,
      edits: visiblePeriods.reduce((sum, p) => sum + (p.adminEdits?.length || 0), 0),
    };
  }), [pilots, periods, rangePeriods, outside, rangeOutside, now, issuesById]);

  const filteredPeriods = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rangePeriods.filter((p) => {
      if (pilotFilter !== 'all' && p.pilotUid !== pilotFilter) return false;
      const issues = issuesById.get(p.id) || [];
      if (statusFilter === 'active' && p.status !== 'on') return false;
      if (statusFilter === 'closed' && p.status !== 'off') return false;
      if (statusFilter === 'pending' && p.confirmStatus !== 'pending') return false;
      if (statusFilter === 'exceptions' && issues.length === 0) return false;
      if (!q) return true;
      return [
        p.pilotName, p.location, p.tail, p.tripId, p.role, p.assignmentType,
        p.confirmStatus, p.overrideStatus, p.excursionReason,
      ].some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [rangePeriods, pilotFilter, statusFilter, search, issuesById]);

  const filteredOutside = useMemo(() => rangeOutside.filter(o => (
    pilotFilter === 'all' || o.pilotUid === pilotFilter
  )), [rangeOutside, pilotFilter]);

  const activeCount = periods.filter(p => p.status === 'on' && confirmationCounts(p)).length;
  const totalDutyMs = rangePeriods.filter(confirmationCounts).reduce((s, p) => s + durationMs(p, now), 0);
  const totalFlightMs = rangePeriods.filter(confirmationCounts).reduce((s, p) => s + (p.flightTimeMs || 0), 0)
    + rangeOutside.reduce((s, o) => s + (o.flightTimeMs || 0), 0);
  const exceptionRecords = rangePeriods.filter(p => (
    (issuesById.get(p.id) || []).some(i => i.kind === 'compliance')
  ));
  const dataIssueRecords = rangePeriods.filter(p => (
    (issuesById.get(p.id) || []).some(i => i.kind === 'data')
  ));
  const rangeOverlapCount = rangePeriods.filter(p => overlapIds.has(p.id)).length;
  const rangeAuditEdits = rangePeriods.reduce((s, p) => s + (p.adminEdits?.length || 0), 0);

  if (!periodsLoaded || !outsideLoaded) return <Spinner label="Loading complete duty report…" />;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <PageHeader
        title="Duty reporting"
        subtitle={`Administrator view · ${rangeDays}-day operational window · legality evaluated against ${RETENTION_DAYS} days of retained history`}
        actions={(
          <>
            <Button variant="outline" size="sm" icon={Download} onClick={() => downloadReportCsv(filteredPeriods, filteredOutside, issuesById, rangeDays)}>
              Export filtered CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon={FileText}
              onClick={() => {
                try {
                  printAdminReport({
                    summaries: pilotSummaries.filter(p => pilotFilter === 'all' || p.uid === pilotFilter),
                    periods: filteredPeriods,
                    outside: filteredOutside,
                    issuesById,
                    rangeDays,
                    generatedBy: currentUser?.name,
                  });
                } catch (err) {
                  notify.error(err?.message || 'Could not open printable report');
                }
              }}
            >
              Print / PDF
            </Button>
            {onOpenAdminTools && (
              <Button variant="primary" size="sm" icon={FileText} onClick={onOpenAdminTools}>
                Admin tools
              </Button>
            )}
          </>
        )}
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-edge bg-surface p-3">
        <FilterSelect label="Range" value={String(rangeDays)} onChange={(v) => setRangeDays(Number(v))}>
          {RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </FilterSelect>
        <FilterSelect label="Pilot" value={pilotFilter} onChange={setPilotFilter}>
          <option value="all">All pilots</option>
          {pilots.map(p => <option key={p.uid} value={p.uid}>{p.name}</option>)}
        </FilterSelect>
        <FilterSelect label="Records" value={statusFilter} onChange={setStatusFilter}>
          <option value="all">All records</option>
          <option value="active">Active duty</option>
          <option value="closed">Closed</option>
          <option value="pending">Pending confirmation</option>
          <option value="exceptions">Needs review</option>
        </FilterSelect>
        <label className="min-w-[220px] flex-1">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">Search</span>
          <span className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Pilot, tail, trip, location…"
              className="h-10 w-full rounded-lg border border-edge bg-surface-sunken pl-9 pr-3 text-sm text-content outline-none focus:border-accent-border"
            />
          </span>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricTile label="On duty now" value={activeCount} icon={Activity} tone={activeCount ? 'accent' : 'neutral'} />
        <MetricTile label="Duty periods" value={rangePeriods.length} icon={Clock} />
        <MetricTile label="Duty hours" value={hours(totalDutyMs).toFixed(1)} icon={Clock} />
        <MetricTile label="Flight hours" value={hours(totalFlightMs).toFixed(1)} icon={Plane} />
        <MetricTile
          label="Records to review"
          value={new Set([...exceptionRecords, ...dataIssueRecords].map(p => p.id)).size}
          icon={AlertTriangle}
          tone={exceptionRecords.length ? 'danger' : dataIssueRecords.length ? 'warning' : 'success'}
        />
      </div>

      <Card className="border-info-border bg-info-soft">
        <div className="flex items-start gap-3">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-info" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-content">Compliance scope and data confidence</h2>
            <p className="mt-1 text-2xs leading-relaxed text-content-muted">
              Current legality evaluates the 10-hour rest window, 14-hour regular-duty limit,
              and quarterly 13×24-hour rest requirement against the full retained history.
              The rolling 8/10-hour flight-time check is intentionally disabled in the live
              engine because period-level totals cannot be placed accurately inside a rolling
              24-hour window. This report still flags any single record over its 8/10-hour limit.
              Prior rest is pilot-attested; missing or below-10-hour entries are shown as findings.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StatusChip tone="danger" size="sm">{exceptionRecords.length} compliance record{exceptionRecords.length === 1 ? '' : 's'}</StatusChip>
              <StatusChip tone="warning" size="sm">{dataIssueRecords.length} data-quality record{dataIssueRecords.length === 1 ? '' : 's'}</StatusChip>
              <StatusChip tone="neutral" size="sm">{rangeOverlapCount} overlapping record{rangeOverlapCount === 1 ? '' : 's'}</StatusChip>
              <StatusChip tone="neutral" size="sm">
                {rangeAuditEdits} audit edit{rangeAuditEdits === 1 ? '' : 's'}
              </StatusChip>
            </div>
          </div>
        </div>
      </Card>

      <section>
        <SectionHeading
          icon={AlertTriangle}
          title="Requires attention"
          count={new Set([...exceptionRecords, ...dataIssueRecords].map(p => p.id)).size}
        />
        {[...new Map([...exceptionRecords, ...dataIssueRecords].map(p => [p.id, p])).values()].length === 0 ? (
          <Card><EmptyState icon={CheckCircle2} title="No exceptions in this range" description="No compliance or data-quality findings were detected." /></Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {[...new Map([...exceptionRecords, ...dataIssueRecords].map(p => [p.id, p])).values()]
              .slice(0, 12)
              .map((p) => (
                <ExceptionCard
                  key={p.id}
                  period={p}
                  issues={issuesById.get(p.id) || []}
                  onOpen={() => setSelectedPeriod(p)}
                />
              ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading icon={Users} title="Pilot summary" count={pilotSummaries.length} />
        <div className="overflow-x-auto rounded-xl border border-edge bg-surface">
          <table className="min-w-[1000px] w-full text-left">
            <thead className="bg-surface-sunken text-[10px] uppercase tracking-wider text-content-subtle">
              <tr>
                {['Pilot', 'Current', 'Legality', 'Periods', 'Duty', 'Flight', 'Outside', 'Avg rest', 'Exceptions', 'Edits'].map(h => (
                  <th key={h} className="px-3 py-2.5 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {pilotSummaries.map((p) => (
                <tr key={p.uid} className="text-xs text-content">
                  <td className="px-3 py-3 font-semibold">{p.name}</td>
                  <td className="px-3 py-3">
                    {p.active ? <StatusChip tone="accent" size="sm">On duty · {fmtHours(durationMs(p.active))}</StatusChip> : <span className="text-content-subtle">Off duty</span>}
                  </td>
                  <td className="px-3 py-3"><StatusChip tone={statusTone(p.legality.status)} size="sm">{p.legality.status}</StatusChip></td>
                  <td className="px-3 py-3 font-mono">{p.periodCount}</td>
                  <td className="px-3 py-3 font-mono">{fmtHours(p.dutyMs)}</td>
                  <td className="px-3 py-3 font-mono">{fmtHours(p.flightMs)}</td>
                  <td className="px-3 py-3 font-mono">{fmtHours(p.outsideFlightMs)}</td>
                  <td className="px-3 py-3 font-mono">{Number.isFinite(p.avgRestMs) ? fmtHours(p.avgRestMs) : '—'}</td>
                  <td className="px-3 py-3">
                    <span className={p.exceptions ? 'text-danger' : p.dataIssues ? 'text-warning' : 'text-success'}>
                      {p.exceptions + p.dataIssues}
                    </span>
                  </td>
                  <td className="px-3 py-3 font-mono text-content-muted">{p.edits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionHeading icon={FileText} title="Duty ledger" count={filteredPeriods.length} />
        <div className="overflow-hidden rounded-xl border border-edge bg-surface">
          {filteredPeriods.length === 0 ? (
            <EmptyState icon={FileText} title="No matching records" description="Change the range or filters to see duty periods." />
          ) : (
            <div className="divide-y divide-edge">
              {filteredPeriods.map((p) => (
                <DutyLedgerRow
                  key={p.id}
                  period={p}
                  issues={issuesById.get(p.id) || []}
                  onOpen={() => setSelectedPeriod(p)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section>
        <SectionHeading icon={Plane} title="Outside commercial flying" count={filteredOutside.length} />
        <div className="overflow-hidden rounded-xl border border-edge bg-surface">
          {filteredOutside.length === 0 ? (
            <EmptyState icon={Plane} title="No outside flying reported" description="No entries were recorded in this range for the selected pilot filter." />
          ) : filteredOutside.map(o => (
            <div key={o.id} className="grid gap-2 border-b border-edge px-4 py-3 text-xs last:border-b-0 sm:grid-cols-[1.3fr_1fr_1fr_1fr_2fr]">
              <div><strong className="text-content">{o.pilotName || 'Unknown'}</strong><div className="text-content-subtle">{o.source || 'Unspecified source'}</div></div>
              <div className="font-mono text-content-muted">{fmtDateTime(o.startAt)}</div>
              <div className="font-mono text-content-muted">{fmtDateTime(o.endAt)}</div>
              <div className="font-mono text-content">{fmtHours(o.flightTimeMs)} flight</div>
              <div className="text-content-muted">{o.notes || 'No notes'}</div>
            </div>
          ))}
        </div>
      </section>

      {selectedPeriod && (
        <DutyRecordDrawer
          period={selectedPeriod}
          issues={issuesById.get(selectedPeriod.id) || []}
          partner={selectedPeriod.partnerPeriodId ? periodById.get(selectedPeriod.partnerPeriodId) : null}
          onClose={() => setSelectedPeriod(null)}
        />
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="min-w-[150px]">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-content-subtle">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-lg border border-edge bg-surface-sunken px-3 text-sm text-content outline-none focus:border-accent-border"
      >
        {children}
      </select>
    </label>
  );
}

function SectionHeading({ icon: Icon, title, count }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <Icon className="h-4 w-4 text-content-muted" />
      <h2 className="text-sm font-semibold text-content">{title}</h2>
      <span className="font-mono text-2xs text-content-subtle">{count}</span>
    </div>
  );
}

function ExceptionCard({ period, issues, onOpen }) {
  const danger = issues.some(i => i.tone === 'danger');
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        'rounded-xl border p-4 text-left transition-colors hover:border-edge-strong',
        danger ? 'border-danger-border bg-danger-soft' : 'border-warning-border bg-warning-soft',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-content">{period.pilotName || 'Unknown pilot'}</p>
          <p className="mt-0.5 font-mono text-2xs text-content-muted">
            {fmtDateTime(period.dutyOnAt)} · {period.tail || 'No tail'} · {period.role || 'No role'}
          </p>
        </div>
        <StatusChip tone={danger ? 'danger' : 'warning'} size="sm">{issues.length} finding{issues.length === 1 ? '' : 's'}</StatusChip>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {issues.slice(0, 4).map(i => <StatusChip key={i.code} tone={i.tone} size="sm">{i.label}</StatusChip>)}
        {issues.length > 4 && <StatusChip size="sm">+{issues.length - 4}</StatusChip>}
      </div>
    </button>
  );
}

function DutyLedgerRow({ period, issues, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const danger = issues.some(i => i.tone === 'danger');
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="grid w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised md:grid-cols-[1.3fr_1.1fr_0.8fr_0.8fr_0.8fr_auto]"
      >
        <div>
          <p className="text-sm font-semibold text-content">{period.pilotName || 'Unknown'}</p>
          <p className="font-mono text-[10px] text-content-subtle">{period.id}</p>
        </div>
        <div className="font-mono text-2xs text-content-muted">
          {fmtDateTime(period.dutyOnAt)}
          <span className="block">{period.status === 'on' ? 'Open' : `→ ${fmtDateTime(period.dutyOffAt)}`}</span>
        </div>
        <div className="font-mono text-xs text-content">{fmtHours(durationMs(period))}<span className="block text-[10px] text-content-subtle">duty</span></div>
        <div className="font-mono text-xs text-content">{fmtHours(period.flightTimeMs)}<span className="block text-[10px] text-content-subtle">flight</span></div>
        <div className="text-2xs text-content-muted">{period.tail || '—'} · {period.role || '—'}<span className="block">{period.location || 'No location'}</span></div>
        <div className="flex items-center justify-end gap-2">
          {issues.length > 0 && <StatusChip tone={danger ? 'danger' : 'warning'} size="sm">{issues.length}</StatusChip>}
          {expanded ? <ChevronUp className="h-4 w-4 text-content-subtle" /> : <ChevronDown className="h-4 w-4 text-content-subtle" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-edge bg-surface-sunken px-4 py-3">
          <div className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Confirmation" value={period.confirmStatus || 'Legacy self-attested'} />
            <Detail label="Fit for duty" value={period.fitForDuty === true ? 'Yes' : String(period.fitForDuty ?? 'Missing')} />
            <Detail label="Prior rest" value={Number.isFinite(period.priorRestMs) ? fmtHours(period.priorRestMs) : 'Missing'} />
            <Detail label="Crew / assignment" value={`${period.crewType || '—'} / ${period.assignmentType || '—'}`} />
            <Detail label="Trip ID" value={period.tripId || '—'} mono />
            <Detail label="Partner period" value={period.partnerPeriodId || '—'} mono />
            <Detail label="Override" value={period.overrideStatus || 'none'} />
            <Detail label="Audit edits" value={String(period.adminEdits?.length || 0)} />
          </div>
          {issues.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {issues.map(i => <StatusChip key={i.code} tone={i.tone} size="sm">{i.label}</StatusChip>)}
            </div>
          )}
          <Button variant="ghost" size="sm" className="mt-2" onClick={onOpen}>View complete record</Button>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value, mono = false }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-content-subtle">{label}</p>
      <p className={cx('mt-0.5 break-words text-content', mono && 'font-mono text-2xs')}>{value}</p>
    </div>
  );
}

function DutyRecordDrawer({ period, issues, partner, onClose }) {
  const fields = [
    ['Record ID', period.id, true],
    ['Pilot UID', period.pilotUid, true],
    ['Pilot name', period.pilotName],
    ['Status', period.status],
    ['Confirmation', period.confirmStatus || 'Legacy self-attested'],
    ['Fit for duty', period.fitForDuty === true ? 'Yes' : String(period.fitForDuty ?? 'Missing')],
    ['Duty on', fmtDateTime(period.dutyOnAt)],
    ['Duty off', period.status === 'on' ? 'Still open' : fmtDateTime(period.dutyOffAt)],
    ['Duty duration', fmtHours(durationMs(period))],
    ['Prior rest', Number.isFinite(period.priorRestMs) ? fmtHours(period.priorRestMs) : 'Missing'],
    ['Flight time', fmtHours(period.flightTimeMs)],
    ['Location', period.location || '—'],
    ['Tail', period.tail || '—'],
    ['Trip ID', period.tripId || '—', true],
    ['Role', period.role || '—'],
    ['Crew type', period.crewType || '—'],
    ['Assignment type', period.assignmentType || '—'],
    ['Excursion reason', period.excursionReason || '—'],
    ['Partner period', period.partnerPeriodId || '—', true],
    ['Partner pilot', partner?.pilotName || '—'],
    ['Pending created by', period.pendingCreatedBy || '—', true],
    ['Confirmed at', fmtDateTime(period.confirmedAt)],
    ['Declined at', fmtDateTime(period.declinedAt)],
    ['Decline reason', period.declinedReason || '—'],
    ['Override status', period.overrideStatus || 'none'],
    ['Override requested by', period.overrideRequestedBy || '—'],
    ['Override requested at', fmtDateTime(period.overrideRequestedAt)],
    ['Override request reason', period.overrideRequestReason || '—'],
    ['Override approved by', period.overrideApprovedBy || '—'],
    ['Override approved at', fmtDateTime(period.overrideApprovedAt)],
    ['Override approval notes', period.overrideApprovalNotes || '—'],
    ['Over 14 hours', period.over14 ? 'Yes' : 'No'],
    ['Created', fmtDateTime(period.createdAt)],
    ['Updated', fmtDateTime(period.updatedAt)],
  ];
  return (
    <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <aside
        className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-edge bg-surface shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-edge p-4 sw-safe-top">
          <div>
            <h2 className="text-lg font-semibold text-content">{period.pilotName || 'Duty record'}</h2>
            <p className="mt-0.5 font-mono text-2xs text-content-muted">{fmtDateTime(period.dutyOnAt)}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-2 text-content-muted hover:bg-surface-raised hover:text-content" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {issues.length > 0 && (
            <Card className="mb-4 border-warning-border bg-warning-soft">
              <p className="text-sm font-semibold text-content">Findings</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {issues.map(i => <StatusChip key={i.code} tone={i.tone} size="sm">{i.code} · {i.label}</StatusChip>)}
              </div>
            </Card>
          )}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {fields.map(([label, value, mono]) => <Detail key={label} label={label} value={value} mono={mono} />)}
          </div>
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-content">Audit trail · {period.adminEdits?.length || 0}</h3>
            {!period.adminEdits?.length ? (
              <p className="mt-2 text-xs text-content-subtle">No edits recorded.</p>
            ) : (
              <div className="mt-2 divide-y divide-edge rounded-xl border border-edge">
                {period.adminEdits.map((edit, i) => (
                  <div key={`${edit.at || i}-${i}`} className="p-3 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <strong className="text-content">{edit.field || 'Edit'}</strong>
                      <span className="font-mono text-[10px] text-content-subtle">{fmtDateTime(edit.at)}</span>
                    </div>
                    <p className="mt-1 text-content-muted">By {edit.by || 'Unknown'}</p>
                    {edit.note && <p className="mt-1 text-content">{edit.note}</p>}
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[10px] text-content-subtle">Before / after</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-surface-sunken p-2 font-mono text-[10px] text-content-muted">
                        {JSON.stringify({ from: edit.from ?? null, to: edit.to ?? null }, null, 2)}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </div>
          <details className="mt-6 rounded-xl border border-edge bg-surface-sunken">
            <summary className="cursor-pointer px-3 py-2 text-2xs font-semibold text-content-muted">
              Raw record JSON · includes imported/non-canonical fields
            </summary>
            <pre className="max-h-96 overflow-auto border-t border-edge p-3 font-mono text-[10px] leading-relaxed text-content-muted">
              {JSON.stringify(period, null, 2)}
            </pre>
          </details>
        </div>
      </aside>
    </div>
  );
}
