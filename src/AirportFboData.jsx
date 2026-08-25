import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Building2, CheckCircle2, Cloud, DollarSign, ExternalLink,
  Fuel, Loader2, MapPin, Navigation, Phone, Radio, Search,
} from 'lucide-react';
import { formatLocalDate, formatLocalTime } from './airports.js';
import { lookupCoords } from './airport-coords.js';

const compactAirport = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .slice(0, 7);

const operationalIcao = (airport) => {
  const code = compactAirport(airport);
  return code.length === 3 && /^[A-Z]{3}$/.test(code) ? `K${code}` : code;
};

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

function ProviderFields({ raw }) {
  const entries = Object.entries(raw || {}).filter(([, value]) => String(value || '').trim());
  if (!entries.length) return null;
  return (
    <details className="mt-3 rounded border border-edge bg-surface-sunken">
      <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-content-muted">
        All provider data · {entries.length} fields
      </summary>
      <dl className="grid gap-px border-t border-edge bg-edge sm:grid-cols-2">
        {entries.map(([label, value]) => (
          <div key={label} className="bg-surface-sunken px-3 py-2">
            <dt className="text-[9px] uppercase tracking-wide text-content-subtle">{label}</dt>
            <dd className="mt-0.5 break-words text-[11px] text-content">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
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
      <ProviderFields raw={fbo.raw} />
    </article>
  );
}

function AirportSituation({ result }) {
  const wx = result.weather?.metar;
  const notams = result.notams?.notams || [];
  const significant = result.notams?.significantOnly || [];
  const coords = result.coordinates;
  const mapUrl = coords
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${coords.lat},${coords.lng}`)}`
    : null;
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="rounded-lg border border-edge bg-surface-sunken p-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
          <Navigation className="h-3.5 w-3.5" /> Location
        </div>
        {coords ? (
          <>
            <div className="mt-2 text-xs font-semibold text-content">{coords.name || result.airportName || result.airport}</div>
            <div className="mt-1 font-mono text-[11px] text-content-muted">
              {Number(coords.lat).toFixed(5)}, {Number(coords.lng).toFixed(5)}
            </div>
            <a className="mt-2 inline-flex items-center gap-1 text-[10px] text-accent hover:underline" href={mapUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3" /> Open map
            </a>
          </>
        ) : <div className="mt-2 text-xs text-content-muted">Location unavailable</div>}
      </div>

      <div className="rounded-lg border border-edge bg-surface-sunken p-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
          <Cloud className="h-3.5 w-3.5" /> Current weather
        </div>
        {wx ? (
          <>
            <div className="mt-2 flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-content">{wx.flightCategory || '—'}</span>
              <span className="text-[10px] text-content-muted">
                {wx.windDir == null ? 'VRB' : `${wx.windDir}°`} / {wx.windKt ?? 0} kt
                {wx.windGustKt ? ` G${wx.windGustKt}` : ''}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-content-muted">
              Visibility {wx.visibilitySm ?? '—'} sm · Ceiling {wx.ceilingFt == null ? 'none reported' : `${wx.ceilingFt} ft`}
            </div>
            {wx.rawMetar && <div className="mt-2 break-words font-mono text-[9px] text-content-subtle">{wx.rawMetar}</div>}
          </>
        ) : <div className="mt-2 text-xs text-content-muted">No current METAR available</div>}
      </div>

      <div className="rounded-lg border border-edge bg-surface-sunken p-3">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
          <Radio className="h-3.5 w-3.5" /> Active NOTAMs
        </div>
        {result.notams?.error ? (
          <div className="mt-2 text-[10px] text-warning">
            NOTAM source unavailable — check separately. ({result.notams.error})
          </div>
        ) : (
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-mono text-sm font-semibold text-content">{notams.length}</span>
            <span className="text-[10px] text-content-muted">{significant.length} operationally significant</span>
          </div>
        )}
        {significant.slice(0, 3).map((notam) => (
          <div key={notam.id || notam.text} className="mt-2 border-t border-edge pt-2 text-[9px] text-warning">
            {notam.summary || notam.text}
          </div>
        ))}
        {notams.length > significant.length && (
          <details className="mt-2">
            <summary className="cursor-pointer text-[10px] text-accent">Show all NOTAMs</summary>
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
              {notams.map((notam) => (
                <div key={notam.id || notam.text} className="rounded border border-edge p-2 text-[9px] text-content-muted">
                  <span className="mr-1 font-mono text-content">{notam.id}</span>
                  {notam.text || notam.summary}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function AirportResult({ result, gallons, assignedFbo, feedUnavailable }) {
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
              {feedUnavailable
                ? 'FBO and fuel feed not reachable from this deployment'
                : `${result.fbos.length} FBO/fuel provider${result.fbos.length === 1 ? '' : 's'}`}
            </div>
            {assignedFbo && (
              <div className="mt-2 inline-flex rounded border border-accent-border bg-accent-soft px-2 py-1 text-[10px] text-accent">
                Assigned on trip: {assignedFbo}
              </div>
            )}
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

      <AirportSituation result={result} />

      {result.fbos.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {result.fbos.map((fbo, index) => (
            <FboCard key={`${fbo.airport}-${fbo.name}-${index}`} fbo={fbo} gallons={gallons} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-edge p-8 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-warning" />
          <div className="mt-2 text-sm font-semibold text-content">
            {feedUnavailable
              ? `FBO and fuel data not loaded for ${result.airport}`
              : `No FBO records found for ${result.airport}`}
          </div>
          <div className="mt-1 text-xs text-content-muted">
            {feedUnavailable
              ? 'The provider feed could not be reached. See the notice above.'
              : 'Try the U.S. FAA identifier and ICAO form, such as APF or KAPF.'}
          </div>
        </div>
      )}
    </section>
  );
}

export default function AirportFboData({
  initialAirports = 'APF',
  autoSearch = false,
  embedded = false,
  assignedFbos = {},
}) {
  const initialValue = Array.isArray(initialAirports) ? initialAirports.join(', ') : initialAirports;
  const [airportInput, setAirportInput] = useState(initialValue || 'APF');
  const [gallonsInput, setGallonsInput] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedCheck, setFeedCheck] = useState(null);
  const [checkingFeed, setCheckingFeed] = useState(false);

  const airports = useMemo(() => (
    airportInput
      .split(/[\s,;]+/)
      .map(compactAirport)
      .filter(Boolean)
      .filter((airport, index, list) => list.indexOf(airport) === index)
      .slice(0, 10)
  ), [airportInput]);
  const gallons = Math.max(0, Number(gallonsInput) || 0);

  useEffect(() => {
    const next = Array.isArray(initialAirports) ? initialAirports.join(', ') : initialAirports;
    if (next) setAirportInput(next);
  }, [initialAirports]);

  const load = useCallback(async (requested) => {
    if (!requested.length) {
      setError('Enter at least one airport identifier.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) throw new Error('Your session expired. Sign in again.');
      const headers = { Authorization: `Bearer ${idToken}` };
      const fboPromise = fetch(
        `/api/iflightplanner-fbos?airports=${encodeURIComponent(requested.join(','))}`,
        { headers, cache: 'no-store' },
      ).then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const failure = new Error(data.error || 'FBO and fuel-price lookup failed');
          failure.status = response.status;
          failure.missingEnv = data.missingEnv || [];
          failure.deployment = data.deployment || null;
          throw failure;
        }
        return data;
      });
      // The bundled coordinate table answers immediately for the airports the
      // fleet actually flies. The server cache is only consulted for the rest,
      // because it is populated by a weekly cron and is empty until that runs.
      const localCoords = Object.fromEntries(
        requested.map((airport) => [airport, lookupCoords(airport)]).filter(([, hit]) => hit),
      );
      const needLookup = requested.filter((airport) => !localCoords[airport]);
      const coordsPromise = needLookup.length === 0
        ? Promise.resolve({ coords: {} })
        : fetch('/api/airport-coords-lookup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: needLookup }),
        }).then((response) => response.json()).catch(() => ({ coords: {} }));
      const supportPromise = Promise.all(requested.map(async (airport) => {
        const icao = operationalIcao(airport);
        const [weather, notams] = await Promise.all([
          fetch(`/api/airport-weather?icao=${encodeURIComponent(icao)}`, { headers })
            .then((response) => response.json()).catch(() => null),
          fetch(`/api/faa-notams?icao=${encodeURIComponent(icao)}`, { headers })
            .then((response) => response.json()).catch(() => null),
        ]);
        return { airport, weather, notams };
      }));

      const [fboResult, coords, support] = await Promise.allSettled([
        fboPromise, coordsPromise, supportPromise,
      ]);
      const fboData = fboResult.status === 'fulfilled' ? fboResult.value : {
        airports: requested.map((airport) => ({
          airport, airportName: '', fbos: [], lowestByFuel: {},
        })),
        recordCount: 0,
        fetchedAt: null,
      };
      const coordinateData = {
        ...(coords.status === 'fulfilled' ? coords.value?.coords || {} : {}),
        ...localCoords,
      };
      const supportData = support.status === 'fulfilled' ? support.value : [];
      const byAirport = new Map(supportData.map((item) => [item.airport, item]));
      setReport({
        ...fboData,
        providerError: fboResult.status === 'rejected' ? fboResult.reason?.message : null,
        providerStatus: fboResult.status === 'rejected' ? fboResult.reason?.status || null : null,
        providerMissingEnv: fboResult.status === 'rejected' ? fboResult.reason?.missingEnv || [] : [],
        providerDeployment: fboResult.status === 'rejected' ? fboResult.reason?.deployment || null : null,
        airports: requested.map((airport, index) => {
          const fboAirport = fboData.airports?.find((item) => item.airport === airport)
            || fboData.airports?.[index]
            || { airport, airportName: '', fbos: [], lowestByFuel: {} };
          return {
            ...fboAirport,
            airport,
            coordinates: coordinateData[airport] || null,
            weather: byAirport.get(airport)?.weather || null,
            notams: byAirport.get(airport)?.notams || null,
          };
        }),
      });
    } catch (err) {
      setError(err.message || 'Airport data lookup failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (autoSearch && airports.length) load(airports);
  }, [autoSearch, airports.join(','), load]);

  function search(event) {
    event.preventDefault();
    load(airports);
  }

  /**
   * Ask the server whether it can actually reach the provider. Administrators
   * get a live token + data request; everyone else gets the configuration view,
   * which is enough to see whether this deployment has the credentials at all.
   */
  async function checkFeed() {
    setCheckingFeed(true);
    setFeedCheck(null);
    try {
      const { auth } = await import('./firebase.js');
      const idToken = await auth.currentUser?.getIdToken();
      const live = await fetch('/api/iflightplanner-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (live.status === 401 || live.status === 403) {
        const config = await fetch('/api/iflightplanner-status').then((r) => r.json());
        setFeedCheck({ ...config, stage: 'configuration' });
      } else {
        setFeedCheck(await live.json());
      }
    } catch (err) {
      setFeedCheck({ ok: false, error: err.message || 'Feed check failed' });
    } finally {
      setCheckingFeed(false);
    }
  }

  return (
    <div className={embedded ? 'bg-surface-shell' : 'flex-1 overflow-y-auto bg-surface-shell'}>
      <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Fuel className="h-5 w-5 text-accent" />
              <h1 className="text-lg font-semibold text-content">
                {embedded ? 'Flight airport data' : 'Airport, FBO & Fuel Cost'}
              </h1>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-content-muted">
              Airport location, current weather, active NOTAMs, FBO contacts, posted retail fuel
              prices, and estimated uplift cost.
            </p>
          </div>
          <div className="rounded border border-edge bg-surface px-3 py-2 text-right">
            <div className="text-[9px] uppercase tracking-wide text-content-subtle">Data source</div>
            <div className="font-mono text-[10px] text-content">iFlightPlanner API v2</div>
            <button
              type="button"
              onClick={checkFeed}
              disabled={checkingFeed}
              className="mt-1 inline-flex items-center gap-1 text-[10px] text-accent hover:underline disabled:opacity-60"
            >
              {checkingFeed ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Check feed connection
            </button>
          </div>
        </header>

        {feedCheck && (
          <div className={`rounded-lg border p-3 text-[11px] ${
            feedCheck.ok
              ? 'border-success-border bg-success-soft text-success'
              : 'border-danger-border bg-danger-soft text-danger'
          }`}>
            <div className="font-semibold">
              {feedCheck.ok
                ? `Provider reachable · ${Number(feedCheck.recordCount || 0).toLocaleString()} records, ${Number(feedCheck.recordsWithPrices || 0).toLocaleString()} with posted prices`
                : `Provider not reachable · ${feedCheck.stage || 'unknown'} stage`}
            </div>
            {feedCheck.error && <div className="mt-1">{feedCheck.error}</div>}
            {feedCheck.note && <div className="mt-1 text-content-muted">{feedCheck.note}</div>}
            {feedCheck.apiBase && (
              <div className="mt-1 text-content-muted">
                Calling <span className="font-mono text-content">{feedCheck.apiBase}</span>
                {feedCheck.environmentKind ? ` · their ${feedCheck.environmentKind} host` : ''}
              </div>
            )}
            {feedCheck.resolution?.length > 0 && (
              <ol className="mt-2 list-decimal space-y-1 pl-4 text-content-muted">
                {feedCheck.resolution.map((step) => <li key={step}>{step}</li>)}
              </ol>
            )}
            {feedCheck.deployment && (
              <div className="mt-1 text-content-muted">
                Serving environment: <span className="font-mono text-content">{feedCheck.deployment.environment}</span>
                {feedCheck.deployment.branch && (
                  <> · branch <span className="font-mono text-content">{feedCheck.deployment.branch}</span></>
                )}
              </div>
            )}
            {feedCheck.missingEnv?.length > 0 && (
              <div className="mt-1 font-mono text-content">Missing: {feedCheck.missingEnv.join(', ')}</div>
            )}
            {feedCheck.hint && <div className="mt-1 text-content-muted">{feedCheck.hint}</div>}
          </div>
        )}

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

        {report?.providerError && (
          <div className="rounded-lg border border-warning-border bg-warning-soft p-3 text-warning">
            <div className="flex items-start gap-2 text-sm font-semibold">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              FBO and fuel prices unavailable · airport location, weather, and NOTAMs below are live
            </div>
            <p className="mt-2 text-[11px]">{report.providerError}</p>
            {report.providerMissingEnv?.length > 0 && (
              <div className="mt-2 rounded border border-warning-border/60 bg-surface-sunken p-2">
                <div className="text-[9px] font-semibold uppercase tracking-wide text-content-subtle">
                  Missing on the deployment that served this request
                </div>
                <ul className="mt-1 space-y-0.5">
                  {report.providerMissingEnv.map((name) => (
                    <li key={name} className="font-mono text-[10px] text-content">{name}</li>
                  ))}
                </ul>
                {report.providerDeployment && (
                  <div className="mt-1.5 text-[10px] text-content-muted">
                    Serving environment:{' '}
                    <span className="font-mono text-content">{report.providerDeployment.environment}</span>
                    {report.providerDeployment.branch && (
                      <> · branch <span className="font-mono text-content">{report.providerDeployment.branch}</span></>
                    )}
                    . Variables are scoped per environment, so add them to this one and redeploy.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {report && (
          <>
            {!report.providerError && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success-border bg-success-soft px-3 py-2 text-[10px] text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {Number(report.recordCount || 0).toLocaleString()} provider records loaded
                {report.fetchedAt ? ` · feed refreshed ${fetchedLabel(report.fetchedAt)}` : ''}
                {gallons > 0 && (
                  <span className="ml-auto inline-flex items-center gap-1 font-mono text-content">
                    <DollarSign className="h-3 w-3" /> COST FOR {gallons.toLocaleString()} GAL
                  </span>
                )}
              </div>
            )}
            <div className="space-y-5">
              {report.airports.map((result) => (
                <AirportResult
                  key={result.airport}
                  result={result}
                  gallons={gallons}
                  feedUnavailable={Boolean(report.providerError)}
                  assignedFbo={assignedFbos[result.airport] || assignedFbos[operationalIcao(result.airport)]}
                />
              ))}
            </div>
            <div className="rounded border border-warning-border bg-warning-soft p-3 text-[10px] text-warning">
              {report.disclaimer
                || 'Planning data only. Confirm airport suitability, NOTAMs, fuel price, fees, and availability before dispatch or quoting.'}
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
