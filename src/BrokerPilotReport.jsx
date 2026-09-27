// Presentational pilot report. Used on the broker share page and in the
// in-app preview. It renders only the sanitized report object — there is
// no path from here back to a logbook, a certificate file, or a medical date.

import { TIER_LABELS } from './pilot-safety.js';

function fmtGenerated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function tierTone(tier) {
  if (tier === 'meets') return { bg: '#e7f6ee', fg: '#0f7a48', label: TIER_LABELS.meets };
  if (tier === 'caution') return { bg: '#fff4df', fg: '#9a5b04', label: TIER_LABELS.caution };
  return { bg: '#fdecec', fg: '#9b1c1c', label: TIER_LABELS.doesNotMeet };
}

function statusTone(status) {
  if (status === 'Current' || status === 'Valid' || status === 'Yes') return '#0f7a48';
  if (status === 'Expiring soon') return '#9a5b04';
  if (status === 'Expired' || status === 'Not on file' || status === 'No') return '#9b1c1c';
  return '#3c4450';
}

export function PilotRatingBadge({ rating }) {
  if (!rating) return null;
  const tone = rating.tier === 'meets'
    ? 'border-emerald-500/40 text-emerald-300'
    : rating.tier === 'caution'
      ? 'border-amber-500/40 text-amber-200'
      : 'border-red-500/40 text-red-200';
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] tracking-widest ${tone}`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
      title={(rating.reasons || []).join(' ')}
    >
      {rating.score} {rating.tierLabel}
    </span>
  );
}

export default function BrokerPilotReport({ report }) {
  if (!report) return null;
  const tone = tierTone(report.tier);
  const cert = report.certificate || {};
  const medical = report.medical || {};
  return (
    <article className="bg-white text-slate-900 shadow-sm" style={{ fontFamily: 'Georgia, "Iowan Old Style", serif' }}>
      <header className="flex items-start justify-between gap-4 bg-[#0c2a3a] px-5 py-4 text-white">
        <div>
          <p className="text-[10px] tracking-[0.22em] text-cyan-100/80" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {(report.operatorName || 'OPERATOR').toUpperCase()}
          </p>
          <h3 className="mt-1 text-lg leading-tight">Pilot Report</h3>
          <p className="mt-1 text-xs text-slate-200" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {report.operatorLegalName || report.operatorName}
          </p>
        </div>
        <div className="text-right">
          <div className="inline-block px-2 py-1 text-xs font-semibold" style={{ background: tone.bg, color: tone.fg, fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {report.tierLabel || tone.label}
          </div>
          <p className="mt-1 text-sm" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {report.score ?? '—'}
            <span className="text-slate-300"> / 100</span>
          </p>
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-200 pb-3">
          <div>
            <h4 className="text-xl leading-tight">{report.pilotName}</h4>
            <p className="text-xs text-slate-500" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
              {[report.role, report.aircraftType].filter(Boolean).join(' · ') || 'Crew'}
            </p>
          </div>
          <p className="text-xs text-slate-500" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            Generated {fmtGenerated(report.generatedAt)}
          </p>
        </div>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>CERTIFICATE AND RATINGS</h5>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            <Field label="Certificate" value={cert.level || 'Not on file'} />
            <Field label="Instrument" value={cert.instrument || 'Not on file'} />
            <Field label="Multi-engine" value={cert.multiEngine || 'Not on file'} />
            <Field label="Type ratings" value={(cert.typeRatings || []).join(', ') || 'None on file'} />
            <Field label="Medical" value={`${medical.class || 'Not on file'} · ${medical.status || 'Not on file'}`} />
          </dl>
        </section>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>FLIGHT TIME</h5>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {(report.hours || []).map((row) => (
              <div key={row.label} className="border border-slate-200 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{row.label}</div>
                <div className="text-sm">
                  {row.hours || '—'}
                  {row.minimum != null && <span className="text-slate-400"> / {row.minimum}</span>}
                </div>
              </div>
            ))}
          </div>
          {(report.timeInType || []).length > 0 && (
            <p className="mt-2 text-xs text-slate-600" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
              Time in type:{' '}
              {report.timeInType.map((entry) => `${entry.type} ${entry.hours || '—'}`).join(' · ')}
              {report.timeInTypeScored?.detail ? ` (${report.timeInTypeScored.detail})` : ''}
            </p>
          )}
        </section>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>REQUIREMENTS</h5>
          <table className="mt-2 w-full text-left text-xs" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            <thead>
              <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
                <th className="py-1 font-medium">Item</th>
                <th className="py-1 font-medium">Status</th>
                <th className="py-1 font-medium">Completed</th>
                <th className="py-1 font-medium">Due</th>
              </tr>
            </thead>
            <tbody>
              {(report.requirements || []).map((item) => (
                <tr key={item.label} className="border-b border-slate-100">
                  <td className="py-1 pr-2">{item.label}</td>
                  <td className="py-1 pr-2" style={{ color: statusTone(item.status) }}>{item.status}</td>
                  <td className="py-1 pr-2 text-slate-500">{item.completedOn || '—'}</td>
                  <td className="py-1 text-slate-500">{item.dueOn || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>WHY THIS RATING</h5>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-700" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {(report.summary || []).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-400" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            {report.usingDefaultStandards
              ? 'Hour minimums are the operator’s shipped defaults: industry-typical Part 135 charter figures, not a third-party audit score.'
              : 'Hour minimums are the operator’s saved safety-rating settings.'}
            {' '}Certificate numbers, date of birth, home address, and medical detail beyond class and validity are omitted.
          </p>
        </section>
      </div>
    </article>
  );
}

function Field({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  );
}
