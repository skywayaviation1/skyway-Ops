// Presentational PASS-style pilot report. Used on the broker share page
// and in the in-app preview. It renders only the sanitized report object.

import { statusToneName } from './pilot-safety.js';

function fmtGenerated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function chipStyle(status) {
  if (status === 'Meets' || status === 'Current' || status === 'None') {
    return { background: '#e7f6ee', color: '#0f7a48' };
  }
  if (status === 'Expires in 30 Days' || status === 'Expires in 7 Days') {
    return { background: '#fff4df', color: '#9a5b04' };
  }
  if (status === 'Does Not Meet' || status === 'Expired' || status === 'Not Validated' || status === 'Yes') {
    return { background: '#fdecec', color: '#9b1c1c' };
  }
  return { background: '#f3f4f6', color: '#3c4450' };
}

function statusColor(status) {
  const tone = statusToneName(status);
  if (tone === 'current') return '#0f7a48';
  if (tone === 'soon') return '#9a5b04';
  if (tone === 'bad') return '#9b1c1c';
  return '#3c4450';
}

export function PilotRatingBadge({ rating }) {
  if (!rating) return null;
  const fail = rating.tier === 'doesNotMeet';
  const caution = rating.tier === 'caution';
  const seats = (rating.qualifiesFor || []).join(' · ');
  const label = fail ? 'DOES NOT MEET' : (seats || 'MEETS');
  const tone = fail
    ? 'border-red-500/40 text-red-200'
    : caution
      ? 'border-amber-500/40 text-amber-200'
      : 'border-emerald-500/40 text-emerald-300';
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] tracking-widest ${tone}`}
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
      title={(rating.reasons || []).join(' ')}
    >
      {label}
    </span>
  );
}

const HOUR_ROWS = [
  ['totalTime', 'Total'],
  ['pic', 'PIC'],
  ['fixedWing', 'Fixed-wing'],
  ['multiEngine', 'Multi-engine'],
  ['turbine', 'Turbine'],
  ['instrument', 'Instrument'],
  ['last90Days', '90 days'],
  ['last12Months', '12 months'],
];

export default function BrokerPilotReport({ report }) {
  if (!report) return null;
  const unmet = (report.gapAnalysis || []).filter((row) => row.picMet === false || row.sicMet === false);
  const aircraft = report.aircraft || {};
  const crew = report.crew || [];
  return (
    <article className="bg-white text-slate-900 shadow-sm" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <header className="bg-[#0c2a3a] px-5 py-4 text-white">
        <p className="text-[10px] tracking-[0.22em] text-cyan-100/80">
          {(report.criteriaName || 'REGISTERED STANDARD').toUpperCase()}
        </p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-lg leading-tight">Pilot Report</h3>
          <p className="text-xs text-slate-200">
            Generated {fmtGenerated(report.generatedAt)}
            {report.expiresAt ? ` · Expires ${fmtGenerated(report.expiresAt)}` : ''}
          </p>
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap gap-2" data-testid="report-chips">
          {(report.chips || []).map((chip) => (
            <span key={chip.id} className="px-2 py-1 text-xs font-semibold" style={chipStyle(chip.status)}>
              {chip.label}: {chip.status}
            </span>
          ))}
        </div>

        {(report.flags || []).length > 0 && (
          <p className="text-xs text-amber-800">
            Flags: {report.flags.join(' · ')}
          </p>
        )}
        <p className="text-xs text-slate-500">
          Waivers: {(report.waivers || []).length ? report.waivers.join(' · ') : 'None'}
        </p>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500">OPERATOR</h5>
          <p className="mt-1 text-sm">{report.operatorLegalName || report.operatorName || 'Not on file'}</p>
        </section>

        {report.itinerary && (
          <section>
            <h5 className="text-[10px] tracking-[0.16em] text-slate-500">ITINERARY</h5>
            <p className="mt-1 text-sm">
              {[report.itinerary.from, report.itinerary.to].filter(Boolean).join(' → ')}
              {report.itinerary.date ? ` · ${report.itinerary.date}` : ''}
              {report.itinerary.tail ? ` · ${report.itinerary.tail}` : ''}
            </p>
          </section>
        )}

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500">AIRCRAFT</h5>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Field label="Registration" value={aircraft.registration || '—'} />
            <Field label="Type" value={aircraft.type || report.aircraftType || '—'} />
            <Field label="Serial" value={aircraft.serial || '—'} />
            <Field label="Year" value={aircraft.year || '—'} />
            <Field label="Seats" value={aircraft.seats || '—'} />
            <Field label="Insurance expiry" value={aircraft.insuranceExpiry || '—'} />
          </dl>
        </section>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500">CREW</h5>
          {report.hoursAsOf && (
            <p className="mt-1 text-xs text-slate-500" data-testid="hours-as-of">
              Totals as of {report.hoursAsOf}
              {report.baselineAsOf ? ` · baseline ${report.baselineAsOf} plus flights after that date` : ''}
              {report.last6Months ? ` · last 6 months ${report.last6Months}` : ''}
              {report.landings != null ? ` · landings ${report.landings}` : ''}
            </p>
          )}
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            {crew.map((member) => (
              <CrewCard key={`${member.role}-${member.pilotName}`} member={member} />
            ))}
          </div>
        </section>

        <section>
          <h5 className="text-[10px] tracking-[0.16em] text-slate-500">GAP ANALYSIS</h5>
          {unmet.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No unmet items.</p>
          ) : (
            <table className="mt-2 w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wide text-slate-500">
                  <th className="py-1 font-medium">Item</th>
                  <th className="py-1 font-medium">Pilot</th>
                  <th className="py-1 font-medium">PIC</th>
                  <th className="py-1 font-medium">SIC</th>
                </tr>
              </thead>
              <tbody>
                {unmet.map((row) => (
                  <tr key={`${row.label}-${row.pilotValue}`} className="border-b border-slate-100">
                    <td className="py-1 pr-2">{row.label}</td>
                    <td className="py-1 pr-2">{row.pilotValue}</td>
                    <td className="py-1 pr-2" style={{ color: row.picMet ? '#0f7a48' : '#9b1c1c' }}>{row.picCriteria}</td>
                    <td className="py-1" style={{ color: row.sicMet ? '#0f7a48' : '#9b1c1c' }}>{row.sicCriteria}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <footer className="border-t border-slate-200 pt-3 text-[10px] leading-relaxed text-slate-400">
          <p>
            Criteria {report.criteriaVersion || 'registered-standard-1'}
            {report.generatedAt ? ` · Generated ${report.generatedAt}` : ''}
          </p>
          {report.shareUrl ? (
            <p className="mt-1">
              Verify this report:{' '}
              <a href={report.shareUrl} className="break-all text-slate-600 underline">{report.shareUrl}</a>
            </p>
          ) : (
            <p className="mt-1">The live verification link is on the broker share page for the trip.</p>
          )}
          <p className="mt-2">
            {report.usingDefaultStandards
              ? 'Minimums are the operator’s Wyvern Registered Standard defaults and can be replaced. This is not a live WYVERN Ltd audit.'
              : 'Minimums are the operator’s saved Registered Standard settings.'}
            {' '}Certificate numbers, date of birth, and addresses are omitted.
          </p>
        </footer>
      </div>
    </article>
  );
}

function CrewCard({ member }) {
  const hours = member.hours || {};
  return (
    <div className="border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] tracking-widest text-slate-500">{member.role}</div>
          <div className="text-base">{member.pilotName}</div>
        </div>
        <span className="px-2 py-1 text-[10px] font-semibold" style={chipStyle(member.status)}>{member.status}</span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Field label="Certificate" value={member.certificateType} />
        <Field label="Country" value={member.country} />
        <Field label="Type rating" value={member.typeRating} />
        <Field label="Medical" value={`${member.medicalClass || '—'} · ${member.medicalStatus || '—'}`} />
        <Field label="Last medical" value={member.lastMedical || '—'} />
        <Field label="Employment" value={member.employment} />
        <Field label="Accident / incident" value={member.accident} />
        <Field label="Enforcement" value={member.enforcement} />
      </dl>
      <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
        {HOUR_ROWS.map(([key, label]) => (
          <div key={key} className="flex justify-between gap-2 border border-slate-100 px-1.5 py-1">
            <span className="text-slate-500">{label}</span>
            <span>{hours[key] || '—'}</span>
          </div>
        ))}
        <div className="flex justify-between gap-2 border border-slate-100 px-1.5 py-1">
          <span className="text-slate-500">Time in type</span>
          <span>{member.timeInType || '—'}</span>
        </div>
        <div className="flex justify-between gap-2 border border-slate-100 px-1.5 py-1">
          <span className="text-slate-500">PIC in type</span>
          <span>{member.picTimeInType || '—'}</span>
        </div>
      </div>
      <ul className="mt-2 space-y-1 text-xs">
        {(member.checks || []).map((check) => (
          <li key={check.label} className="flex justify-between gap-2">
            <span>{check.label}</span>
            <span style={{ color: statusColor(check.status) }}>{check.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="truncate">{value || '—'}</dd>
    </div>
  );
}
