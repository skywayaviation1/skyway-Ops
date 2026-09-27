// Public CFS portal. No Skyway chrome and no dev-mode banner. Sign-in is a
// magic link. One trip can still be acknowledged from the bind-email token
// without a session.

import React, { useEffect, useMemo, useState } from 'react';

const SESSION_KEY = 'cfs-portal-session';
const THEME_KEY = 'cfs-portal-theme';

function params() {
  return new URLSearchParams(window.location.search);
}

async function post(body) {
  const response = await fetch('/api/cfs-portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function money(cents) {
  if (!Number.isInteger(cents)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function CfsPortal() {
  const initial = params();
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'light');
  const [session, setSession] = useState(() => sessionStorage.getItem(SESSION_KEY) || initial.get('preview') || '');
  const [email, setEmail] = useState('');
  const [preview, setPreview] = useState(Boolean(initial.get('preview')));
  const [me, setMe] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sentLink, setSentLink] = useState(false);
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [tail, setTail] = useState('');
  const [aircraft, setAircraft] = useState('');
  const [airport, setAirport] = useState('');
  const [broker, setBroker] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('depart');
  const [trip, setTrip] = useState(null);
  const [events, setEvents] = useState([]);
  const [ackOnly, setAckOnly] = useState(null);
  const [selected, setSelected] = useState({});
  const [costs, setCosts] = useState({});
  const [sameCost, setSameCost] = useState('');
  const [bulkName, setBulkName] = useState('');
  const [bulkReference, setBulkReference] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(null);
  const [statement, setStatement] = useState(null);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [view, setView] = useState('home');

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const query = params();
      const link = query.get('link');
      const ack = query.get('ack');
      if (link) {
        try {
          const data = await post({ action: 'redeem', token: link });
          sessionStorage.setItem(SESSION_KEY, data.sessionToken);
          if (!cancelled) {
            setSession(data.sessionToken);
            setMe(data.email || '');
            setPreview(false);
            setToast('Signed in.');
          }
          window.history.replaceState({}, '', '/cfs');
        } catch (err) {
          if (!cancelled) setError(err.message);
        }
      } else if (ack) {
        try {
          const response = await fetch(`/api/aog-recovery-cfs?token=${encodeURIComponent(ack)}`);
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'This acknowledgement link is not valid');
          if (!cancelled) setAckOnly({ token: ack, coverage: data.coverage });
        } catch (err) {
          if (!cancelled) setError(err.message);
        }
      }
      if (!cancelled) setLoading(false);
    }
    boot();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!session || ackOnly) return undefined;
    let cancelled = false;
    setLoading(true);
    post({
      action: 'list',
      sessionToken: session,
      status: tab,
      q,
      tail,
      aircraft,
      airport,
      broker,
      from,
      to,
      sort,
      page,
    }).then((data) => {
      if (cancelled) return;
      setSummary(data.summary);
      setRows(data.rows || []);
      setPages(data.pages || 1);
      setMe(data.email || '');
      setPreview(data.preview === true);
      setError('');
    }).catch((err) => {
      if (!cancelled) setError(err.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [session, ackOnly, tab, q, tail, aircraft, airport, broker, from, to, sort, page]);

  const needsAction = summary?.needsAction || [];
  const selectedIds = useMemo(() => Object.keys(selected).filter((id) => selected[id]), [selected]);

  async function requestLink(event) {
    event.preventDefault();
    setError('');
    try {
      await post({ action: 'request-link', email });
      setSentLink(true);
      setToast('If this address is on the CFS list, a sign-in link is on its way.');
    } catch (err) {
      setError(err.message);
    }
  }

  async function openTrip(row) {
    setError('');
    setConfirmed(null);
    setView('trip');
    setLoading(true);
    try {
      const data = await post({ action: 'trip', sessionToken: session, id: row.id });
      setTrip(data.trip);
      setEvents(data.events || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function downloadContract() {
    try {
      const data = await post({ action: 'contract', sessionToken: session, id: trip.id });
      window.open(data.url, '_blank', 'noopener');
    } catch (err) {
      setError(err.message);
    }
  }

  async function acknowledgeOne(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const data = await post({
        action: 'acknowledge',
        sessionToken: session,
        id: trip.id,
        name: form.get('name'),
        email: form.get('email') || me,
        cfsCost: form.get('cfsCost'),
        reference: form.get('reference'),
        notes: form.get('notes'),
      });
      const row = data.results?.[0];
      if (!row?.ok) throw new Error(row?.error || 'Acknowledgement failed');
      setConfirmed(trip);
      setToast(row.emailError ? `Saved. Mail: ${row.emailError}` : 'Coverage acknowledged. Skyway ops has been notified.');
      const fresh = await post({ action: 'trip', sessionToken: session, id: trip.id });
      setTrip(fresh.trip);
      setEvents(fresh.events || []);
    } catch (err) {
      setError(err.message);
    }
  }

  function applySameCost() {
    const next = { ...costs };
    selectedIds.forEach((id) => { next[id] = sameCost; });
    setCosts(next);
    setToast('Applied that CFS cost to the selected trips.');
  }

  async function acknowledgeBulk(event) {
    event.preventDefault();
    const trips = selectedIds.map((id) => ({
      id,
      name: bulkName,
      email: me,
      cfsCost: costs[id] || '',
      reference: bulkReference,
      notes: '',
    }));
    try {
      const data = await post({ action: 'bulk-acknowledge', sessionToken: session, trips });
      if (!data.ok) throw new Error(data.results?.find((row) => !row.ok)?.error || 'One trip was not saved');
      setToast(`Acknowledged ${data.results.length} trip${data.results.length === 1 ? '' : 's'}.`);
      setBulkOpen(false);
      setSelected({});
      setPage(1);
      const list = await post({ action: 'list', sessionToken: session, status: tab, page: 1, sort });
      setSummary(list.summary);
      setRows(list.rows || []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadStatement(event) {
    event?.preventDefault();
    setView('statement');
    setLoading(true);
    try {
      const data = await post({ action: 'statement', sessionToken: session, month });
      setStatement(data.statement);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function downloadStatement(format) {
    if (format === 'csv') {
      const data = await post({ action: 'statement', sessionToken: session, month, format: 'csv' });
      const blob = new Blob([data.csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `cfs-statement-${month}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    const response = await fetch('/api/cfs-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'statement', sessionToken: session, month, format: 'pdf' }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setError(data.error || 'Could not build the PDF');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cfs-statement-${month}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function submitAckToken(event) {
    event.preventDefault();
    const form = new FormData(event.target);
    const response = await fetch('/api/aog-recovery-cfs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: ackOnly.token,
        name: form.get('name'),
        email: form.get('email'),
        cfsCost: form.get('cfsCost'),
        reference: form.get('reference'),
        notes: form.get('notes'),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(data.error || 'Request failed');
      return;
    }
    setAckOnly({ ...ackOnly, coverage: data.coverage });
    setConfirmed({ tripId: data.coverage?.tripId });
    setToast(data.emailError ? `Saved. Mail: ${data.emailError}` : 'Coverage acknowledged.');
  }

  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    setSession('');
    setTrip(null);
    setView('home');
    window.history.replaceState({}, '', '/cfs');
  }

  return (
    <main className="cfs-portal sw-sheet" data-theme={theme}>
      <div className="sw-sheet-panel sw-sheet-fill">
        <header className="cfs-header">
          <div>
            <p className="cfs-kicker">Skyway Aviation × Charter Flight Support</p>
            <h1>CFS portal</h1>
          </div>
          <div className="cfs-header-actions">
            <button type="button" className="cfs-btn cfs-btn-ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-pressed={theme === 'dark'}>
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
            {session && <button type="button" className="cfs-btn cfs-btn-ghost" onClick={signOut}>Sign out</button>}
          </div>
        </header>
        <div className="sw-sheet-body cfs-body">
          {preview && <p className="cfs-banner" role="status">Skyway preview. This view is read-only and matches what CFS sees.</p>}
          {toast && <p className="cfs-toast" role="status">{toast}</p>}
          {error && <p className="cfs-error" role="alert">{error}</p>}
          {loading && <Skeleton />}

          {!loading && ackOnly && (
            <AckTokenTrip coverage={ackOnly.coverage} onSubmit={submitAckToken} confirmed={confirmed} />
          )}

          {!loading && !ackOnly && !session && (
            <section className="cfs-card cfs-signin" aria-labelledby="cfs-signin-title">
              <h2 id="cfs-signin-title">Sign in</h2>
              <p>Use the email Charter Flight Support has on file with Skyway. We will send a one-time link. No password.</p>
              <form onSubmit={requestLink}>
                <label>
                  Email
                  <input aria-label="CFS email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
                <button type="submit" className="cfs-btn cfs-btn-primary">Email me a sign-in link</button>
              </form>
              {sentLink && <p role="status">Check that inbox for a message from Skyway. The link expires in 15 minutes.</p>}
            </section>
          )}

          {!loading && !ackOnly && session && view === 'home' && (
            <>
              <section className="cfs-cards" aria-label="Summary">
                <Card label="Awaiting acknowledgement" value={summary ? String(summary.awaiting) : '—'} />
                <Card label="Confirmed this month" value={summary ? String(summary.confirmedThisMonth) : '—'} />
                <Card label="Coverage value bound this month" value={summary?.boundValueLabel || '—'} />
                <Card label="Upcoming flights under coverage" value={summary ? String(summary.upcomingFlights) : '—'} />
              </section>

              <section className="cfs-card" aria-labelledby="needs-action-title">
                <h2 id="needs-action-title">Needs action</h2>
                {needsAction.length === 0 && <p className="cfs-empty">Nothing is waiting. New bind requests show up here, with departures inside 72 hours highlighted.</p>}
                <ul className="cfs-queue">
                  {needsAction.slice(0, 6).map((row) => (
                    <li key={row.id}>
                      <button type="button" className={row.urgent ? 'cfs-urgent' : ''} onClick={() => openTrip(row)}>
                        <strong>{row.tripId || 'Trip'}</strong>
                        <span>{row.route || 'Route pending'} · {row.datesLabel || when(row.departAt)}</span>
                        <span>{row.urgent ? 'Departs within 72 hours' : 'Awaiting acknowledgement'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <div className="cfs-toolbar" role="tablist" aria-label="Trip status">
                {['all', 'awaiting', 'confirmed', 'flown', 'cancelled'].map((name) => (
                  <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? 'is-selected' : ''} onClick={() => { setTab(name); setPage(1); }}>
                    {name[0].toUpperCase() + name.slice(1)}
                  </button>
                ))}
                <button type="button" className="cfs-btn cfs-btn-ghost" onClick={loadStatement}>Monthly statement</button>
              </div>

              <form className="cfs-filters" onSubmit={(event) => { event.preventDefault(); setPage(1); }}>
                <label>Search<input aria-label="Search trips" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Trip ID, tail, route" /></label>
                <label>Tail<input aria-label="Filter tail" value={tail} onChange={(event) => setTail(event.target.value)} /></label>
                <label>Aircraft<input aria-label="Filter aircraft" value={aircraft} onChange={(event) => setAircraft(event.target.value)} /></label>
                <label>Airport<input aria-label="Filter airport" value={airport} onChange={(event) => setAirport(event.target.value)} /></label>
                <label>Broker<input aria-label="Filter broker company" value={broker} onChange={(event) => setBroker(event.target.value)} /></label>
                <label>From<input aria-label="From date" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
                <label>To<input aria-label="To date" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
                <label>Sort
                  <select aria-label="Sort trips" value={sort} onChange={(event) => setSort(event.target.value)}>
                    <option value="depart">Departure</option>
                    <option value="trip">Trip ID</option>
                    <option value="status">Status</option>
                  </select>
                </label>
              </form>

              {rows.length === 0 && <p className="cfs-empty">No trips match these filters.</p>}
              <ul className="cfs-list">
                {rows.map((row) => (
                  <li key={row.id} className="cfs-card">
                    <label className="cfs-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.tripId}`}
                        checked={Boolean(selected[row.id])}
                        disabled={preview || row.status === 'cancelled'}
                        onChange={(event) => setSelected((current) => ({ ...current, [row.id]: event.target.checked }))}
                      />
                      Select
                    </label>
                    <button type="button" className="cfs-trip-link" onClick={() => openTrip(row)}>
                      <strong>{row.tripId}</strong>
                      <span>{row.tail} · {row.aircraftType}</span>
                      <span>{row.route}</span>
                      <span>{row.datesLabel}</span>
                      <span>Coverage: 100% · Coverage value: {row.coverageValueLabel || '—'}</span>
                      <span className={row.urgent ? 'cfs-pill cfs-pill-urgent' : 'cfs-pill'}>{row.status}{row.urgent ? ' · 72h' : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="cfs-pager">
                <button type="button" className="cfs-btn cfs-btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <span>Page {page} of {pages}</span>
                <button type="button" className="cfs-btn cfs-btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
              </div>

              {selectedIds.length > 0 && (
                <section className="cfs-card" aria-labelledby="bulk-title">
                  <h2 id="bulk-title">Acknowledge {selectedIds.length} selected</h2>
                  <label>Same CFS cost
                    <input aria-label="Same CFS cost" inputMode="decimal" value={sameCost} onChange={(event) => setSameCost(event.target.value)} />
                  </label>
                  <button type="button" className="cfs-btn cfs-btn-ghost" onClick={applySameCost}>Apply same cost</button>
                  <button type="button" className="cfs-btn cfs-btn-primary" onClick={() => setBulkOpen(true)}>Review bulk acknowledgement</button>
                  {bulkOpen && (
                    <form onSubmit={acknowledgeBulk} className="cfs-bulk">
                      <label>Your name<input aria-label="Bulk name" required value={bulkName} onChange={(event) => setBulkName(event.target.value)} /></label>
                      <label>Reference<input aria-label="Bulk reference" value={bulkReference} onChange={(event) => setBulkReference(event.target.value)} /></label>
                      {selectedIds.map((id) => {
                        const row = rows.find((item) => item.id === id) || needsAction.find((item) => item.id === id);
                        return (
                          <label key={id}>{row?.tripId || id} CFS cost
                            <input aria-label={`CFS cost ${row?.tripId || id}`} required value={costs[id] || ''} onChange={(event) => setCosts((current) => ({ ...current, [id]: event.target.value }))} />
                          </label>
                        );
                      })}
                      <button type="submit" className="cfs-btn cfs-btn-primary">Acknowledge selected trips</button>
                    </form>
                  )}
                </section>
              )}
            </>
          )}

          {!loading && !ackOnly && session && view === 'trip' && trip && (
            <TripView
              trip={trip}
              events={events}
              me={me}
              preview={preview}
              confirmed={confirmed}
              onBack={() => { setView('home'); setTrip(null); }}
              onDownload={downloadContract}
              onSubmit={acknowledgeOne}
            />
          )}

          {!loading && !ackOnly && session && view === 'statement' && (
            <Statement
              month={month}
              setMonth={setMonth}
              statement={statement}
              onLoad={loadStatement}
              onCsv={() => downloadStatement('csv')}
              onPdf={() => downloadStatement('pdf')}
              onBack={() => setView('home')}
            />
          )}
          <p className="cfs-end">End of portal</p>
        </div>
      </div>
    </main>
  );
}

function Card({ label, value }) {
  return (
    <article className="cfs-card cfs-stat">
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function Skeleton() {
  return (
    <div className="cfs-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function TripView({ trip, events, me, preview, confirmed, onBack, onDownload, onSubmit }) {
  return (
    <article>
      <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onBack}>Back to trips</button>
      <header className="cfs-trip-head">
        <p className="cfs-kicker">Trip {trip.tripId}</p>
        <h2>{trip.route || 'Route pending'}</h2>
        <p>{trip.tail} · {trip.aircraftType} · {trip.brokerCompany}</p>
      </header>
      <section className="cfs-card" aria-label="Coverage summary">
        <h3>Coverage</h3>
        <p>Coverage: 100%</p>
        <p>Contract trip total: {trip.tripTotalLabel || '—'}</p>
        <p>Coverage value: {trip.coverageValueLabel || '—'}</p>
        <p>Bind requested: {when(trip.bindRequestedAt)}</p>
        <p>Status: {trip.status}</p>
      </section>
      <section className="cfs-card" aria-label="Leg timeline">
        <h3>Legs</h3>
        {(trip.legs || []).length === 0 && <p className="cfs-empty">No leg times are on file yet.</p>}
        <ol className="cfs-timeline">
          {(trip.legs || []).map((leg, index) => (
            <li key={`${leg.from}-${leg.departAt}-${index}`}>
              <strong>{leg.from || '—'} → {leg.to || '—'}</strong>
              <span>{when(leg.departAt)} – {when(leg.arriveAt)}</span>
              {leg.tail && <span>{leg.tail}</span>}
            </li>
          ))}
        </ol>
      </section>
      <section className="cfs-card">
        <h3>Charter contract</h3>
        {trip.hasContract ? <button type="button" className="cfs-btn cfs-btn-primary" onClick={onDownload}>Download contract</button> : <p className="cfs-empty">No contract file is attached yet.</p>}
      </section>
      <section className="cfs-card" aria-label="Event history">
        <h3>History</h3>
        {events.length === 0 && <p className="cfs-empty">No portal history yet.</p>}
        <ul>{events.map((event) => <li key={event.id}>{event.type} · {when(event.at)} {event.detail}</li>)}</ul>
      </section>
      {confirmed && <p className="cfs-confirm" role="status">Coverage acknowledged for {trip.tripId}. Skyway ops has a new revision.</p>}
      {!preview && (
        <form className="cfs-card" onSubmit={onSubmit} aria-label="Acknowledge coverage">
          <h3>{trip.acknowledgement ? 'Update acknowledgement' : 'Acknowledge coverage'}</h3>
          <label>Your name<input aria-label="Your name" name="name" required defaultValue={trip.acknowledgement?.name || ''} /></label>
          <label>Your email<input aria-label="Your email" name="email" type="email" required defaultValue={trip.acknowledgement?.email || me} /></label>
          <label>CFS cost (USD)<input aria-label="CFS cost" name="cfsCost" inputMode="decimal" required defaultValue={trip.acknowledgement?.cfsCostCents != null ? (trip.acknowledgement.cfsCostCents / 100).toFixed(2) : ''} /></label>
          <label>Policy or reference number (optional)<input aria-label="Policy or reference number" name="reference" defaultValue={trip.acknowledgement?.reference || ''} /></label>
          <label>Notes (optional)<textarea aria-label="Notes" name="notes" rows={4} defaultValue={trip.acknowledgement?.notes || ''} /></label>
          <button type="submit" className="cfs-btn cfs-btn-primary">{trip.acknowledgement ? 'Update acknowledgement' : 'Acknowledge coverage'}</button>
        </form>
      )}
      {preview && <p className="cfs-empty">Preview cannot acknowledge coverage.</p>}
      <p className="cfs-end">End of trip</p>
    </article>
  );
}

function AckTokenTrip({ coverage, onSubmit, confirmed }) {
  if (!coverage) return <p className="cfs-empty">This link does not match a trip.</p>;
  return (
    <article>
      <p className="cfs-kicker">This link acknowledges one trip. No sign-in required.</p>
      <h2>Trip {coverage.tripId}</h2>
      <section className="cfs-card">
        <p>{coverage.tail} · {coverage.aircraftType}</p>
        <p>{coverage.route}</p>
        <p>{coverage.datesLabel}</p>
        <p>Coverage: 100%</p>
        <p>Contract trip total: {coverage.tripTotal != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(coverage.tripTotal)) : '—'}</p>
        <p>Coverage value: {coverage.coverageValueLabel || '—'}</p>
      </section>
      {confirmed && <p className="cfs-confirm" role="status">Coverage acknowledged.</p>}
      <form className="cfs-card" onSubmit={onSubmit}>
        <label>Your name<input aria-label="Your name" name="name" required defaultValue={coverage.acknowledgement?.name || ''} /></label>
        <label>Your email<input aria-label="Your email" name="email" type="email" required defaultValue={coverage.acknowledgement?.email || ''} /></label>
        <label>CFS cost (USD)<input aria-label="CFS cost" name="cfsCost" inputMode="decimal" required defaultValue={coverage.acknowledgement?.cfsCost || ''} /></label>
        <label>Policy or reference number (optional)<input aria-label="Policy or reference number" name="reference" defaultValue={coverage.acknowledgement?.reference || ''} /></label>
        <label>Notes (optional)<textarea aria-label="Notes" name="notes" rows={4} defaultValue={coverage.acknowledgement?.notes || ''} /></label>
        <button type="submit" className="cfs-btn cfs-btn-primary">Acknowledge coverage</button>
      </form>
      <p><a href="/cfs">Open the CFS portal</a> for every other trip.</p>
    </article>
  );
}

function Statement({ month, setMonth, statement, onLoad, onCsv, onPdf, onBack }) {
  return (
    <section>
      <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onBack}>Back to trips</button>
      <h2>Monthly statement</h2>
      <p>Bound coverages CFS can invoice to Skyway. Coverage value and CFS cost only.</p>
      <form onSubmit={onLoad} className="cfs-filters">
        <label>Month<input aria-label="Statement month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <button type="submit" className="cfs-btn cfs-btn-primary">Show statement</button>
      </form>
      {statement && (
        <>
          <table className="cfs-table">
            <thead>
              <tr><th>Trip</th><th>Route</th><th>Coverage value</th><th>CFS cost</th></tr>
            </thead>
            <tbody>
              {statement.rows.length === 0 && <tr><td colSpan={4}>Nothing was confirmed in this month.</td></tr>}
              {statement.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.tripId}</td>
                  <td>{row.route}</td>
                  <td>{row.coverageValueLabel || money(row.coverageLimitCents)}</td>
                  <td>{row.acknowledgement?.cfsCostLabel || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Coverage value total {money(statement.coverageLimitCents)}</p>
          <p>CFS cost total {money(statement.cfsCostCents)}</p>
          <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onCsv}>Download CSV</button>
          <button type="button" className="cfs-btn cfs-btn-primary" onClick={onPdf}>Download PDF</button>
        </>
      )}
    </section>
  );
}
