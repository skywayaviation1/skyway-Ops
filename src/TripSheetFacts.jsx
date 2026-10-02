// Read-only rendering of the per-leg trip-sheet payload stored on trip-state.
// Only sections that actually parsed are shown.

function money(value) {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;
}

function Row({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div className="flex gap-2 text-[11px] leading-snug">
      <span className="w-16 shrink-0 text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{label}</span>
      <span className="text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>{children}</span>
    </div>
  );
}

function personLine(person) {
  if (!person?.name && !person?.email && !person?.phone) return null;
  return [person.name, person.phone, person.email].filter(Boolean).join(' · ');
}

function freqLabel(kind, value) {
  if (!value) return null;
  return `${kind || 'FREQ'} ${value}`;
}

function AirportBlock({ title, code, name, fbo, detail, address, phone, kind, frequency }) {
  if (!name && !fbo && !address && !phone && !frequency) return null;
  return (
    <div className="border border-slate-800 bg-slate-950/40 p-2 space-y-1">
      <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {title}{code ? ` · ${code}` : ''}
      </div>
      {name && <div className="text-xs text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif' }}>{name}</div>}
      {fbo && (
        <div className="text-[11px] text-cyan-200/90" style={{ fontFamily: 'DM Sans, sans-serif' }}>
          {fbo}{detail ? ` · ${detail}` : ''}
        </div>
      )}
      {address && <div className="text-[11px] text-slate-400">{address}</div>}
      {(phone || frequency) && (
        <div className="text-[10px] text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {[phone, freqLabel(kind, frequency)].filter(Boolean).join(' · ')}
        </div>
      )}
    </div>
  );
}

export default function TripSheetFacts({ data }) {
  if (!data) return null;
  const fees = data.fees && typeof data.fees === 'object' ? Object.entries(data.fees) : [];
  const fuel = data.fuel && typeof data.fuel === 'object' ? Object.entries(data.fuel) : [];
  const notes = data.airportNotes && typeof data.airportNotes === 'object' ? Object.entries(data.airportNotes) : [];
  const cateringItems = data.catering?.items || [];
  const client = data.client;
  const planner = data.planner;
  const crew = data.crew || {};

  return (
    <div className="border border-slate-800 bg-slate-900/30 p-3 space-y-3">
      <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        PARSED FROM TRIP SHEET{data.tripCode ? ` · ${data.tripCode}` : ''}
      </div>

      <div className="space-y-0.5">
        <Row label="TAIL">{[data.tail, data.aircraftType].filter(Boolean).join(' · ')}</Row>
        <Row label="PART">
          {data.partClass
            ? `${data.partClass}${data.flightNumber ? ` #${data.flightNumber}` : ''}`
            : null}
        </Row>
        <Row label="DIST">
          {[
            data.distance,
            data.blockTime ? `block ${data.blockTime}` : null,
            data.flightTime ? `flight ${data.flightTime}` : null,
            data.timeChange != null && data.timeChange !== '0' ? `TZ ${data.timeChange}` : null,
          ].filter(Boolean).join(' · ') || null}
        </Row>
        <Row label="DEP">
          {data.depTimeLocal
            ? `${data.depDate || ''} ${data.depTimeLocal} ${data.depTimeLocalTz || ''}${data.depTimeZ ? ` (${data.depTimeZ} Z)` : ''}`.trim()
            : null}
        </Row>
        <Row label="ARR">
          {data.arrTimeLocal
            ? `${data.arrDate || ''} ${data.arrTimeLocal} ${data.arrTimeLocalTz || ''}${data.arrTimeZ ? ` (${data.arrTimeZ} Z)` : ''}`.trim()
            : null}
        </Row>
        <Row label="RELEASE">
          {data.releaseText
            || (data.released ? 'Released' : null)
            || (data.vettedAt ? null : null)}
        </Row>
        <Row label="VETTING">
          {data.vettingApplicable === false
            ? 'Not applicable'
            : [
              data.vettedAt ? `Vetted ${data.vettedAt}` : null,
              data.paxCleared ? 'Passengers cleared' : null,
            ].filter(Boolean).join(' · ') || null}
        </Row>
        <Row label="PAX WT">{data.totalPaxWeight != null ? `${data.totalPaxWeight} lbs` : null}</Row>
      </div>

      {(client || planner) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {client && (
            <div className="text-[11px] text-slate-300 space-y-0.5">
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CLIENT</div>
              <div>{[client.company, client.contact].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ')}</div>
              <div className="text-slate-400">{[client.email, client.phone].filter(Boolean).join(' · ')}</div>
            </div>
          )}
          {planner && (
            <div className="text-[11px] text-slate-300 space-y-0.5">
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>PLANNER</div>
              <div>{planner.name}</div>
              <div className="text-slate-400">{[planner.email, planner.phone].filter(Boolean).join(' · ')}</div>
            </div>
          )}
        </div>
      )}

      {(crew.pic || crew.sic) && (
        <div className="space-y-0.5">
          <Row label="PIC">{personLine(crew.pic)}</Row>
          <Row label="SIC">{personLine(crew.sic)}</Row>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <AirportBlock
          title="DEPARTS"
          code={data.from}
          name={data.fromAirportName}
          fbo={data.fromFbo}
          detail={data.fromFboDetail}
          address={data.fromAddress}
          phone={data.fromAirportPhone}
          kind={data.fromFrequencyKind}
          frequency={data.fromFrequency || data.fromAirportA2G}
        />
        <AirportBlock
          title="ARRIVES"
          code={data.to}
          name={data.toAirportName}
          fbo={data.toFbo}
          detail={data.toFboDetail}
          address={data.toAddress}
          phone={data.toAirportPhone}
          kind={data.toFrequencyKind}
          frequency={data.toFrequency || data.toAirportA2G}
        />
      </div>

      {fees.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>FEES</div>
          {fees.map(([code, fee]) => (
            <div key={code} className="text-[10px] text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <span className="text-slate-500">{code}</span>
              {fee.fbo ? ` ${fee.fbo}` : ''} · L {money(fee.landing)} · P {money(fee.parking)}
              {fee.parkingWaivedNights != null ? ` (${fee.parkingWaivedNights} nt / ${fee.parkingWaivedGals} gal waiver)` : ''}
              {' · '}GH {money(fee.groundHandling)}
              {fee.groundHandlingWaivedGals != null ? ` waive @ ${fee.groundHandlingWaivedGals} gal` : ''}
              {' · '}I {money(fee.infrastructure)}
            </div>
          ))}
        </div>
      )}

      {fuel.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>FUEL</div>
          {fuel.map(([code, row]) => (
            <div key={code} className="text-[10px] text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <span className="text-slate-500">{code}</span>
              {row.brand ? ` ${row.brand}` : ''}
              {row.fbo ? ` · ${row.fbo}` : ''}
              {row.tiers?.length ? ` · ${row.tiers.map((tier) => `${tier.minGals}+: $${tier.price}`).join(' / ')}` : ''}
              {row.note ? ` · ${row.note}` : ''}
            </div>
          ))}
        </div>
      )}

      {(cateringItems.length > 0 || data.catering?.arrangedBy || data.transport) && (
        <div className="space-y-0.5">
          <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CATERING / GROUND</div>
          {data.catering?.arrangedBy && (
            <div className="text-[11px] text-slate-300">Ground transport arranged by {data.catering.arrangedBy}</div>
          )}
          {cateringItems.map((item, index) => (
            <div key={index} className="text-[11px] text-slate-300">
              {item.quantity != null ? `${item.quantity}× ` : ''}{item.description}
            </div>
          ))}
          {data.transport && (
            <div className="text-[11px] text-slate-300">
              {[data.transport.passenger, data.transport.provider, data.transport.confirmation && `#${data.transport.confirmation}`, data.transport.pickup && `pickup ${data.transport.pickup}`].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      )}

      {notes.length > 0 && (
        <div className="space-y-1">
          {notes.map(([code, note]) => (
            <div key={code} className="text-[11px] text-amber-200/80">
              <span className="text-amber-400/80" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{code}</span> {note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
