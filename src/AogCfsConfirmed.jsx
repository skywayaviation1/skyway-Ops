// Shown on TripDetail for the open leg. The same object is stored on every
// leg of the trip, so opening any leg shows the confirmation. CFS cost stays
// off this view.

import { fmtMoney } from './aog-recovery.js';

function when(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function AogCfsConfirmedMark({ acknowledgement, legLabel, tripId }) {
  if (!acknowledgement || acknowledgement.status !== 'cfs_confirmed') return null;
  const percent = acknowledgement.acceptedCoveragePercent;
  const limit = Number.isInteger(acknowledgement.acceptedCoverageLimitCents)
    ? fmtMoney(acknowledgement.acceptedCoverageLimitCents / 100)
    : '';
  const date = when(acknowledgement.confirmedAt);
  return (
    <div role="status" className="rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm text-content">
      <p className="font-semibold text-success">AOG coverage confirmed by Charter Flight Support</p>
      <p className="mt-1 text-xs text-content-muted">
        {tripId ? `Trip ${tripId} · ` : ''}
        Accepted {percent}%{limit ? ` up to ${limit}` : ''}
        {date ? ` · ${date}` : ''}
      </p>
      {legLabel && <p className="mt-1 text-xs text-content-muted">This leg: {legLabel}</p>}
      {acknowledgement.shortfall && (
        <p className="mt-1 text-xs font-medium text-warning">Accepted coverage is below what was requested.</p>
      )}
    </div>
  );
}
