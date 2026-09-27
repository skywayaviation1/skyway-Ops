// Broker crew summary. Renders only a passing report: two green columns,
// no gap list and no failing status. Admins keep pass/fail detail in Currency.

function fmtGenerated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
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

export default function BrokerPilotReport({ report }) {
  if (!report?.crew?.length) return null;
  const asOf = report.hoursAsOf ? `Totals as of ${report.hoursAsOf}` : '';
  const generated = report.generatedAt ? `Generated ${fmtGenerated(report.generatedAt)}` : '';
  return (
    <article className="bg-white text-slate-900" data-testid="broker-crew-report" style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <header className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold tracking-wide text-slate-800">Crew</h3>
        <p className="mt-1 text-[11px] text-slate-500">{[generated, asOf].filter(Boolean).join(' · ')}</p>
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-2">
        {report.crew.map((member) => (
          <CrewColumn key={`${member.role}-${member.pilotName}`} member={member} />
        ))}
      </div>
    </article>
  );
}

function CrewColumn({ member }) {
  return (
    <section className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{member.role}</p>
      <h4 className="mt-1 text-base font-semibold text-slate-900">{member.pilotName}</h4>
      <p className="mt-1 text-xs leading-5 text-slate-600">
        {member.certificateType}
        <br />
        {member.country}
        <br />
        {member.typeRating}
        <br />
        {member.medicalClass}
        {member.lastMedical ? ` · last medical ${member.lastMedical}` : ''}
      </p>
      <dl className="mt-3 divide-y divide-slate-100 border-t border-slate-100">
        {(member.rows || []).map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 py-1.5">
            <dt className="min-w-0 text-xs text-slate-600">{row.label}</dt>
            <dd className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#e7f6ee] px-2 py-0.5 text-[11px] font-semibold text-[#0f7a48]">
              <span aria-hidden="true">✓</span>
              <span>{row.value}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
