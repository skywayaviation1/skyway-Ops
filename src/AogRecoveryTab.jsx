// AOG Coverage for ops and admin. One row per trip id from the schedule,
// with coverage overlaid. Writes go through the Admin SDK routes.

import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { Download, RefreshCw } from 'lucide-react';
import { auth, db } from './firebase.js';
import { Button, Card, PageHeader, cx } from './ui.jsx';
import {
  DEFAULT_RATES,
  classifyCheckout,
  coverageLevelLabel,
  paymentStatusLabel,
  premiumLabel,
} from './aog-recovery.js';
import { isUnmatchedContract } from './charter-contract.js';
import { planBrokerBackfill } from './broker-backfill.js';
import { normalizeTripId } from './trip-id.js';
import {
  TRIP_PAGE_SIZE,
  buildTripRows,
  distinctValues,
  filterTripRows,
  legsFromScheduleTrips,
  mergeScheduleLegs,
  moneyOrDash,
  pageOfRows,
  tripRowCsv,
} from './aog-trip-rows.js';

const LegacyAogTab = lazy(() => import('./AogTab.jsx'));

const LEVEL_OPTIONS = ['', 'included_50', 'purchased_100', 'gifted_100', 'complimentary_100'];
const PAYMENT_OPTIONS = ['', 'not_required', 'offer_pending', 'awaiting_payment', 'paid', 'complimentary', 'gifted', 'unavailable', 'refunded'];
const HUNDRED = new Set(['purchased_100', 'gifted_100', 'complimentary_100']);

async function authPost(url, body) {
  const idToken = await auth.currentUser?.getIdToken();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fromSnapshot(docSnap) {
  const data = docSnap.data() || {};
  const iso = (value) => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value.toDate) return value.toDate().toISOString();
    return '';
  };
  return {
    id: docSnap.id,
    ...data,
    createdAt: iso(data.createdAt) || data.createdAt || '',
    updatedAt: iso(data.updatedAt) || data.updatedAt || '',
    offerSentAt: iso(data.offerSentAt) || data.offerSentAt || '',
    bindEmailSentAt: iso(data.bindEmailSentAt) || data.bindEmailSentAt || '',
    coveredNoticeSentAt: iso(data.coveredNoticeSentAt) || data.coveredNoticeSentAt || '',
    includedNoticeSentAt: iso(data.includedNoticeSentAt) || data.includedNoticeSentAt || '',
    uncertainFields: data.uncertainFields || [],
    parserNotes: data.parserNotes || [],
  };
}

async function readPdfFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  let text = '';
  try {
    const pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    text = pages.join('\n');
  } catch {
    text = '';
  }
  return { pdfBase64: btoa(binary), text, filename: file.name || 'charter-contract.pdf' };
}

function proposalText(plan) {
  if (!plan) return '';
  if (plan.coverageLevel === 'complimentary_100') {
    return 'Save records 100% complimentary, emails the broker that they are covered, and sends the CFS bind.';
  }
  if (plan.upgradeAvailable) {
    return `Save keeps 50% included and emails the 100% offer (${premiumLabel({ premium: plan.premium, coverageLevel: 'included_50' })}).`;
  }
  return 'Save keeps 50% included. 100% is not offered for this aircraft or trip total.';
}

export default function AogRecoveryTab({ currentUser, scheduleTrips = [] }) {
  const [records, setRecords] = useState([]);
  const [serverLegs, setServerLegs] = useState([]);
  const [scheduleNote, setScheduleNote] = useState('');
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [search, setSearch] = useState('');
  const [windowName, setWindowName] = useState('current');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [contract, setContract] = useState('');
  const [level, setLevel] = useState('');
  const [payment, setPayment] = useState('');
  const [aircraft, setAircraft] = useState('');
  const [broker, setBroker] = useState('');
  const [page, setPage] = useState(0);
  const [panel, setPanel] = useState('trips');
  const [selectedKey, setSelectedKey] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const [banner, setBanner] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadSchedule() {
    const data = await authPost('/api/aog-recovery-ops', { action: 'schedule' });
    setServerLegs(data.legs || []);
    setScheduleNote(data.truncated ? 'Schedule list is capped at 2000 legs.' : '');
  }

  useEffect(() => {
    const rows = query(collection(db, 'aogRecovery'), orderBy('createdAt', 'desc'), limit(500));
    const unsub = onSnapshot(rows, (snap) => {
      setRecords(snap.docs.map(fromSnapshot));
    }, () => {
      authPost('/api/aog-recovery-ops', { action: 'list' })
        .then((data) => setRecords(data.records || []))
        .catch((err) => setError(err.message));
    });
    authPost('/api/aog-recovery-settings', { action: 'get' })
      .then((data) => {
        setSettings(data.settings);
        setStatus(data);
      })
      .catch((err) => setError(err.message));
    loadSchedule().catch((err) => setError(err.message));
    return unsub;
  }, []);

  const legs = useMemo(
    () => mergeScheduleLegs(legsFromScheduleTrips(scheduleTrips), serverLegs),
    [scheduleTrips, serverLegs],
  );
  const tripRows = useMemo(() => buildTripRows(legs, records), [legs, records]);
  const filtered = useMemo(() => filterTripRows(tripRows, {
    search, window: windowName, from, to, contract, level, payment, aircraft, broker, now: new Date(),
  }), [tripRows, search, windowName, from, to, contract, level, payment, aircraft, broker]);
  const paged = pageOfRows(filtered, page);
  const selected = tripRows.find((row) => row.groupKey === selectedKey) || null;
  const unmatched = useMemo(() => records.filter(isUnmatchedContract), [records]);
  const aircraftOptions = distinctValues(tripRows, 'aircraft');
  const brokerOptions = distinctValues(tripRows, 'brokerCompany');

  useEffect(() => { setPage(0); }, [search, windowName, from, to, contract, level, payment, aircraft, broker]);

  function exportCsv() {
    const blob = new Blob([tripRowCsv(filtered)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'aog-coverage.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function scan() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-inbox-scan', {});
      setBanner(`Scan examined ${data.examined}. Recorded ${data.recorded}. Skipped ${data.skipped}. Errors ${data.errors}.`);
      await loadSchedule();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function attachUnmatched(record, tripUid) {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-ops', {
        action: 'attach-contract',
        coverageId: record.id,
        tripUid,
      });
      const count = data.contractLegIds?.length || 0;
      setBanner(`Charter contract attached to ${count} leg${count === 1 ? '' : 's'}.`);
      await loadSchedule();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const rangeLabel = paged.total === 0
    ? '0 trips'
    : `${paged.start + 1}–${paged.start + paged.rows.length} of ${paged.total} trips`;

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-6 md:px-6">
      <PageHeader
        title="AOG Coverage"
        subtitle="Every trip includes 50% mechanical recovery. 100% is purchased, gifted, or complimentary. This list is the schedule, one row per trip."
        actions={(
          <>
            <Button size="sm" variant="outline" icon={RefreshCw} loading={busy} onClick={scan}>Scan inbox</Button>
            <Button size="sm" variant="outline" icon={Download} onClick={exportCsv}>Export CSV</Button>
          </>
        )}
      />

      {status?.notifyTestMode !== false && (
        <div className="mb-4 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">
          Email test mode is on. Offer, complimentary, and CFS bind messages go to {status?.notifyTestRecipient || 'jake@flyskyway.com'} with a [TEST] subject until NOTIFY_TEST_MODE=false.
        </div>
      )}
      {banner && <p className="mb-3 text-sm text-success">{banner}</p>}
      {error && <p className="mb-3 text-sm text-danger" role="alert">{error}</p>}
      <p className="mb-3 text-2xs text-content-muted">
        {currentUser?.email ? `Signed in as ${currentUser.email}. ` : ''}
        {rangeLabel}
        {scheduleNote ? ` ${scheduleNote}` : ''}
      </p>

      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="AOG Coverage sections">
        {[['trips', 'Trips'], ['unmatched', `Unmatched contracts (${unmatched.length})`], ['settings', 'Settings']].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={panel === id}
            onClick={() => setPanel(id)}
            className={cx(
              'rounded-full border px-3 py-1 text-sm',
              panel === id ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-content-muted',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {panel === 'settings' && (
        <SettingsPanel
          settings={settings}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          setBanner={setBanner}
          onSettings={setSettings}
          tripRows={tripRows}
        />
      )}

      {panel === 'unmatched' && (
        <Card>
          <h2 className="text-sm font-semibold">Unmatched contracts</h2>
          <p className="mt-1 text-2xs text-content-muted">
            Signed charter contracts from the inbox that did not match a trip. Pick the trip and the PDF is attached to every leg that shares that trip id.
          </p>
          {unmatched.length === 0 && <p className="mt-3 text-sm text-content-muted">No unmatched contracts.</p>}
          <div className="mt-3 space-y-3">
            {unmatched.map((record) => (
              <UnmatchedContract
                key={record.id}
                record={record}
                trips={tripRows}
                busy={busy}
                onAttach={(tripUid) => attachUnmatched(record, tripUid)}
              />
            ))}
          </div>
        </Card>
      )}

      {panel === 'trips' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search trip ID, broker, tail" aria-label="Search trips" className="h-8 rounded border border-edge bg-surface px-2 text-sm" />
            <select aria-label="Trip window" value={windowName} onChange={(event) => setWindowName(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
              <option value="current">Upcoming and recent</option>
              <option value="upcoming">Upcoming</option>
              <option value="past">Past</option>
              <option value="range">Date range</option>
              <option value="all">All trips</option>
            </select>
            {windowName === 'range' && (
              <>
                <input type="date" aria-label="From date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm" />
                <input type="date" aria-label="To date" value={to} onChange={(event) => setTo(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm" />
              </>
            )}
            <select aria-label="Contract" value={contract} onChange={(event) => setContract(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
              <option value="">All contracts</option>
              <option value="missing">Contract missing</option>
              <option value="attached">Contract attached</option>
            </select>
            <select aria-label="Coverage level" value={level} onChange={(event) => setLevel(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
              {LEVEL_OPTIONS.map((option) => <option key={option || 'all'} value={option}>{option ? coverageLevelLabel(option) : 'All levels'}</option>)}
            </select>
            <select aria-label="Payment status" value={payment} onChange={(event) => setPayment(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
              {PAYMENT_OPTIONS.map((option) => <option key={option || 'all'} value={option}>{option ? paymentStatusLabel(option) : 'All payments'}</option>)}
            </select>
            <select aria-label="Aircraft" value={aircraft} onChange={(event) => setAircraft(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
              <option value="">All aircraft</option>
              {aircraftOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <select aria-label="Broker" value={broker} onChange={(event) => setBroker(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
              <option value="">All brokers</option>
              {brokerOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>

          <div className="overflow-x-auto rounded-xl border border-edge">
            <table className="min-w-[1200px] w-full text-left text-xs">
              <thead className="bg-surface-raised text-content-muted">
                <tr>
                  {['Trip ID', 'Dates', 'Route', 'Tail', 'Aircraft', 'Broker', 'Contract', 'Trip total', 'Coverage', 'Premium', 'Payment', 'Offer sent', 'Bound to CFS'].map((heading) => (
                    <th key={heading} className="px-2 py-2 font-medium">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.rows.length === 0 && (
                  <tr><td colSpan={13} className="px-3 py-8 text-center text-content-muted">No trips in this view.</td></tr>
                )}
                {paged.rows.map((row) => (
                  <tr
                    key={row.groupKey}
                    onClick={() => setSelectedKey(row.groupKey)}
                    className={cx('cursor-pointer border-t border-edge hover:bg-surface-raised', selectedKey === row.groupKey && 'bg-accent-soft')}
                  >
                    <td className="px-2 py-2 font-mono">
                      {row.tripId || '—'}
                      {row.legCount > 1 && <div className="text-2xs text-content-muted">{row.legCount} legs</div>}
                    </td>
                    <td className="px-2 py-2">{row.datesLabel || '—'}</td>
                    <td className="px-2 py-2">{row.route || '—'}</td>
                    <td className="px-2 py-2 font-mono">{row.tail || '—'}</td>
                    <td className="px-2 py-2">{row.aircraft || '—'}</td>
                    <td className="px-2 py-2">
                      <div>{row.brokerCompany || '—'}</div>
                      <div className="text-content-muted">{row.brokerEmail || '—'}</div>
                    </td>
                    <td className="px-2 py-2">{row.contractStatus === 'attached' ? 'attached' : 'missing'}</td>
                    <td className="px-2 py-2">{moneyOrDash(row.tripTotal)}</td>
                    <td className="px-2 py-2">{coverageLevelLabel(row.coverageLevel)}{row.needsReview ? ' · review' : ''}</td>
                    <td className="px-2 py-2">{premiumLabel({ coverageLevel: row.coverageLevel, premium: row.premium })}</td>
                    <td className="px-2 py-2">{paymentStatusLabel(row.paymentStatus)}</td>
                    <td className="px-2 py-2">{stamp(row.offerSentAt)}</td>
                    <td className="px-2 py-2">{stamp(row.bindEmailSentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {paged.pages > 1 && (
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={paged.page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous page</Button>
              <span className="text-xs text-content-muted">Page {paged.page + 1} of {paged.pages}</span>
              <Button size="sm" variant="outline" disabled={paged.page >= paged.pages - 1} onClick={() => setPage((value) => value + 1)}>Next page</Button>
            </div>
          )}

          {selected && (
            <TripDrawer
              row={selected}
              settings={settings}
              busy={busy}
              setBusy={setBusy}
              setError={setError}
              setBanner={setBanner}
              onClose={() => setSelectedKey('')}
              onSaved={loadSchedule}
            />
          )}
        </>
      )}

      <button type="button" className="mt-6 text-xs text-content-muted underline" onClick={() => setShowLegacy((value) => !value)}>
        {showLegacy ? 'Hide earlier accept/decline log' : 'Earlier accept/decline log'}
      </button>
      {showLegacy && (
        <Suspense fallback={<p className="mt-3 text-sm text-content-muted">Loading earlier log…</p>}>
          <LegacyAogTab currentUser={currentUser} />
        </Suspense>
      )}
    </div>
  );
}

function TripDrawer({ row, settings, busy, setBusy, setError, setBanner, onClose, onSaved }) {
  const [events, setEvents] = useState([]);
  const [review, setReview] = useState(null);
  const [pdfFile, setPdfFile] = useState(null);
  const [giftArmed, setGiftArmed] = useState(false);
  const [tripBroker, setTripBroker] = useState(null);
  const view = useMemo(() => ({
    ...row,
    tripId: row.tripId || tripBroker?.tripId || '',
    brokerCompany: row.brokerCompany || tripBroker?.brokerCompany || '',
    brokerEmail: row.brokerEmail || tripBroker?.brokerEmail || '',
    brokerPhone: row.brokerPhone || tripBroker?.brokerPhone || '',
    aircraft: row.aircraft || tripBroker?.aircraft || '',
  }), [row, tripBroker]);
  const [fields, setFields] = useState(() => fieldState(row, null));
  const locked = row.paymentStatus === 'paid' || row.coverageLevel === 'purchased_100';

  useEffect(() => {
    let cancelled = false;
    setTripBroker(null);
    (async () => {
      const { doc, getDoc } = await import('firebase/firestore');
      for (const uid of row.legUids || []) {
        try {
          const snap = await getDoc(doc(db, 'trip-state', uid));
          if (cancelled || !snap.exists()) continue;
          const data = snap.data() || {};
          const sheet = data.tripSheetData || {};
          const next = {
            tripId: normalizeTripId(sheet.tripCode),
            brokerCompany: data.brokerCompany || sheet.client || '',
            brokerEmail: data.brokerEmail || '',
            brokerPhone: data.brokerPhone || '',
            aircraft: sheet.aircraftType || '',
          };
          if (next.tripId || next.brokerEmail || next.brokerCompany || next.aircraft) {
            setTripBroker(next);
            break;
          }
        } catch {
          /* The schedule row is enough when trip-state cannot be read. */
        }
      }
    })();
    return () => { cancelled = true; };
  }, [row.groupKey]);

  useEffect(() => {
    setFields(fieldState(view, review));
    setGiftArmed(false);
  }, [view, review]);

  useEffect(() => {
    if (!row.coverageId) {
      setEvents([]);
      return undefined;
    }
    let cancelled = false;
    authPost('/api/aog-recovery-ops', { action: 'events', coverageId: row.coverageId })
      .then((data) => { if (!cancelled) setEvents(data.events || []); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [row.coverageId, row.offerSentAt, row.bindEmailSentAt, setError]);

  async function onFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const packed = await readPdfFile(file);
      const data = await authPost('/api/aog-recovery-ops', {
        action: 'preview-contract',
        pdfBase64: packed.pdfBase64,
        filename: packed.filename,
        text: packed.text,
        tripId: row.tripId,
      });
      setPdfFile(packed);
      setReview(data);
      setBanner('Review the parsed contract, then save.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveContract() {
    if (!pdfFile) return;
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-ops', {
        action: 'save-contract',
        pdfBase64: pdfFile.pdfBase64,
        filename: pdfFile.filename,
        tripId: row.tripId,
        legUids: row.legUids,
        fields,
      });
      const mail = data.emailError ? ` Mail: ${data.emailError}` : '';
      setBanner(data.contractOnly ? `Contract replaced.${mail}` : `Contract saved.${mail}`);
      setReview(null);
      setPdfFile(null);
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    if (!row.coverageId) {
      setError('Upload the charter contract before correcting a coverage record.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await authPost('/api/aog-recovery-ops', {
        action: 'correct',
        coverageId: row.coverageId,
        fields: {
          tripTotal: fields.tripTotal,
          checkoutEmail: fields.checkoutEmail,
          brokerCompany: fields.brokerCompany,
          aircraftType: fields.aircraftType,
          tail: fields.tail,
          routeFrom: fields.routeFrom,
          routeTo: fields.routeTo,
          departDate: fields.departDate,
          returnDate: fields.returnDate,
          tripId: fields.tripId,
        },
      });
      setBanner('Corrections saved.');
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function resendOffer() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-ops', { action: 'resend-offer', coverageId: row.coverageId });
      setBanner(data.error ? `Offer resend: ${data.error}` : 'Offer resent.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function gift() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-gift', {
        tripUid: row.legUids[0] || row.tripId,
        tripId: row.tripId,
        tail: row.tail,
        aircraftType: row.aircraft,
        routeFrom: row.routeFrom,
        routeTo: row.routeTo,
        departDate: row.departDay,
        returnDate: row.returnDay,
        tripTotal: row.tripTotal,
        brokerCompany: row.brokerCompany,
        brokerEmail: row.brokerEmail,
        checkoutEmail: row.brokerEmail,
      });
      setBanner(data.emailError ? `Gifted 100%. Bind email: ${data.emailError}` : 'Gifted 100%. CFS bind sent.');
      setGiftArmed(false);
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(kind) {
    setError('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/aog-recovery-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, coverageId: row.coverageId, kind }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Download failed');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
    }
  }

  const plan = classifyCheckout({
    checkoutEmail: fields.checkoutEmail,
    aircraftType: fields.aircraftType,
    tripTotal: fields.tripTotal,
  }, { rates: settings?.rates, complimentaryDomains: settings?.complimentaryDomains });
  const brokerPlan = review?.parsed
    ? planBrokerBackfill(view, {
      brokerCompany: review.parsed.brokerCompany,
      brokerEmail: review.parsed.checkoutEmail,
      brokerPhone: review.parsed.brokerPhone,
    })
    : null;

  const sheet = (
    <div className="sw-sheet justify-end bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-label={`Trip ${view.tripId || 'unassigned'}`}
        className="sw-sheet-panel sw-sheet-fill ml-auto w-full max-w-xl border-l border-edge shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-edge bg-surface px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{view.tripId || 'No trip ID'}</h2>
            <p className="text-xs text-content-muted">{row.datesLabel || 'Dates unknown'} · {row.route || 'Route unknown'} · {row.legCount} leg{row.legCount === 1 ? '' : 's'}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="sw-sheet-body px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex">
            <input type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Charter contract PDF" onChange={onFile} />
            <span className="inline-flex cursor-pointer items-center rounded border border-edge px-2 py-1 text-xs font-semibold">{row.contractStatus === 'attached' ? 'Replace contract' : 'Upload contract'}</span>
          </label>
          {row.charterContractPath && <Button size="sm" variant="outline" onClick={() => download('charter')}>View charter</Button>}
          {row.electionContractPath && <Button size="sm" variant="outline" onClick={() => download('election')}>View election</Button>}
          <Button size="sm" variant="outline" disabled={!row.upgradeAvailable} onClick={resendOffer}>Resend offer</Button>
          {!HUNDRED.has(row.coverageLevel) && !giftArmed && (
            <Button size="sm" variant="secondary" onClick={() => setGiftArmed(true)}>Gift 100%</Button>
          )}
          {giftArmed && <Button size="sm" variant="primary" loading={busy} onClick={gift}>Confirm gift</Button>}
        </div>

        {review && (
          <p className="mt-3 text-xs text-content-muted">{proposalText(plan)}</p>
        )}
        {(review?.parsed?.notes || []).map((note) => <p key={note} className="mt-1 text-xs text-warning">{note}</p>)}
        {uncertainLeft(fields).length > 0 && (
          <p className="mt-1 text-xs text-content-muted">Uncertain: {uncertainLeft(fields).join(', ')}</p>
        )}

        <FieldGrid fields={fields} setFields={setFields} disabled={locked && !review} />
        {brokerPlan?.filled?.length > 0 && (
          <p className="mt-2 text-xs text-success">Broker details from this contract will be saved onto the trip.</p>
        )}
        {brokerPlan?.mismatches?.length > 0 && (
          <div role="status" className="mt-2 rounded border border-warning-border bg-warning-soft p-2 text-xs text-warning">
            <p>Broker on the trip does not match this contract. Existing broker details stay on the trip.</p>
            <ul className="mt-1 space-y-1">
              {brokerPlan.mismatches.map((item) => (
                <li key={item.field}>{item.field}: trip has {item.existing}; contract has {item.parsed}</li>
              ))}
            </ul>
          </div>
        )}

        {locked && <p className="mt-2 text-2xs text-content-muted">Paid coverage keeps its premium. Replacing the PDF does not change the amount that was charged.</p>}

        <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-content-muted">Event history</h3>
        {events.length === 0 && <p className="mt-1 text-xs text-content-muted">No events yet.</p>}
        <ul className="mt-2 space-y-1">
          {events.map((event) => (
            <li key={event.id} className="text-xs">
              <span className="font-medium">{event.type}</span>
              <span className="text-content-muted"> · {stamp(event.at)}{event.actor ? ` · ${event.actor}` : ''}</span>
              {event.detail && <div className="text-content-muted">{event.detail}</div>}
            </li>
          ))}
        </ul>
        <p className="pt-6 text-2xs text-content-subtle">End of trip details</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-edge bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {review && <Button size="sm" variant="primary" loading={busy} onClick={saveContract}>Save contract</Button>}
          {review && <Button size="sm" variant="ghost" onClick={() => { setReview(null); setPdfFile(null); }}>Cancel upload</Button>}
          {row.coverageId && <Button size="sm" variant="outline" loading={busy} disabled={locked} onClick={correct}>Save corrections</Button>}
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}

function uncertainLeft(fields) {
  const blank = {
    tripId: !fields.tripId,
    tail: !fields.tail,
    aircraftType: !fields.aircraftType,
    route: !(fields.routeFrom || fields.routeTo),
    dates: !fields.departDate,
    tripTotal: fields.tripTotal === '' || fields.tripTotal == null,
    checkoutEmail: !fields.checkoutEmail,
  };
  return (fields.uncertainFields || []).filter((field) => blank[field]);
}

function fieldState(row, review) {
  const parsed = review?.parsed || {};
  const pick = (parsedValue, rowValue) => (parsedValue || parsedValue === 0 ? parsedValue : (rowValue ?? ''));
  const keepTrip = (rowValue, parsedValue) => (rowValue ? rowValue : (parsedValue || ''));
  return {
    tripId: normalizeTripId(parsed.tripId) || normalizeTripId(row.tripId) || '',
    brokerCompany: keepTrip(row.brokerCompany, parsed.brokerCompany),
    checkoutEmail: keepTrip(row.brokerEmail, parsed.checkoutEmail),
    brokerPhone: keepTrip(row.brokerPhone, parsed.brokerPhone),
    tail: pick(parsed.tail, row.tail),
    aircraftType: pick(parsed.aircraftType, row.aircraft),
    routeFrom: pick(parsed.routeFrom, row.routeFrom),
    routeTo: pick(parsed.routeTo, row.routeTo),
    departDate: pick(parsed.departDate, row.departDay),
    returnDate: pick(parsed.returnDate, row.returnDay),
    tripTotal: parsed.tripTotal != null ? parsed.tripTotal : (row.tripTotal ?? ''),
    uncertainFields: parsed.uncertainFields || row.uncertainFields || [],
  };
}

function FieldGrid({ fields, setFields, disabled }) {
  const set = (key) => (event) => setFields((current) => ({ ...current, [key]: event.target.value }));
  const inputs = [
    ['tripId', 'Trip ID'],
    ['brokerCompany', 'Broker company'],
    ['checkoutEmail', 'Broker email'],
    ['brokerPhone', 'Broker phone'],
    ['tail', 'Tail'],
    ['aircraftType', 'Aircraft'],
    ['routeFrom', 'From'],
    ['routeTo', 'To'],
    ['departDate', 'Depart'],
    ['returnDate', 'Return'],
    ['tripTotal', 'Trip total'],
  ];
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {inputs.map(([key, label]) => (
        <label key={key} className="text-2xs text-content-muted">
          {label}
          <input aria-label={label} value={fields[key]} onChange={set(key)} disabled={disabled} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-xs text-content disabled:opacity-60" />
        </label>
      ))}
    </div>
  );
}

function UnmatchedContract({ record, trips, busy, onAttach }) {
  const options = trips.filter((row) => row.tripId && !String(row.groupKey).startsWith('leg:'));
  const [tripId, setTripId] = useState('');
  const [manualUid, setManualUid] = useState('');
  const source = record.contractSource || {};
  return (
    <div className="rounded-lg border border-edge px-3 py-2">
      <p className="text-sm font-medium">{record.tripId || 'No trip id'} · {record.tail || 'no tail'} · {record.route || 'no route'}</p>
      <p className="text-xs text-content-muted">{record.datesLabel || 'Dates unknown'} · {record.charterContractFilename || 'charter-contract.pdf'}</p>
      <p className="text-xs text-content-muted">
        From {source.sender || 'unknown sender'}
        {source.receivedAt ? ` · received ${stamp(source.receivedAt)}` : ''}
        {source.messageId ? ` · message ${source.messageId}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-2xs text-content-muted">
          Trip
          <select aria-label={`Trip for ${record.tripId || record.id}`} value={tripId} onChange={(event) => setTripId(event.target.value)} className="mt-1 block w-72 rounded border border-edge bg-surface px-2 py-1 text-xs text-content">
            <option value="">Choose a trip</option>
            {options.map((row) => (
              <option key={row.groupKey} value={row.tripId}>{row.tripId} · {row.route || 'no route'} · {row.datesLabel || 'no dates'}</option>
            ))}
          </select>
        </label>
        <label className="text-2xs text-content-muted">
          Or leg uid
          <input aria-label={`Leg uid for ${record.tripId || record.id}`} value={manualUid} onChange={(event) => setManualUid(event.target.value)} className="mt-1 w-48 rounded border border-edge bg-surface px-2 py-1 text-xs text-content" />
        </label>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => onAttach(tripId || manualUid)}>Attach to trip</Button>
      </div>
    </div>
  );
}

function SettingsPanel({ settings, busy, setBusy, setError, setBanner, onSettings, tripRows }) {
  const [rates, setRates] = useState(() => rateDraft(settings));
  const [domain, setDomain] = useState('');
  const [pending, setPending] = useState(null);
  const [picked, setPicked] = useState({});

  useEffect(() => { setRates(rateDraft(settings)); }, [settings]);

  async function saveRates() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-settings', {
        action: 'save-rates',
        rates: rates.map((row) => ({
          aircraftType: row.aircraftType,
          ratePercent: Number(row.ratePercent),
          aliases: row.aliases,
        })),
      });
      onSettings(data.settings);
      setBanner('Aircraft rates saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addDomain() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-settings', { action: 'add-domain', domain });
      onSettings(data.settings);
      setDomain('');
      const candidates = data.candidates || [];
      if (candidates.length) {
        const next = {};
        candidates.forEach((row) => { next[row.tripId] = true; });
        setPicked(next);
        setPending({ domain: data.domain, candidates });
        setBanner(`${data.domain} is on the complimentary list. ${candidates.length} upcoming trip${candidates.length === 1 ? '' : 's'} can move to 100%.`);
      } else {
        setPending(null);
        setBanner(`${data.domain} added. No upcoming trips on that domain are still below 100%.`);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeDomain(value) {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-settings', { action: 'remove-domain', domain: value });
      onSettings(data.settings);
      setBanner(`Removed ${value}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyDomain() {
    if (!pending) return;
    const tripIds = pending.candidates.filter((row) => picked[row.tripId]).map((row) => row.tripId);
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-settings', {
        action: 'apply-domain',
        domain: pending.domain,
        tripIds,
      });
      onSettings(data.settings);
      const problems = (data.applied || []).map((row) => row.emailError).filter(Boolean);
      setBanner(`Complimentary 100% applied to ${(data.applied || []).length} trip${(data.applied || []).length === 1 ? '' : 's'}.${problems[0] ? ` Mail: ${problems[0]}` : ''}`);
      setPending(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const records = settings?.domainRecords || [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h2 className="text-sm font-semibold">Premium rates by aircraft type</h2>
        <p className="mt-1 text-2xs text-content-muted">Percent of the signed charter trip total. Citation CJ3 starts at 1.5% and Learjet 60 at 2%. Types with no row cannot be upgraded. The broker is charged this premium only.</p>
        <div className="mt-3 space-y-2">
          {rates.map((row, index) => (
            <div key={`${row.aircraftType}-${index}`} className="grid gap-2 md:grid-cols-[1fr_120px_1fr_auto]">
              <input aria-label="Aircraft type" value={row.aircraftType} onChange={(event) => setRates((list) => list.map((item, i) => i === index ? { ...item, aircraftType: event.target.value } : item))} className="rounded border border-edge bg-surface px-2 py-1 text-sm" />
              <input aria-label={`Rate percent ${row.aircraftType || index}`} value={row.ratePercent} onChange={(event) => setRates((list) => list.map((item, i) => i === index ? { ...item, ratePercent: event.target.value } : item))} className="rounded border border-edge bg-surface px-2 py-1 text-sm" />
              <input aria-label="Aliases" value={row.aliases} onChange={(event) => setRates((list) => list.map((item, i) => i === index ? { ...item, aliases: event.target.value } : item))} className="rounded border border-edge bg-surface px-2 py-1 text-sm" />
              <Button size="sm" variant="danger-outline" onClick={() => setRates((list) => list.filter((_, i) => i !== index))}>Remove</Button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => setRates((list) => [...list, { aircraftType: '', ratePercent: '', aliases: '' }])}>Add aircraft</Button>
          <Button size="sm" variant="primary" loading={busy} onClick={saveRates}>Save rates</Button>
        </div>
        {settings?.updatedBy && <p className="mt-2 text-2xs text-content-muted">Last saved by {settings.updatedBy} {stamp(settings.updatedAt)}</p>}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">Complimentary 100% domains</h2>
        <p className="mt-1 text-2xs text-content-muted">Broker email domains that receive 100% coverage without a card charge. Adding a domain offers to apply it to that domain&apos;s upcoming trips that are not yet at 100%.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-2xs text-content-muted">
            Domain
            <input aria-label="Complimentary domain" value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example-charter.test" className="mt-1 w-64 rounded border border-edge bg-surface px-2 py-1 text-sm text-content" />
          </label>
          <Button size="sm" variant="primary" loading={busy} onClick={addDomain}>Add domain</Button>
        </div>
        <ul className="mt-3 space-y-2">
          {records.length === 0 && <li className="text-xs text-content-muted">No complimentary domains yet.</li>}
          {records.map((row) => (
            <li key={row.domain} className="flex flex-wrap items-center justify-between gap-2 rounded border border-edge px-2 py-1">
              <span className="text-sm">{row.domain}</span>
              <span className="text-2xs text-content-muted">{row.addedBy || 'unknown'} · {row.addedAt ? stamp(row.addedAt) : 'time not recorded'}</span>
              <Button size="sm" variant="danger-outline" onClick={() => removeDomain(row.domain)}>Remove</Button>
            </li>
          ))}
        </ul>
        {pending && (
          <div className="mt-4 rounded border border-edge p-3">
            <p className="text-sm font-medium">Apply {pending.domain} to upcoming trips?</p>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
              {pending.candidates.map((row) => (
                <li key={row.tripId}>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`Apply to ${row.tripId}`}
                      checked={picked[row.tripId] !== false}
                      onChange={(event) => setPicked((current) => ({ ...current, [row.tripId]: event.target.checked }))}
                    />
                    <span>{row.tripId} · {row.brokerEmail} · {row.datesLabel} · {coverageLevelLabel(row.coverageLevel)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" loading={busy} onClick={applyDomain}>Apply complimentary 100%</Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>Don&apos;t apply</Button>
            </div>
          </div>
        )}
        <p className="mt-3 text-2xs text-content-muted">{tripRows.length} trips loaded for this offer.</p>
      </Card>
    </div>
  );
}

function rateDraft(settings) {
  const rows = settings?.rates?.length ? settings.rates : DEFAULT_RATES;
  return rows.map((row) => ({
    aircraftType: row.aircraftType,
    ratePercent: row.ratePercent,
    aliases: Array.isArray(row.aliases) ? row.aliases.join(', ') : (row.aliases || ''),
  }));
}
