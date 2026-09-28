// Public CFS portal. No Skyway chrome and no dev-mode banner. Sign-in is a
// magic link. One trip can still be acknowledged from the bind-email token
// without a session.

import React, { useEffect, useMemo, useState } from 'react';

const SESSION_KEY = 'cfs-portal-session';
const THEME_KEY = 'cfs-portal-theme';

const TABS = [
  ['all', 'All'],
  ['awaiting', 'Awaiting'],
  ['confirmed', 'Confirmed'],
  ['flown', 'Flown'],
  ['cancelled', 'Cancelled'],
];

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

// A magic link is single use. React's dev double-render would redeem it
// twice and the second call would fail, so one in-flight redeem is shared.
const linkRedeems = new Map();
function redeemLink(token) {
  if (!linkRedeems.has(token)) linkRedeems.set(token, post({ action: 'redeem', token }));
  return linkRedeems.get(token);
}

function upTo(label) {
  if (!label) return '—';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function money(cents) {
  if (!Number.isInteger(cents)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function when(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function dayStamp(value) {
  if (!value) return '';
  const raw = String(value);
  const date = new Date(raw.length === 10 ? `${raw}T15:00:00.000Z` : raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function dateRange(row) {
  const start = dayStamp(row?.departAt);
  const end = dayStamp(row?.returnAt);
  if (start && end && start !== end) return `${start} - ${end}`;
  if (start) return start;
  return row?.datesLabel || 'Dates pending';
}

function airports(route) {
  const parts = String(route || '').split(/\s*(?:→|->|—|–)\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;
  return parts.length ? parts : ['Route pending'];
}

function urgencyCopy(departAt) {
  const ms = Date.parse(departAt || '');
  if (!Number.isFinite(ms)) return { label: 'Departs within 72 hours', tone: 'soon' };
  const hours = (ms - Date.now()) / 36e5;
  if (hours < 24) return { label: hours < 1 ? 'Departs within the hour' : 'Departs today', tone: 'now' };
  const days = Math.max(1, Math.round(hours / 24));
  return { label: days === 1 ? 'Departs in 1 day' : `Departs in ${days} days`, tone: 'soon' };
}

function statusLabel(status) {
  const name = String(status || 'awaiting');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function eventLabel(type) {
  if (type === 'bound') return 'Coverage bound';
  if (type === 'cfs_acknowledged') return 'Acknowledged';
  if (type === 'cfs_reminder_sent') return 'Reminder sent';
  if (type === 'cfs_portal_opened') return 'Opened in the portal';
  return String(type || 'Update').replaceAll('_', ' ');
}

function costError(value) {
  const raw = String(value ?? '').trim().replace(/[$,\s]/g, '');
  if (!raw) return 'Enter the CFS cost.';
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return 'Use a dollar amount like 640.00.';
  return '';
}

function scrollPortal() {
  document.querySelector('.cfs-portal .sw-sheet-body')?.scrollTo(0, 0);
}

function ActiveAog({ incident, onRespond }) {
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onRespond(response);
      setResponse('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="cfs-aog-card">
      <p className="cfs-kicker">Active AOG · {incident.tripId}</p>
      <h3>{incident.location || 'Location pending'}</h3>
      <p>{incident.issue}</p>
      <p className="cfs-meta">{[incident.tail, incident.aircraftType, incident.route, incident.aogAt].filter(Boolean).join(' · ')}</p>
      {incident.coverage === '100%' && <p className="cfs-meta">Coverage: 100%</p>}
      {(incident.updates || []).slice(-3).map((row) => (
        <p key={`${row.at}-${row.text}`} className="cfs-meta">{row.text}</p>
      ))}
      <form onSubmit={submit} className="cfs-aog-form">
        <label>
          Response
          <textarea aria-label={`Response for ${incident.tripId}`} value={response} onChange={(event) => setResponse(event.target.value)} required rows={2} />
        </label>
        {error && <p className="cfs-error" role="alert">{error}</p>}
        <button type="submit" className="cfs-btn" disabled={busy || response.trim().length < 2}>Send response</button>
      </form>
    </article>
  );
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [trip, setTrip] = useState(null);
  const [events, setEvents] = useState([]);
  const [ackOnly, setAckOnly] = useState(null);
  const [aogOnly, setAogOnly] = useState(null);
  const [incidents, setIncidents] = useState([]);
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
    const id = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const query = params();
      const link = query.get('link');
      const ack = query.get('ack');
      const aog = query.get('aog');
      if (link) {
        try {
          const data = await redeemLink(link);
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
      } else if (aog) {
        try {
          const data = await post({ action: 'incident', token: aog });
          if (!cancelled) setAogOnly({ token: aog, incident: data.incident });
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
    if (!session || ackOnly || aogOnly) return undefined;
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
      setIncidents(Array.isArray(data.incidents) ? data.incidents : []);
      setError('');
    }).catch((err) => {
      if (!cancelled) setError(err.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [session, ackOnly, aogOnly, tab, q, tail, aircraft, airport, broker, from, to, sort, page]);

  const needsAction = summary?.needsAction || [];
  const selectedIds = useMemo(() => Object.keys(selected).filter((id) => selected[id]), [selected]);
  const counts = summary?.counts || { all: 0, awaiting: summary?.awaiting || 0, confirmed: 0, flown: 0, cancelled: 0 };
  const filterCount = [tail, aircraft, airport, broker, from, to].filter(Boolean).length;

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
    setAccountOpen(false);
    setView('trip');
    setLoading(true);
    scrollPortal();
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

  async function downloadContract(open) {
    try {
      const data = await post({ action: 'contract', sessionToken: session, id: trip.id });
      window.open(data.url, '_blank', open ? 'noopener' : 'noopener');
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
      scrollPortal();
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
    setAccountOpen(false);
    setLoading(true);
    scrollPortal();
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
    scrollPortal();
  }

  function signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    setSession('');
    setTrip(null);
    setView('home');
    setAccountOpen(false);
    window.history.replaceState({}, '', '/cfs');
  }

  const logo = theme === 'dark' ? '/skyway-logo-nav-reverse.png' : '/skyway-logo-nav.png';

  return (
    <main className="cfs-portal sw-sheet" data-theme={theme}>
      <div className="sw-sheet-panel sw-sheet-fill">
        <header className="cfs-header">
          <div className="cfs-brand">
            <img src={logo} alt="Skyway Aviation" />
            <span className="cfs-brand-x" aria-hidden="true">×</span>
            <h1>Charter Flight Support</h1>
          </div>
          <div className="cfs-header-actions">
            <button
              type="button"
              className="cfs-icon-btn"
              aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            {session && (
              <div className="cfs-account">
                <button
                  type="button"
                  className="cfs-icon-btn"
                  aria-label="Account"
                  aria-expanded={accountOpen}
                  onClick={() => setAccountOpen((open) => !open)}
                >
                  <UserIcon />
                </button>
                {accountOpen && (
                  <div className="cfs-account-menu" role="menu">
                    <p>{me || 'Signed in'}</p>
                    <button type="button" role="menuitem" onClick={signOut}>Sign out</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>
        <div className="sw-sheet-body cfs-body">
          {preview && <p className="cfs-banner" role="status">Skyway preview. This view is read-only and matches what CFS sees.</p>}
          {error && <p className="cfs-error" role="alert">{error}</p>}
          {loading && <Skeleton />}

          {!loading && ackOnly && (
            <AckTokenTrip coverage={ackOnly.coverage} onSubmit={submitAckToken} confirmed={confirmed} />
          )}

          {!loading && aogOnly && (
            <ActiveAog incident={aogOnly.incident} onRespond={async (response) => {
              const data = await post({ action: 'incident-respond', token: aogOnly.token, response });
              setAogOnly({ token: aogOnly.token, incident: data.incident });
              setToast('Response sent to Skyway.');
            }} />
          )}

          {!loading && !ackOnly && !session && (
            <section className="cfs-card cfs-signin" aria-labelledby="cfs-signin-title">
              <p className="cfs-kicker">Passwordless sign-in</p>
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

          {!loading && !ackOnly && !aogOnly && session && view === 'home' && (
            <>
              <section className="cfs-cards" aria-label="Summary">
                <Stat icon={<ClockIcon />} label="Awaiting acknowledgement" value={summary ? String(summary.awaiting) : '—'} />
                <Stat icon={<CheckIcon />} label="Confirmed this month" value={summary ? String(summary.confirmedThisMonth) : '—'} />
                <Stat icon={<ShieldIcon />} label="Coverage value bound this month" value={summary?.boundValueLabel || '—'} />
                <Stat icon={<PlaneIcon />} label="Upcoming flights under coverage" value={summary ? String(summary.upcomingFlights) : '—'} />
              </section>

              {incidents.length > 0 && (
                <section className="cfs-section cfs-aog-live" aria-label="Active AOG">
                  <div className="cfs-section-head">
                    <h2>Active AOG</h2>
                    <p>These trips need a response now.</p>
                  </div>
                  {incidents.map((incident) => (
                    <ActiveAog key={incident.id} incident={incident} onRespond={async (response) => {
                      await post({ action: 'incident-respond', sessionToken: session, incidentId: incident.id, response });
                      setToast('Response sent to Skyway.');
                      const list = await post({ action: 'list', sessionToken: session, status: tab, page });
                      setIncidents(list.incidents || []);
                    }} />
                  ))}
                </section>
              )}

              <section className="cfs-section" aria-labelledby="needs-action-title">
                <div className="cfs-section-head">
                  <h2 id="needs-action-title">Needs action</h2>
                  <p>Sorted by departure. Flights inside 72 hours are marked.</p>
                </div>
                {needsAction.length === 0 && (
                  <p className="cfs-empty">Nothing is waiting. New bind requests show up here, with departures inside 72 hours highlighted.</p>
                )}
                <ul className="cfs-queue">
                  {needsAction.slice(0, 6).map((row) => (
                    <TripRow key={row.id} row={row} onOpen={openTrip} />
                  ))}
                </ul>
              </section>

              <div className="cfs-list-head">
                <div className="cfs-toolbar" role="tablist" aria-label="Trip status">
                  {TABS.map(([name, label]) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={tab === name}
                      className={tab === name ? 'is-selected' : ''}
                      onClick={() => { setTab(name); setPage(1); }}
                    >
                      {label}
                      <span className="cfs-count">{counts[name] ?? 0}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className="cfs-btn cfs-btn-ghost" onClick={loadStatement}>Monthly statement</button>
              </div>

              <div className="cfs-search-row">
                <label className="cfs-search">
                  Search
                  <input aria-label="Search trips" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Trip ID, tail, route" />
                </label>
                <button type="button" className="cfs-btn cfs-filter-toggle" onClick={() => setFiltersOpen(true)}>
                  Filters{filterCount ? ` (${filterCount})` : ''}
                </button>
              </div>

              <form
                className={filtersOpen ? 'cfs-filter-sheet is-open' : 'cfs-filter-sheet'}
                aria-label="Filters"
                onSubmit={(event) => { event.preventDefault(); setPage(1); setFiltersOpen(false); }}
              >
                <div className="cfs-sheet-grab">
                  <h2>Filters</h2>
                  <button type="button" className="cfs-filter-done" onClick={() => setFiltersOpen(false)}>Done</button>
                </div>
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
                <button type="submit" className="cfs-btn cfs-btn-primary cfs-filter-done">Apply filters</button>
              </form>

              {rows.length === 0 && <p className="cfs-empty">No trips match these filters. Clear a filter or switch tabs to see the rest of the book.</p>}
              <ul className="cfs-list">
                {rows.map((row) => (
                  <TripRow
                    key={row.id}
                    row={row}
                    onOpen={openTrip}
                    selected={Boolean(selected[row.id])}
                    selectable={!preview && row.status !== 'cancelled'}
                    onSelect={(checked) => setSelected((current) => ({ ...current, [row.id]: checked }))}
                  />
                ))}
              </ul>
              <div className="cfs-pager">
                <button type="button" className="cfs-btn cfs-btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <span className="cfs-num">Page {page} of {pages}</span>
                <button type="button" className="cfs-btn cfs-btn-ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
              </div>

              {selectedIds.length > 0 && (
                <section className="cfs-card cfs-bulk" aria-labelledby="bulk-title">
                  <h2 id="bulk-title">Acknowledge {selectedIds.length} selected</h2>
                  <p>Each trip keeps its own CFS cost. Apply one amount, then adjust any row before you send.</p>
                  <label>Same CFS cost
                    <span className="cfs-money">
                      <span aria-hidden="true">$</span>
                      <input aria-label="Same CFS cost" inputMode="decimal" value={sameCost} onChange={(event) => setSameCost(event.target.value)} />
                    </span>
                  </label>
                  <div className="cfs-actions">
                    <button type="button" className="cfs-btn cfs-btn-ghost" onClick={applySameCost}>Apply same cost</button>
                    <button type="button" className="cfs-btn cfs-btn-primary" onClick={() => setBulkOpen(true)}>Review bulk acknowledgement</button>
                  </div>
                  {bulkOpen && (
                    <form onSubmit={acknowledgeBulk} className="cfs-bulk-form">
                      <label>Your name<input aria-label="Bulk name" required value={bulkName} onChange={(event) => setBulkName(event.target.value)} /></label>
                      <label>Reference<input aria-label="Bulk reference" value={bulkReference} onChange={(event) => setBulkReference(event.target.value)} /></label>
                      {selectedIds.map((id) => {
                        const row = rows.find((item) => item.id === id) || needsAction.find((item) => item.id === id);
                        return (
                          <label key={id}>{row?.tripId || id} CFS cost
                            <span className="cfs-money">
                              <span aria-hidden="true">$</span>
                              <input aria-label={`CFS cost ${row?.tripId || id}`} required value={costs[id] || ''} onChange={(event) => setCosts((current) => ({ ...current, [id]: event.target.value }))} />
                            </span>
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

          {!loading && !ackOnly && !aogOnly && session && view === 'trip' && trip && (
            <TripView
              trip={trip}
              events={events}
              me={me}
              preview={preview}
              confirmed={confirmed}
              onBack={() => { setView('home'); setTrip(null); setConfirmed(null); scrollPortal(); }}
              onDownload={() => downloadContract(false)}
              onView={() => downloadContract(true)}
              onSubmit={acknowledgeOne}
            />
          )}

          {!loading && !ackOnly && !aogOnly && session && view === 'statement' && (
            <Statement
              month={month}
              setMonth={setMonth}
              statement={statement}
              onLoad={loadStatement}
              onCsv={() => downloadStatement('csv')}
              onPdf={() => downloadStatement('pdf')}
              onBack={() => { setView('home'); scrollPortal(); }}
            />
          )}
          <p className="cfs-end">End of portal</p>
        </div>
      </div>
      {toast && <p className="cfs-toast" role="status">{toast}</p>}
    </main>
  );
}

function Stat({ icon, label, value }) {
  return (
    <article className="cfs-card cfs-stat">
      <div className="cfs-stat-icon" aria-hidden="true">{icon}</div>
      <p>{label}</p>
      <strong className="cfs-num">{value}</strong>
    </article>
  );
}

function TripRow({ row, onOpen, selected = false, selectable = false, onSelect }) {
  const urgent = row.urgent ? urgencyCopy(row.departAt) : null;
  const codes = airports(row.route);
  return (
    <li className={row.urgent ? 'cfs-row is-urgent' : 'cfs-row'}>
      {onSelect && (
        <label className="cfs-check">
          <input
            type="checkbox"
            aria-label={`Select ${row.tripId}`}
            checked={selected}
            disabled={!selectable}
            onChange={(event) => onSelect(event.target.checked)}
          />
        </label>
      )}
      <button type="button" className="cfs-row-main" onClick={() => onOpen(row)}>
        <span className="cfs-row-top">
          <span className="cfs-trip-id">{row.tripId || 'Trip'}</span>
          <StatusPill status={row.status} />
        </span>
        <span className="cfs-route">
          {codes.map((code, index) => (
            <React.Fragment key={`${code}-${index}`}>
              {index > 0 && <ArrowIcon />}
              <span>{code}</span>
            </React.Fragment>
          ))}
        </span>
        <span className="cfs-meta cfs-num">{dateRange(row)}</span>
        <span className="cfs-meta">{[row.aircraftType, row.tail].filter(Boolean).join(' · ') || 'Aircraft pending'}</span>
        <span className={row.coverageValueLabel ? 'cfs-meta' : 'cfs-meta cfs-pending'}>
          Coverage value: {row.coverageValueLabel || 'pending trip total'}
        </span>
        {urgent && <span className={urgent.tone === 'now' ? 'cfs-urgency is-now' : 'cfs-urgency'}>{urgent.label}</span>}
        <ChevronIcon />
      </button>
    </li>
  );
}

function StatusPill({ status }) {
  return <span className={`cfs-pill cfs-pill-${status || 'awaiting'}`}>{statusLabel(status)}</span>;
}

function Skeleton() {
  return (
    <div className="cfs-skeleton" aria-hidden="true">
      <span /><span /><span /><span />
      <span className="cfs-skeleton-row" /><span className="cfs-skeleton-row" /><span className="cfs-skeleton-row" />
    </div>
  );
}

function TripView({ trip, events, me, preview, confirmed, onBack, onDownload, onView, onSubmit }) {
  return (
    <article className="cfs-trip">
      <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onBack}>Back to trips</button>
      <header className="cfs-trip-head">
        <p className="cfs-kicker">Trip <span className="cfs-trip-id">{trip.tripId}</span></p>
        <h2 className="cfs-route cfs-route-lg">
          {airports(trip.route).map((code, index) => (
            <React.Fragment key={`${code}-${index}`}>
              {index > 0 && <ArrowIcon />}
              <span>{code}</span>
            </React.Fragment>
          ))}
        </h2>
        <p>{[trip.aircraftType, trip.tail, trip.brokerCompany].filter(Boolean).join(' · ')}</p>
      </header>
      <section className="cfs-card" aria-label="Coverage summary">
        <div className="cfs-section-head">
          <h3>Coverage</h3>
          <StatusPill status={trip.status} />
        </div>
        <dl className="cfs-facts">
          <div><dt>Coverage</dt><dd>100%</dd></div>
          <div><dt>Contract trip total</dt><dd className="cfs-num">{trip.tripTotalLabel || '—'}</dd></div>
          <div><dt>Coverage value</dt><dd className="cfs-num">{upTo(trip.coverageValueLabel)}</dd></div>
          <div><dt>Bind requested</dt><dd className="cfs-num">{when(trip.bindRequestedAt)}</dd></div>
        </dl>
      </section>
      <section className="cfs-card" aria-label="Leg timeline">
        <h3>Legs</h3>
        {(trip.legs || []).length === 0 && <p className="cfs-empty">No leg times are on file yet. Skyway will add them when the itinerary is final.</p>}
        <ol className="cfs-legs">
          {(trip.legs || []).map((leg, index) => (
            <li key={`${leg.from}-${leg.departAt}-${index}`}>
              <span className="cfs-leg-index">{index + 1}</span>
              <div>
                <p className="cfs-route">
                  <span className="cfs-code">{leg.from || '—'}</span>
                  <ArrowIcon />
                  <span className="cfs-code">{leg.to || '—'}</span>
                </p>
                <p className="cfs-leg-time"><span>Departs</span><time className="cfs-num">{when(leg.departAt)}</time></p>
                <p className="cfs-leg-time"><span>Arrives</span><time className="cfs-num">{when(leg.arriveAt)}</time></p>
                <p className="cfs-meta">{[trip.aircraftType, leg.tail || trip.tail].filter(Boolean).join(' · ')}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="cfs-card">
        <h3>Charter contract</h3>
        {trip.hasContract ? (
          <div className="cfs-file">
            <div>
              <strong>Charter contract</strong>
              <span>PDF</span>
            </div>
            <div className="cfs-actions">
              <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onView}>View</button>
              <button type="button" className="cfs-btn cfs-btn-primary" onClick={onDownload}>Download</button>
            </div>
          </div>
        ) : (
          <div className="cfs-empty-state">
            <FileIcon />
            <strong>No contract attached yet</strong>
            <p>Skyway will attach the signed charter here.</p>
          </div>
        )}
      </section>
      <section className="cfs-card" aria-label="Event history">
        <h3>History</h3>
        {events.length === 0 && <p className="cfs-empty">No portal history yet. Bind requests, reminders, and acknowledgements will appear here.</p>}
        <ol className="cfs-history">
          {events.map((event) => (
            <li key={event.id}>
              <span className="cfs-history-dot" aria-hidden="true" />
              <div>
                <strong>{eventLabel(event.type)}</strong>
                <time className="cfs-num">{when(event.at)}</time>
                {event.detail && <p>{event.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      {confirmed && <Success trip={trip} onBack={onBack} />}
      {!preview && !confirmed && (
        <AckForm
          heading={trip.acknowledgement ? 'Update acknowledgement' : 'Acknowledge coverage'}
          submitLabel={trip.acknowledgement ? 'Update acknowledgement' : 'Acknowledge coverage'}
          initial={{
            name: trip.acknowledgement?.name || '',
            email: trip.acknowledgement?.email || me || '',
            cfsCost: trip.acknowledgement?.cfsCostCents != null ? (trip.acknowledgement.cfsCostCents / 100).toFixed(2) : '',
            reference: trip.acknowledgement?.reference || '',
            notes: trip.acknowledgement?.notes || '',
          }}
          onSubmit={onSubmit}
        />
      )}
      {preview && <p className="cfs-empty">Preview cannot acknowledge coverage.</p>}
      <p className="cfs-end">End of trip</p>
    </article>
  );
}

function Success({ trip, onBack }) {
  const cost = trip?.acknowledgement?.cfsCostLabel || '';
  return (
    <section className="cfs-success" role="status">
      <div className="cfs-success-mark" aria-hidden="true"><CheckIcon /></div>
      <h2>Coverage acknowledged</h2>
      <p>Coverage acknowledged for {trip?.tripId || 'this trip'}. Skyway ops has a new revision.</p>
      <dl className="cfs-facts">
        <div><dt>Trip</dt><dd className="cfs-trip-id">{trip?.tripId}</dd></div>
        <div><dt>Coverage</dt><dd>100%</dd></div>
        <div><dt>Coverage value</dt><dd className="cfs-num">{trip?.coverageValueLabel || '—'}</dd></div>
        {cost && <div><dt>CFS cost</dt><dd className="cfs-num">{cost}</dd></div>}
      </dl>
      {onBack && <button type="button" className="cfs-btn cfs-btn-primary" onClick={onBack}>Done</button>}
    </section>
  );
}

function AckForm({ heading, submitLabel, initial, onSubmit }) {
  const [name, setName] = useState(initial.name || '');
  const [email, setEmail] = useState(initial.email || '');
  const [cfsCost, setCfsCost] = useState(initial.cfsCost || '');
  const [reference, setReference] = useState(initial.reference || '');
  const [notes, setNotes] = useState(initial.notes || '');
  const [errors, setErrors] = useState({});

  function handle(event) {
    const data = new FormData(event.target);
    const nextName = String(data.get('name') || '');
    const nextEmail = String(data.get('email') || '');
    const nextCost = String(data.get('cfsCost') || '');
    const next = {
      name: nextName.trim().length < 2 ? 'Enter your name.' : '',
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail.trim()) ? '' : 'Enter a valid email.',
      cfsCost: costError(nextCost),
    };
    if (next.name || next.email || next.cfsCost) {
      event.preventDefault();
      setErrors(next);
      return;
    }
    onSubmit(event);
  }

  return (
    <form className="cfs-card cfs-ack-form" onSubmit={handle} aria-label="Acknowledge coverage">
      <h3>{heading}</h3>
      <div className="cfs-fields">
        <label>
          Your name
          <input aria-label="Your name" name="name" required value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          {errors.name && <span className="cfs-field-error" role="alert">{errors.name}</span>}
        </label>
        <label>
          Your email
          <input aria-label="Your email" name="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
          {errors.email && <span className="cfs-field-error" role="alert">{errors.email}</span>}
        </label>
        <label>
          CFS cost (USD)
          <span className="cfs-money">
            <span aria-hidden="true">$</span>
            <input aria-label="CFS cost" name="cfsCost" inputMode="decimal" required value={cfsCost} onChange={(event) => setCfsCost(event.target.value)} />
          </span>
          {errors.cfsCost && <span className="cfs-field-error" role="alert">{errors.cfsCost}</span>}
        </label>
        <label>
          Policy or reference number (optional)
          <input aria-label="Policy or reference number" name="reference" value={reference} onChange={(event) => setReference(event.target.value)} />
        </label>
        <label className="cfs-span">
          Notes (optional)
          <textarea aria-label="Notes" name="notes" rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>
      <div className="cfs-ack-bar">
        <button type="submit" className="cfs-btn cfs-btn-primary">{submitLabel}</button>
      </div>
    </form>
  );
}

function AckTokenTrip({ coverage, onSubmit, confirmed }) {
  if (!coverage) return <p className="cfs-empty">This link does not match a trip. Ask Skyway to resend the bind email.</p>;
  return (
    <article className="cfs-trip">
      <p className="cfs-kicker">This link acknowledges one trip. No sign-in required.</p>
      <h2 className="cfs-route cfs-route-lg">
        {airports(coverage.route).map((code, index) => (
          <React.Fragment key={`${code}-${index}`}>
            {index > 0 && <ArrowIcon />}
            <span>{code}</span>
          </React.Fragment>
        ))}
      </h2>
      <p className="cfs-trip-id">Trip {coverage.tripId}</p>
      <section className="cfs-card" aria-label="Coverage summary">
        <dl className="cfs-facts">
          <div><dt>Aircraft</dt><dd>{[coverage.tail, coverage.aircraftType].filter(Boolean).join(' · ') || '—'}</dd></div>
          <div><dt>Dates</dt><dd className="cfs-num">{coverage.datesLabel || '—'}</dd></div>
          <div><dt>Coverage</dt><dd>100%</dd></div>
          <div><dt>Contract trip total</dt><dd className="cfs-num">{coverage.tripTotal != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(coverage.tripTotal)) : '—'}</dd></div>
          <div><dt>Coverage value</dt><dd className="cfs-num">{upTo(coverage.coverageValueLabel)}</dd></div>
        </dl>
      </section>
      {confirmed ? <Success trip={{ ...coverage, tripId: coverage.tripId, coverageValueLabel: coverage.coverageValueLabel }} /> : (
        <AckForm
          heading="Acknowledge coverage"
          submitLabel="Acknowledge coverage"
          initial={{
            name: coverage.acknowledgement?.name || '',
            email: coverage.acknowledgement?.email || '',
            cfsCost: coverage.acknowledgement?.cfsCost || '',
            reference: coverage.acknowledgement?.reference || '',
            notes: coverage.acknowledgement?.notes || '',
          }}
          onSubmit={onSubmit}
        />
      )}
      <p><a href="/cfs">Open the CFS portal</a> for every other trip.</p>
    </article>
  );
}

function Statement({ month, setMonth, statement, onLoad, onCsv, onPdf, onBack }) {
  return (
    <section className="cfs-statement">
      <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onBack}>Back to trips</button>
      <h2>Monthly statement</h2>
      <p>Bound coverages CFS can invoice to Skyway. Coverage value and CFS cost only.</p>
      <form onSubmit={onLoad} className="cfs-statement-bar">
        <label>Month<input aria-label="Statement month" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <button type="submit" className="cfs-btn cfs-btn-primary">Show statement</button>
      </form>
      {statement && (
        <>
          {statement.rows.length === 0 && <p className="cfs-empty">Nothing was confirmed in this month. Pick another month or wait for the next acknowledgement.</p>}
          <table className="cfs-table">
            <thead>
              <tr><th>Trip</th><th>Route</th><th>Coverage value</th><th>CFS cost</th></tr>
            </thead>
            <tbody>
              {statement.rows.map((row) => (
                <tr key={row.id}>
                  <td className="cfs-trip-id">{row.tripId}</td>
                  <td>{row.route}</td>
                  <td className="cfs-num">{row.coverageValueLabel || money(row.coverageLimitCents)}</td>
                  <td className="cfs-num">{row.acknowledgement?.cfsCostLabel || '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={2}>Totals</th>
                <th className="cfs-num">{money(statement.coverageLimitCents)}</th>
                <th className="cfs-num">{money(statement.cfsCostCents)}</th>
              </tr>
            </tfoot>
          </table>
          <ul className="cfs-statement-cards">
            {statement.rows.map((row) => (
              <li key={row.id} className="cfs-card">
                <strong className="cfs-trip-id">{row.tripId}</strong>
                <span>{row.route}</span>
                <span className="cfs-num">Coverage value {row.coverageValueLabel || money(row.coverageLimitCents)}</span>
                <span className="cfs-num">CFS cost {row.acknowledgement?.cfsCostLabel || '—'}</span>
              </li>
            ))}
          </ul>
          <div className="cfs-totals">
            <p>Coverage value total {money(statement.coverageLimitCents)}</p>
            <p>CFS cost total {money(statement.cfsCostCents)}</p>
          </div>
          <div className="cfs-actions">
            <button type="button" className="cfs-btn cfs-btn-ghost" onClick={onCsv}>Download CSV</button>
            <button type="button" className="cfs-btn cfs-btn-primary" onClick={onPdf}>Download PDF</button>
          </div>
        </>
      )}
    </section>
  );
}

function Icon({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function MoonIcon() {
  return <Icon><path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" /></Icon>;
}
function SunIcon() {
  return <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
}
function UserIcon() {
  return <Icon><circle cx="12" cy="8" r="3.2" /><path d="M5 19.2c1.4-3 3.8-4.5 7-4.5s5.6 1.5 7 4.5" /></Icon>;
}
function ClockIcon() {
  return <Icon><circle cx="12" cy="12" r="8" /><path d="M12 8v4.5l3 2" /></Icon>;
}
function CheckIcon() {
  return <Icon><circle cx="12" cy="12" r="8" /><path d="M8.5 12.5l2.2 2.2 4.8-5" /></Icon>;
}
function ShieldIcon() {
  return <Icon><path d="M12 3l7 3v6c0 4.2-2.8 7.2-7 8.5C7.8 19.2 5 16.2 5 12V6l7-3z" /></Icon>;
}
function PlaneIcon() {
  return <Icon><path d="M3 12l18-6-6 18-2.5-7.5L3 12z" /></Icon>;
}
function ArrowIcon() {
  return <Icon><path d="M4 12h14M13 7l5 5-5 5" /></Icon>;
}
function ChevronIcon() {
  return <span className="cfs-chevron" aria-hidden="true"><Icon><path d="M9 6l6 6-6 6" /></Icon></span>;
}
function FileIcon() {
  return <Icon><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></Icon>;
}
