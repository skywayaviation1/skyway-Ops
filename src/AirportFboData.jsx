import { useMemo, useState } from 'react';
import {
  AlertTriangle, Building2, CheckCircle2, DollarSign, ExternalLink,
  Fuel, Loader2, MapPin, Phone, Search,
} from 'lucide-react';
import { formatLocalDate, formatLocalTime } from './airports.js';

const compactAirport = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 7);

function money(value) {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function fetchedLabel(ms) {
  if (!Number.isFinite(Number(ms))) return 'Unknown';
  const date = new Date(Number(ms));
  const local = formatLocalTime(date, 'KAPF');
  return `${formatLocalDate(date, 'KAPF')} ${local.time}${local.tz ? ` ${local.tz}` : ''}`;
}

function PriceLine({ fuel, gallons }) {
  const estimated = gallons > 0 ? Number(fuel.price) * gallons : null;
  return (
    <div className="grid grid-cols-[minmax(5.5rem,1fr)_minmax(6rem,1fr)_auto] items-center gap-3 border-b border-edge/70 py-2 last:border-b-0">
      <div>
        <div className="font-mono text-xs font-semibold text-content">{fuel.fuelType}</div>
        <div className="text-[10px] text-content-subtle">{fuel.service}</div>
      </div>
      <div>
        <div className="font-mono text-sm font-semibold text-success">{money(fuel.price)}<span className="text-[9px] font-normal text-content-subtle"> / gal</span></div>
        {fuel.updatedAt && <div className="text-[9px] text-content-subtle">Updated {fuel.updatedAt}</div>}
      </div>
      <div className="text-right">
        <div className="font-mono text-xs text-content">{estimated == null ? '—' : money(estimated)}</div>
        <div className="text-[9px] text-content-subtle">{estimated == null ? 'Enter uplift' : `${gallons} gal`}</div>
      </div>
    </div>
  );
}

function FboCard({ fbo, gallons }) {
  const location = [fbo.address, fbo.city, fbo.state].filter(Boolean).join(', ');
  const phone = fbo.phone || fbo.tollFree;
  return (
    <article className="rounded-xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 shrink-0 text-accent" />
            <h3 className="truncate text-sm font-semibold text-content">{fbo.name}</h3>
          </div>
          {fbo.fuelBrand && <div className="ml-6 mt-0.5 text-[10px] text-content-muted">{fbo.fuelBrand}</div>}
        </div>
        {fbo.frequency && (
          <span className="rounded border border-edge bg-surface-raised px-2 py-1 font-mono text-[10px] text-content-muted">
            {fbo.frequency}
          </span>
        )}
      </div>

      {(phone || fbo.website || location) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[10px] text-content-muted">
          {phone && (
            <a className="inline-flex items-center gap-1 hover:text-accent" href={`tel:${phone}`}>
              <Phone className="h-3 w-3" /> {phone}
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
          {location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {location}</span>}
        </div>
      )}

      <div className="mt-3 rounded-lg border border-edge bg-surface-sunken px-3">
        {fbo.fuelPrices.length ? (
          fbo.fuelPrices.map((fuel) => (
            <PriceLine
              key={`${fuel.fuelType}-${fuel.service}-${fuel.sourceColumn}`}
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

function AirportResult({ result, gallons }) {
  const lowest = Object.values(result.lowestByFuel || {});
  return (
    <section className="space-y-3">
      <div className="rounded-xl border border-edge bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-accent" />
              <h2 className="font-mono text-base font-semibold text-content">{result.airport}</h2>
              {result.airportName && <span className="text-xs text-content-muted">{result.airportName}</span>}
            </div>
            <div className="mt-1 text-[10px] text-content-subtle">
              {result.fbos.length} FBO/fuel provider{result.fbos.length === 1 ? '' : 's'}
            </div>
          </div>
          {lowest.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {lowest.map((fuel) => (
                <div key={fuel.fuelType} className="rounded border border-success-border bg-success-soft px-3 py-1.5">
                  <div className="text-[9px] uppercase tracking-wide text-success">{fuel.fuelType} lowest</div>
                  <div className="font-mono text-xs font-semibold text-content">{money(fuel.price)} · {fuel.fboName}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {result.fbos.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {result.fbos.map((fbo, index) => (
            <FboCard key={`${fbo.airport}-${fbo.name}-${index}`} fbo={fbo} gallons={gallons} />
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
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('Your session expired. Sign in again.');
      const response = await fetch(
        `/api/iflightplanner-fbos?airports=${encodeURIComponent(airports.join(','))}`,
        {
          headers: { Authorization: `Bearer ${idToken}` },
          cache: 'no-store',
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'FBO and fuel-price lookup failed');
      setReport(data);
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
              Current posted retail fuel prices and FBO contact data from iFlightPlanner.
              Compare providers and estimate uplift cost before dispatch or quoting.
            </p>
          </div>
          <div className="rounded border border-edge bg-surface px-3 py-2 text-right">
            <div className="text-[9px] uppercase tracking-wide text-content-subtle">Data source</div>
            <div className="font-mono text-[10px] text-content">iFlightPlanner API v2</div>
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
              {report.recordCount.toLocaleString()} provider records loaded · feed refreshed {fetchedLabel(report.fetchedAt)}
              {gallons > 0 && (
                <span className="ml-auto inline-flex items-center gap-1 font-mono text-content">
                  <DollarSign className="h-3 w-3" /> COST FOR {gallons.toLocaleString()} GAL
                </span>
              )}
            </div>
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
