// Glass chrome for single-flight tracking. The map stays full bleed underneath.
// Omitted on purpose: AOG, flight-issue notes, FBO confirmation, cabin class,
// and notifications. Those have no honest control on this screen.

import React from 'react';
import { ChevronLeft, Plane } from 'lucide-react';
import { flightCategoryStyle } from './tracking-map.js';
import { airportClock, formatSpan } from './tracking-flight.js';
import { cx } from './ui.jsx';

function TileCode({ code }) {
  const text = String(code || '——').toUpperCase();
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
      {text.split('').map((glyph, index) => (
        <span key={`${glyph}-${index}`} className="sw-route-tile">{glyph}</span>
      ))}
    </span>
  );
}

function Glass({ children, className }) {
  return <section className={cx('sw-flight-glass', className)}>{children}</section>;
}

function CardTitle({ children, extra }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">{children}</h3>
      {extra}
    </div>
  );
}

function fmtSignal(ms) {
  if (!Number.isFinite(ms)) return 'Awaiting signal';
  const delta = Date.now() - ms;
  if (delta < 45_000) return 'Live signal · just now';
  if (delta < 3600_000) return `Live signal · ${Math.max(1, Math.round(delta / 60000))}m ago`;
  return `Signal ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function clockLabel(clock) {
  if (!clock) return '—';
  return clock.label;
}

export default function TrackingFlightChrome({
  model,
  weather,
  aloft,
  advisories,
  wide,
  timelineOpen,
  onToggleTimeline,
  onBack,
}) {
  if (!model) return null;
  const originWx = weather?.[model.originCode] || weather?.[String(model.originCode || '').replace(/^K/, '')] || null;
  const destWx = weather?.[model.destinationCode] || null;
  const remain = formatSpan(model.remainingMs);
  const elapsed = formatSpan(model.elapsedMs);
  const progress = Number.isFinite(model.progress) ? model.progress : 0;
  const identBits = [
    model.segmentId ? { label: 'Segment', value: model.segmentId } : null,
    model.tripId ? { label: 'Trip', value: model.tripId } : null,
    model.customer ? { label: 'Customer', value: model.customer } : null,
    model.operator ? { label: 'Operator', value: model.operator } : null,
  ].filter(Boolean);

  const left = (
    <>
      <Glass className="p-3">
        <CardTitle>Aircraft & Flights</CardTitle>
        <p className="font-mono text-lg font-semibold tracking-wide text-white">{model.tail}</p>
        <p className="mt-0.5 text-sm text-slate-300">{model.type || 'Type not set'}</p>
        {(model.originCode || model.destinationCode) && (
          <p className="mt-2 font-mono text-xs text-slate-400">
            {model.originCode || '—'}
            <span className="mx-1.5 text-fuchsia-300">→</span>
            {model.destinationCode || '—'}
          </p>
        )}
      </Glass>
      <Glass className="p-3">
        <CardTitle>Altitude & Speed</CardTitle>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="font-mono text-xl font-semibold text-white">
              {model.altitude != null ? `${Math.round(model.altitude).toLocaleString()} ft` : '—'}
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-500">Altitude</p>
          </div>
          <div>
            <p className="font-mono text-xl font-semibold text-white">
              {model.groundspeed != null ? `${Math.round(model.groundspeed)} kt` : '—'}
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-500">GS</p>
          </div>
        </div>
        <p className="mt-2 font-mono text-[10px] text-slate-500">{fmtSignal(model.polledAt)}</p>
      </Glass>
      <Glass className="p-3">
        <CardTitle>Event Timeline</CardTitle>
        <p className="font-mono text-sm font-semibold text-white">{model.currentEvent?.label || model.phaseLabel}</p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-400">
          {model.currentEvent?.at
            ? clockLabel(airportClock(model.currentEvent.at, model.originCode))
            : '—'}
        </p>
      </Glass>
    </>
  );

  const right = (
    <>
      <AdvisoryCard advisories={advisories} />
      <StationCard role="Departure" code={model.originCode} city={model.originCity} clock={model.departure} wx={originWx} />
      <AloftCard aloft={aloft} altitude={model.altitude} />
      <StationCard role="Arrival" code={model.destinationCode} city={model.destinationCity} clock={model.arrival} wx={destWx} />
    </>
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col">
      <div className="sw-flight-vignette pointer-events-none absolute inset-0" />
      <header className="sw-safe-top pointer-events-auto px-3 pt-3 sm:px-4">
        <Glass className="px-3 py-3 sm:px-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-white/10 px-2.5 text-[11px] font-medium text-slate-300 hover:bg-white/5"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Fleet
            </button>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="sr-only">{model.routeLabel || model.tail}</h2>
              <div className="flex items-center gap-2">
                <TileCode code={model.originCode || '----'} />
                <span className="font-mono text-lg text-fuchsia-300 sm:text-2xl">→</span>
                <TileCode code={model.destinationCode || '----'} />
              </div>
              <span className={cx(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[11px] font-semibold',
                model.live
                  ? 'bg-emerald-400/15 text-emerald-300 ring-1 ring-emerald-300/40'
                  : 'bg-white/5 text-slate-300 ring-1 ring-white/10',
              )}>
                {model.live && <span className="sw-live-dot" />}
                {model.pill}
              </span>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-[12px] text-slate-300">
            <span className="font-semibold text-white">{model.tail}</span>
            {model.type && <span>{model.type}</span>}
            {model.pax != null && <span>{model.pax} pax</span>}
            {model.departure && (
              <span>
                {model.departure.date} {model.departure.label}
              </span>
            )}
            {model.arrival && (
              <span className="text-slate-400">
                → {model.arrival.date} {model.arrival.label}
              </span>
            )}
          </div>

          {identBits.length > 0 && (
            <div className="mt-2 flex gap-4 overflow-x-auto font-mono text-[10px] text-slate-500">
              {identBits.map((bit) => (
                <span key={bit.label} className="shrink-0">
                  <span className="uppercase tracking-[0.14em]">{bit.label}</span>
                  {' '}
                  <span className="text-slate-200">{bit.value}</span>
                </span>
              ))}
            </div>
          )}
        </Glass>
      </header>

      {wide ? (
        <div className="flex min-h-0 flex-1 gap-3 px-4 pt-3">
          <div className="pointer-events-auto flex h-full min-h-0 w-[17.5rem] shrink-0 flex-col gap-2 overflow-y-auto pb-2">{left}</div>
          <div className="flex-1" />
          <div className="pointer-events-auto flex h-full min-h-0 w-[17.5rem] shrink-0 flex-col gap-2 overflow-y-auto pb-2">{right}</div>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      <div className="pointer-events-auto mx-auto w-full max-w-xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Glass className="px-4 py-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="rounded-md bg-fuchsia-500/15 px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.16em] text-fuchsia-200">
              {model.phase === 'enroute' ? 'EN ROUTE' : model.phaseLabel.toUpperCase()}
            </span>
            <button
              type="button"
              onClick={onToggleTimeline}
              className="text-[11px] font-medium text-slate-300 underline decoration-white/20 underline-offset-4 hover:text-white"
            >
              {timelineOpen ? 'Hide timeline' : 'View Full Timeline'}
            </button>
          </div>
          <p className="mt-2 font-mono text-sm text-white">
            {model.live ? 'Tracking live' : model.phaseLabel}
            {model.live && remain && model.arriveCode ? ` · Arrives ${model.arriveCode} in ${remain}` : ''}
          </p>
          <div className="relative mt-3 h-1.5 rounded-full bg-white/10">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-fuchsia-400"
              style={{ width: `${Math.max(progress > 0 ? 2 : 0, progress)}%` }}
            />
            <span
              className="absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-slate-950 ring-2 ring-fuchsia-400"
              style={{ left: `${Math.min(96, Math.max(4, progress))}%` }}
            >
              <Plane className="h-3 w-3 -rotate-45 text-fuchsia-300" />
            </span>
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-slate-500">
            <span>{elapsed ? `${elapsed} elapsed` : 'Elapsed —'}</span>
            <span>{remain ? `${remain} remaining` : 'Remaining —'}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-white/10 pt-3">
            <div>
              <p className="font-mono text-sm text-white">{model.originCity || model.originCode || '—'}</p>
              <p className="font-mono text-[10px] text-slate-500">{model.originCode}</p>
              <p className="mt-1 font-mono text-[11px] text-slate-300">{clockLabel(model.departure)}</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-sm text-white">{model.destinationCity || model.destinationCode || '—'}</p>
              <p className="font-mono text-[10px] text-slate-500">{model.destinationCode}</p>
              <p className="mt-1 font-mono text-[11px] text-slate-300">{clockLabel(model.arrival)}</p>
            </div>
          </div>
          {timelineOpen && (
            <div className="mt-3 max-h-[42vh] space-y-3 overflow-y-auto border-t border-white/10 pt-3">
              {!wide && (
                <div className="grid gap-2">{left}{right}</div>
              )}
              <ol className="space-y-1.5">
                {model.timeline.length === 0 && (
                  <li className="font-mono text-[11px] text-slate-500">No status events logged yet.</li>
                )}
                {model.timeline.map((event) => (
                  <li key={event.id} className="flex items-baseline justify-between gap-3 font-mono text-[11px]">
                    <span className="text-slate-200">{event.label}</span>
                    <span className="text-slate-500">{clockLabel(airportClock(event.at, model.originCode))}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Glass>
      </div>
    </div>
  );
}

function AdvisoryCard({ advisories }) {
  const count = advisories?.count || 0;
  return (
    <Glass className="p-3">
      <CardTitle extra={count > 0 ? (
        <span className="rounded-full bg-amber-400/15 px-2 py-0.5 font-mono text-[10px] text-amber-200">{count}</span>
      ) : null}>
        Advisories
      </CardTitle>
      {count === 0 ? (
        <p className="text-sm text-slate-300">No significant NOTAMs</p>
      ) : (
        <ul className="space-y-1.5">
          {(advisories.items || []).slice(0, 3).map((item) => (
            <li key={item.id} className="text-[12px] leading-snug text-slate-200">
              <span className="font-mono text-[10px] text-slate-500">{item.icao} </span>
              {item.summary}
            </li>
          ))}
        </ul>
      )}
    </Glass>
  );
}

function StationCard({ role, code, city, clock, wx }) {
  const metar = wx?.metar || wx?.parsed || null;
  const style = flightCategoryStyle(metar?.flightCategory);
  const wind = Number.isFinite(metar?.windKt)
    ? `${Number.isFinite(metar.windDir) ? String(metar.windDir).padStart(3, '0') : 'VRB'}/${Math.round(metar.windKt)}${Number.isFinite(metar.windGustKt) ? `G${Math.round(metar.windGustKt)}` : ''} kt`
    : null;
  return (
    <Glass className="p-3">
      <CardTitle extra={metar?.flightCategory ? (
        <span className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold" style={{ color: style.dot }}>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.dot }} />
          {style.label}
        </span>
      ) : null}>
        {role}
      </CardTitle>
      <p className="font-mono text-lg font-semibold text-white">{code || '—'}</p>
      <p className="text-[12px] text-slate-400">{city || ' '}</p>
      <p className="mt-1 font-mono text-sm text-slate-100">{clockLabel(clock)}</p>
      <p className="mt-1 font-mono text-[10px] text-slate-500">{wind || (metar ? 'Wind calm' : 'No report')}</p>
    </Glass>
  );
}

function AloftCard({ aloft, altitude }) {
  const level = aloft?.level;
  const wind = level && Number.isFinite(level.windKt)
    ? `${Number.isFinite(level.windDir) ? String(level.windDir).padStart(3, '0') : '---'}/${Math.round(level.windKt)} kt`
    : null;
  return (
    <Glass className="p-3">
      <CardTitle>Aloft Conditions</CardTitle>
      {level ? (
        <>
          <p className="font-mono text-lg font-semibold text-white">
            {Math.round(level.altitude).toLocaleString()} ft
          </p>
          <p className="mt-1 font-mono text-sm text-slate-200">
            {wind}
            {Number.isFinite(level.tempC) ? ` · ${Math.round(level.tempC)}°C` : ''}
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            Nearest forecast level{Number.isFinite(altitude) ? ` to ${Math.round(altitude).toLocaleString()} ft` : ''}
          </p>
        </>
      ) : (
        <p className="text-sm text-slate-400">Winds aloft unavailable</p>
      )}
    </Glass>
  );
}
