import { useMemo, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, Building2, CheckCircle2, Clock, DollarSign,
  ExternalLink, Fuel, Loader2, MapPin, Phone, Radio, Search, Shield,
} from 'lucide-react';
import { formatLocalDate, formatLocalTime } from './airports.js';
import { mergeAirportView } from './aviowiki-merge.js';

const compactAirport = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 7);

const PAYMENT_LABELS = {
  VISA: 'Visa',
  MASTERCARD: 'Mastercard',
  AMERICAN_EXPRESS: 'Amex',
  DINERS_CLUB: 'Diners',
  JCB: 'JCB',
  DISCOVER: 'Discover',
  WORLD_FUEL_SERVICES: 'World Fuel',
  COLT: 'Colt',
  UVAIR: 'UVair',
  AVFUEL: 'Avfuel',
  AIRBP: 'Air BP',
  TOTAL: 'Total',
  SHELL: 'Shell',
  OTHER_CARNET: 'Other carnet',
  OTHER_RELEASE: 'Other release',
  INVOICE: 'Invoice',
  CASH: 'Cash',
  BITCOIN: 'Bitcoin',
};

const FUEL_CARDS = new Set([
  'WORLD_FUEL_SERVICES', 'COLT', 'UVAIR', 'AVFUEL', 'AIRBP', 'TOTAL', 'SHELL',
  'OTHER_CARNET', 'OTHER_RELEASE',
]);

function money(value, currency = 'USD') {
  if (!Number.isFinite(Number(value))) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return `${Number(value).toFixed(2)} ${currency || ''}`.trim();
  }
}

function fetchedLabel(ms) {
  if (!Number.isFinite(Number(ms))) return 'Unknown';
  const date = new Date(Number(ms));
  const local = formatLocalTime(date, 'KAPF');
  return `${formatLocalDate(date, 'KAPF')} ${local.time}${local.tz ? ` ${local.tz}` : ''}`;
}

function paymentLabel(code) {
  return PAYMENT_LABELS[code] || String(code || '').replace(/_/g, ' ');
}

function estimatedUplift(fuel, gallons) {
  if (!(gallons > 0)) return null;
  if (fuel.source === 'iFlightPlanner') return Number(fuel.price) * gallons;
  if (fuel.nonUsd || fuel.currency !== 'USD') return null;
  const perGal = Number(fuel.pricePerGal);
  return Number.isFinite(perGal) ? perGal * gallons : null;
}

function displayPrice(fuel) {
  if (fuel.source === 'iFlightPlanner' || (!fuel.nonUsd && (fuel.currency === 'USD' || !fuel.currency))) {
    const perGal = Number(fuel.pricePerGal ?? fuel.price);
    return { text: money(perGal, 'USD'), suffix: '/gal' };
  }
  return {
    text: money(fuel.price, fuel.currency || 'USD'),
    suffix: fuel.unit ? `/${String(fuel.unit).toLowerCase()}` : '',
  };
}

function PriceLine({ fuel, gallons }) {
  const estimated = estimatedUplift(fuel, gallons);
  const shown = displayPrice(fuel);
  return (
    <div className="grid grid-cols-[minmax(5.5rem,1fr)_minmax(6.5rem,1.2fr)_auto] items-center gap-3 border-b border-edge/70 py-2 last:border-b-0">
      <div>
        <div className="font-mono text-xs font-semibold text-content">{fuel.fuelType}</div>
        <div className="text-[10px] text-content-subtle">{fuel.service}</div>
      </div>
      <div>
        <div className="font-mono text-sm font-semibold text-success">
          {shown.text}
          {shown.suffix && <span className="text-[9px] font-normal text-content-subtle"> {shown.suffix}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1 text-[9px] text-content-subtle">
          {fuel.source === 'iFlightPlanner' && fuel.updatedAt && <span>Updated {fuel.updatedAt}</span>}
          {fuel.source === 'iFlightPlanner' && !fuel.updatedAt && <span>iFlightPlanner</span>}
          {fuel.fallback && <span>aviowiki fallback</span>}
          {fuel.converted && fuel.pricePerGal != null && (
            <span>converted from {fuel.unit === 'LTR' ? 'litres' : fuel.unit}</span>
          )}
          {fuel.nonUsd && (
            <span className="rounded border border-warning-border bg-warning-soft px-1 text-warning">Non-USD</span>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-xs text-content">{estimated == null ? '—' : money(estimated)}</div>
        <div className="text-[9px] text-content-subtle">{estimated == null ? (fuel.nonUsd ? 'Non-USD' : 'Enter uplift') : `${gallons} gal`}</div>
      </div>
    </div>
  );
}

function FboCard({ fbo, gallons }) {
  const phone = fbo.phone;
  const role = fbo.fbo ? 'FBO' : (fbo.category === 'FUEL' ? 'Fuel' : (fbo.serviceLevel || 'Handler'));
  return (
    <article className="rounded-xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Building2 className="h-4 w-4 shrink-0 text-accent" />
            <h3 className="truncate text-sm font-semibold text-content">{fbo.name}</h3>
            {fbo.verified && (
              <span className="inline-flex items-center gap-1 rounded border border-success-border bg-success-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success">
                <BadgeCheck className="h-3 w-3" /> Verified
              </span>
            )}
          </div>
          <div className="ml-6 mt-0.5 text-[10px] text-content-muted">
            {role}{fbo.fuelBrand ? ` · ${fbo.fuelBrand}` : ''}{fbo.source === 'iFlightPlanner' ? ' · iFlightPlanner fuel only' : ''}
          </div>
        </div>
        {fbo.vhf && (
          <span className="inline-flex items-center gap-1 rounded border border-edge bg-surface-raised px-2 py-1 font-mono text-[10px] text-content-muted">
            <Radio className="h-3 w-3" /> {fbo.vhf}
          </span>
        )}
      </div>

      {(phone || fbo.email || fbo.website || fbo.address) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-content-muted">
          {phone && (
            <a className="inline-flex items-center gap-1 hover:text-accent" href={`tel:${phone}`}>
              <Phone className="h-3 w-3" /> {phone}
            </a>
          )}
          {fbo.email && (
            <a className="inline-flex items-center gap-1 hover:text-accent" href={`mailto:${fbo.email}`}>
              {fbo.email}
            </a>
          )}
          {fbo.website && (
            <a
              className="inline-flex items-center gap-1 hover:text-accent"
              href={/^https?:\/\//i.test(fbo.website) ? fbo.website : `https://${fbo.website}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="h-3 w-3" /> Website
            </a>
          )}
          {fbo.address && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {fbo.address}</span>}
        </div>
      )}

      {!!fbo.paymentMethods?.length && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {fbo.paymentMethods.map((method) => (
            <span
              key={method}
              className={`rounded border px-1.5 py-0.5 text-[9px] ${
                FUEL_CARDS.has(method)
                  ? 'border-accent/40 bg-surface-raised text-content'
                  : 'border-edge bg-surface-sunken text-content-muted'
              }`}
            >
              {paymentLabel(method)}
            </span>
          ))}
        </div>
      )}

      {!!fbo.services?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {fbo.services.slice(0, 8).map((service) => (
            <span key={service} className="rounded bg-surface-sunken px-1.5 py-0.5 text-[9px] text-content-subtle">
              {service}
            </span>
          ))}
          {fbo.services.length > 8 && (
            <span className="text-[9px] text-content-subtle">+{fbo.services.length - 8}</span>
          )}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-edge bg-surface-sunken px-3">
        {fbo.fuelPrices.length ? (
          fbo.fuelPrices.map((fuel) => (
            <PriceLine
              key={`${fuel.fuelType}-${fuel.service}-${fuel.source}-${fuel.unit || ''}`}
              fuel={fuel}
              gallons={gallons}
            />
          ))
        ) : (
          <div className="py-3 text-xs text-content-muted">No posted retail fuel price in this feed.</div>
        )}
      </div>
    </article>
  );
}

function statusTone(status) {
  if (status === 'FULL') return 'text-success';
  if (status === 'CLOSED') return 'text-danger';
  if (status === 'LIMITED') return 'text-warning';
  return 'text-content-muted';
}

function AvailabilityColumn({ title, icon: Icon, blocks, summary }) {
  if (!blocks?.length && !summary) return null;
  const showBlocks = summary !== '24 hours';
  return (
    <div className="rounded-lg border border-edge bg-surface-sunken p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
        <Icon className="h-3.5 w-3.5" /> {title}
      </div>
      {summary && <div className="mt-1 text-xs font-medium text-content">{summary}</div>}
      {showBlocks && (
      <div className="mt-2 space-y-1.5">
        {(blocks || []).map((block, index) => (
          <div key={`${block.from}-${block.to}-${index}`} className="text-[10px] text-content-muted">
            <span className="font-mono">{block.fromClock || '—'}-{block.toClock || '—'}</span>
            {' '}
            <span className={statusTone(block.status)}>{block.status}</span>
            {block.detail ? ` · ${block.detail}` : ''}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

function AirportResult({ result, gallons }) {
  const lowest = Object.values(result.lowestByFuel || {});
  const showAviowiki = result.source === 'aviowiki' || result.availability || result.notes?.length;
  const showRunways = result.runways?.length > 0;
  return (
    <section className="space-y-3">
      <div className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <MapPin className="h-4 w-4 text-accent" />
              <h2 className="font-mono text-base font-semibold text-content">{result.airport}</h2>
              {result.airportName && <span className="text-xs text-content-muted">{result.airportName}</span>}
              {result.servedCity && <span className="text-xs text-content-subtle">{result.servedCity}</span>}
            </div>
            <div className="mt-1 text-[10px] text-content-subtle">
              {result.fbos.length} FBO/fuel provider{result.fbos.length === 1 ? '' : 's'}
              {result.elevationFt != null ? ` · ${result.elevationFt.toLocaleString()} ft` : ''}
              {result.timezone ? ` · ${result.timezone}` : ''}
              {result.stale ? ' · showing last cached aviowiki data' : ''}
            </div>
          </div>
          {lowest.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {lowest.map((fuel) => (
                <div key={fuel.fuelType} className="rounded border border-success-border bg-success-soft px-3 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-success">{fuel.fuelType} lowest</div>
                  <div className="font-mono text-xs font-semibold text-content">
                    {money(fuel.price)} · {fuel.fboName}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {(showRunways || showAviowiki) && (
          <div className="mt-4 space-y-3">
            {showRunways && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                  Runways · {result.source === 'ourairports' ? 'OurAirports' : 'aviowiki'}
                </div>
                <div className="overflow-x-auto rounded-lg border border-edge">
                  <table className="w-full min-w-[28rem] text-left text-[10px]">
                    <thead className="bg-surface-sunken text-content-subtle">
                      <tr>
                        <th className="px-2 py-1.5 font-semibold">Runway</th>
                        <th className="px-2 py-1.5 font-semibold">Length</th>
                        <th className="px-2 py-1.5 font-semibold">Width</th>
                        <th className="px-2 py-1.5 font-semibold">Surface</th>
                        <th className="px-2 py-1.5 font-semibold">Lights</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.runways.map((runway) => (
                        <tr key={`${runway.identifier}-${runway.aid || runway.source}`} className="border-t border-edge/70">
                          <td className="px-2 py-1.5 font-mono text-content">
                            {runway.identifier}{runway.closed ? ' (closed)' : ''}{runway.helipad ? ' helipad' : ''}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-content">{runway.lengthFt ? `${runway.lengthFt.toLocaleString()} ft` : '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-content">{runway.widthFt ? `${runway.widthFt.toLocaleString()} ft` : '—'}</td>
                          <td className="px-2 py-1.5 text-content-muted">{runway.surface || '—'}</td>
                          <td className="px-2 py-1.5 text-content-muted">{runway.lighted ? 'Yes' : 'No'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {result.availability && (
              <div className="grid gap-2 md:grid-cols-2">
                <div className="md:col-span-2 text-[10px] text-content-subtle">Times are local to the airport, from local midnight.</div>
                <AvailabilityColumn title="Hours" icon={Clock} blocks={result.availability.hours} summary={result.availability.hoursSummary} />
                <AvailabilityColumn title="Customs" icon={Shield} blocks={result.availability.customs} />
                <AvailabilityColumn title="ATC" icon={Radio} blocks={result.availability.atc} />
                <AvailabilityColumn title="Fire cover" icon={Shield} blocks={result.availability.fireCover} />
              </div>
            )}

            {!!result.notes?.length && (
              <div className="space-y-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">Operational notes</div>
                {result.notes.slice(0, 6).map((note) => (
                  <div key={note.aid || note.notes.slice(0, 40)} className="rounded-lg border border-edge bg-surface-sunken p-2.5 text-[11px] text-content-muted">
                    <div className="mb-1 text-[9px] uppercase tracking-wide text-content-subtle">
                      {[note.criticality, note.category, note.source].filter(Boolean).join(' · ')}
                    </div>
                    <p className="whitespace-pre-wrap text-content">{note.notes}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {result.fbos.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {result.fbos.map((fbo, index) => (
            <FboCard key={`${fbo.aid || fbo.name}-${index}`} fbo={fbo} gallons={gallons} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-edge p-8 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
          <div className="mt-2 text-sm font-semibold text-content">No FBO records found for {result.airport}</div>
          <div className="mt-1 text-xs text-content-muted">Try the U.S. FAA identifier and ICAO form, such as APF or KAPF.</div>
        </div>
      )}
    </section>
  );
}

async function authedGet(path) {
  const { auth } = await import('./firebase.js');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Your session expired. Sign in again.');
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${idToken}` },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Lookup failed');
    error.code = data.code || null;
    error.status = response.status;
    error.configured = data.configured;
    throw error;
  }
  return data;
}

export default function AirportFboData() {
  const [airportInput, setAirportInput] = useState('APF');
  const [gallonsInput, setGallonsInput] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const airports = useMemo(() => (
    airportInput
      .split(/[\s,;]+/)
      .map(compactAirport)
      .filter(Boolean)
      .filter((airport, index, list) => list.indexOf(airport) === index)
      .slice(0, 10)
  ), [airportInput]);
  const gallons = Math.max(0, Number(gallonsInput) || 0);

  async function search(event) {
    event.preventDefault();
    if (!airports.length) {
      setError('Enter at least one airport identifier.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [iflightResult, aviowikiFbosResult, airportResults] = await Promise.all([
        authedGet(`/api/iflightplanner-fbos?airports=${encodeURIComponent(airports.join(','))}`).catch((err) => ({
          error: err.message,
          airports: [],
          configured: err.configured,
        })),
        authedGet(`/api/aviowiki-fbos?airports=${encodeURIComponent(airports.join(','))}`).catch((err) => ({
          error: err.message,
          airports: [],
          configured: err.configured,
        })),
        Promise.all(airports.map((icao) => (
          authedGet(`/api/aviowiki-airport?icao=${encodeURIComponent(icao)}`).catch((err) => ({
            error: err.message,
            configured: err.configured,
            airport: { icao, name: '' },
            runways: [],
            notes: [],
            availability: null,
          }))
        ))),
      ]);
      const views = airports.map((icao, index) => mergeAirportView({
        requested: icao,
        aviowikiAirport: airportResults[index],
        aviowikiFbos: aviowikiFbosResult,
        iflight: iflightResult,
      }));
      const aviowikiConfigured = aviowikiFbosResult?.configured === true
        || airportResults.some((item) => item?.configured === true);
      const aviowikiDisabled = aviowikiFbosResult?.configured === false
        && airportResults.every((item) => item?.configured === false);
      if (!views.some((view) => view.fbos.length || view.runways.length || view.airportName) && (iflightResult.error || aviowikiFbosResult.error)) {
        throw new Error(iflightResult.error || aviowikiFbosResult.error || 'FBO and fuel-price lookup failed');
      }
      setReport({
        airports: views,
        recordCount: iflightResult.recordCount || views.reduce((sum, view) => sum + view.fbos.length, 0),
        fetchedAt: iflightResult.fetchedAt || aviowikiFbosResult.airports?.find((item) => item.fetchedAt)?.fetchedAt || Date.now(),
        disclaimer: [
          iflightResult.disclaimer,
          aviowikiConfigured ? aviowikiFbosResult.disclaimer : '',
        ].filter(Boolean).join(' ') || 'Confirm price, fees, and availability with the FBO before dispatch or quoting.',
        iflightConfigured: iflightResult.configured !== false && !iflightResult.error,
        aviowikiConfigured,
        aviowikiDisabled,
        iflightError: iflightResult.error || '',
      });
    } catch (err) {
      setError(err.message || 'FBO and fuel-price lookup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-shell">
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Fuel className="h-5 w-5 text-accent" />
              <h1 className="text-lg font-semibold text-content">Airport, FBO & Fuel Cost</h1>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-content-muted">
              FBO contacts, services, and payment cards come from aviowiki.
              US dollars per gallon and the price timestamp come from iFlightPlanner.
              An aviowiki price is shown only when iFlightPlanner has no posted price for that fuel.
            </p>
          </div>
          <div className="rounded border border-edge bg-surface px-3 py-2 text-right">
            <div className="text-[9px] uppercase tracking-wide text-content-subtle">Data sources</div>
            <div className="font-mono text-[10px] text-content">iFlightPlanner · US $/gal</div>
            <div className="font-mono text-[10px] text-content">aviowiki · FBOs & airport</div>
          </div>
        </header>

        <form onSubmit={search} className="rounded-xl border border-edge bg-surface p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(18rem,1fr)_12rem_auto] lg:items-end">
            <label>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                Airport identifiers · up to 10
              </span>
              <input
                value={airportInput}
                onChange={(event) => setAirportInput(event.target.value.toUpperCase())}
                placeholder="APF, TEB, HPN"
                className="w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 font-mono text-sm uppercase text-content outline-none focus:border-accent"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
                Planned uplift · gallons
              </span>
              <input
                type="number"
                min="0"
                max="100000"
                step="1"
                value={gallonsInput}
                onChange={(event) => setGallonsInput(event.target.value)}
                placeholder="Optional"
                className="w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 font-mono text-sm text-content outline-none focus:border-accent"
              />
            </label>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-bold text-accent-contrast disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              CHECK FBOS & COST
            </button>
          </div>
          <p className="mt-2 text-[10px] text-content-subtle">
            Enter FAA or ICAO identifiers. Estimated uplift cost is posted retail price × planned gallons;
            taxes, contract pricing, call-out, handling, ramp, and minimum-uplift fees are not included.
          </p>
        </form>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft p-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {report && (
          <>
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success-border bg-success-soft px-3 py-2 text-[10px] text-success">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {Number(report.recordCount || 0).toLocaleString()} provider records loaded · feed refreshed {fetchedLabel(report.fetchedAt)}
              {report.aviowikiConfigured ? ' · aviowiki FBOs' : ''}
              {report.iflightConfigured ? ' · iFlightPlanner prices' : ''}
              {gallons > 0 && (
                <span className="ml-auto inline-flex items-center gap-1 font-mono text-content">
                  <DollarSign className="h-3 w-3" /> COST FOR {gallons.toLocaleString()} GAL
                </span>
              )}
            </div>
            {report.aviowikiDisabled && (
              <div className="text-[10px] text-content-subtle">
                Hours, customs, fire cover, and aviowiki FBO details are hidden because the server token is not configured.
              </div>
            )}
            {(report.iflightError && report.aviowikiConfigured) && (
              <div className="text-[10px] text-warning">iFlightPlanner prices are unavailable. {report.iflightError}</div>
            )}
            <div className="space-y-5">
              {report.airports.map((result) => (
                <AirportResult key={result.airport} result={result} gallons={gallons} />
              ))}
            </div>
            <div className="rounded border border-warning-border bg-warning-soft p-3 text-[10px] text-warning">
              {report.disclaimer}
            </div>
          </>
        )}

        {!report && !loading && (
          <div className="rounded-xl border border-dashed border-edge p-10 text-center">
            <Fuel className="mx-auto h-8 w-8 text-content-subtle" />
            <div className="mt-3 text-sm font-semibold text-content">Look up an airport to compare FBOs</div>
            <p className="mt-1 text-xs text-content-muted">
              Posted full-service and self-service Jet A, 100LL, Jet A + FSII, MOGAS, UL94, and SAF
              appear when supplied by the provider.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
