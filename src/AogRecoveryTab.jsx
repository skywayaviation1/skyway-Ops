// AOG Coverage — ops and admin. Lists every mechanical-recovery record,
// the rate table, and complimentary broker domains.

import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { Download, RefreshCw, Shield } from 'lucide-react';
import { auth, db } from './firebase.js';
import { Button, Card, PageHeader, StatusChip, cx } from './ui.jsx';
import {
  DEFAULT_RATES,
  coverageCsv,
  coverageLevelLabel,
  paymentStatusLabel,
  premiumLabel,
  fmtMoney,
} from './aog-recovery.js';
import { contractIsOnTrip, isUnmatchedContract } from './charter-contract.js';

const LegacyAogTab = lazy(() => import('./AogTab.jsx'));

const LEVEL_OPTIONS = ['', 'included_50', 'purchased_100', 'gifted_100', 'complimentary_100'];
const PAYMENT_OPTIONS = ['', 'not_required', 'offer_pending', 'awaiting_payment', 'paid', 'complimentary', 'gifted', 'unavailable'];

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
    offerSentAt: iso(data.offerSentAt) || data.offerSentAt || '',
    bindEmailSentAt: iso(data.bindEmailSentAt) || data.bindEmailSentAt || '',
    uncertainFields: data.uncertainFields || [],
    parserNotes: data.parserNotes || [],
  };
}

export default function AogRecoveryTab({ currentUser }) {
  const [records, setRecords] = useState([]);
  const [source, setSource] = useState('loading');
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState(null);
  const [queryText, setQueryText] = useState('');
  const [level, setLevel] = useState('');
  const [payment, setPayment] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const [rates, setRates] = useState(DEFAULT_RATES.map((row) => ({ ...row, aliases: row.aliases.join(', ') })));
  const [domains, setDomains] = useState('');
  const [banner, setBanner] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadApi() {
    const data = await authPost('/api/aog-recovery-ops', { action: 'list' });
    setRecords(data.records || []);
    setSource('api');
  }

  useEffect(() => {
    const rows = query(collection(db, 'aogRecovery'), orderBy('createdAt', 'desc'), limit(500));
    const unsub = onSnapshot(rows, (snap) => {
      setRecords(snap.docs.map(fromSnapshot));
      setSource('live');
    }, () => {
      loadApi().catch((err) => setError(err.message));
    });
    authPost('/api/aog-recovery-settings', { action: 'get' }).then((data) => {
      setSettings(data.settings);
      setStatus(data);
      setRates((data.settings?.rates || DEFAULT_RATES).map((row) => ({
        aircraftType: row.aircraftType,
        ratePercent: row.ratePercent,
        aliases: (row.aliases || []).join(', '),
      })));
      setDomains((data.settings?.complimentaryDomains || []).join('\n'));
    }).catch((err) => setError(err.message));
    return unsub;
  }, []);

  const filtered = useMemo(() => {
    const needle = queryText.trim().toLowerCase();
    return records.filter((record) => {
      if (level && record.coverageLevel !== level) return false;
      if (payment && record.paymentStatus !== payment) return false;
      if (reviewOnly && !record.needsReview && record.matchStatus === 'linked') return false;
      if (!needle) return true;
      const haystack = [record.tripId, record.brokerCompany, record.checkoutEmail, record.tail, record.aircraftType, record.route]
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [records, queryText, level, payment, reviewOnly]);

  const selected = records.find((record) => record.id === selectedId) || null;
  const unmatchedContracts = useMemo(() => records.filter(isUnmatchedContract), [records]);

  function exportCsv() {
    const blob = new Blob([coverageCsv(filtered)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'aog-coverage.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function saveSettings() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-settings', {
        action: 'save',
        rates: rates.map((row) => ({
          aircraftType: row.aircraftType,
          ratePercent: Number(row.ratePercent),
          aliases: row.aliases,
        })),
        complimentaryDomains: domains.split(/\n+/),
      });
      setSettings(data.settings);
      setBanner('Rates and complimentary domains saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    setBusy(true);
    setError('');
    try {
      const data = await authPost('/api/aog-recovery-inbox-scan', {});
      setBanner(`Scan examined ${data.examined}. Recorded ${data.recorded}. Skipped ${data.skipped}. Errors ${data.errors}.`);
      if (source === 'api') await loadApi();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function download(record, kind) {
    setError('');
    try {
      const idToken = await auth.currentUser?.getIdToken();
      const response = await fetch('/api/aog-recovery-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken, coverageId: record.id, kind }),
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

  async function attachContract(record, tripUid) {
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
      if (source === 'api') await loadApi();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action, extra) {
    setBusy(true);
    setError('');
    try {
      await authPost('/api/aog-recovery-ops', { action, coverageId: selected.id, ...extra });
      setBanner('Saved.');
      if (source === 'api') await loadApi();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-6 md:px-6">
      <PageHeader
        title="AOG Coverage"
        subtitle="Mechanical recovery coverage collected by Skyway for Charter Flight Support. Every trip includes 50%. 100% is purchased, gifted, or complimentary."
        actions={(
          <>
            <Button size="sm" variant="outline" icon={RefreshCw} loading={busy} onClick={scan}>Scan inbox</Button>
            <Button size="sm" variant="outline" icon={Download} onClick={exportCsv}>Export CSV</Button>
            <Button size="sm" variant="secondary" icon={Shield} onClick={() => setShowSettings((value) => !value)}>Rates</Button>
          </>
        )}
      />

      {status?.notifyTestMode !== false && (
        <div className="mb-4 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning">
          Email test mode is on. Offer, complimentary, and CFS bind messages go to {status?.notifyTestRecipient || 'the test recipient'} with a [TEST] subject until NOTIFY_TEST_MODE=false.
        </div>
      )}
      {banner && <p className="mb-3 text-sm text-success">{banner}</p>}
      {error && <p className="mb-3 text-sm text-danger" role="alert">{error}</p>}
      <p className="mb-4 text-2xs text-content-muted">{currentUser?.email ? `Signed in as ${currentUser.email}. ` : ''}{filtered.length} records · {source === 'live' ? 'live' : source}</p>

      {showSettings && (
        <Card className="mb-4">
          <h2 className="text-sm font-semibold">Premium rates by aircraft type</h2>
          <p className="mt-1 text-2xs text-content-muted">Percent of the signed charter trip total. Types with no row cannot be upgraded. The broker is charged this premium only.</p>
          <div className="mt-3 space-y-2">
            {rates.map((row, index) => (
              <div key={index} className="grid gap-2 md:grid-cols-[1fr_120px_1fr_auto]">
                <input aria-label="Aircraft type" value={row.aircraftType} onChange={(event) => setRates((list) => list.map((item, i) => i === index ? { ...item, aircraftType: event.target.value } : item))} className="rounded border border-edge bg-surface px-2 py-1 text-sm" />
                <input aria-label="Rate percent" value={row.ratePercent} onChange={(event) => setRates((list) => list.map((item, i) => i === index ? { ...item, ratePercent: event.target.value } : item))} className="rounded border border-edge bg-surface px-2 py-1 text-sm" />
                <input aria-label="Aliases" value={row.aliases} onChange={(event) => setRates((list) => list.map((item, i) => i === index ? { ...item, aliases: event.target.value } : item))} className="rounded border border-edge bg-surface px-2 py-1 text-sm" />
                <Button size="sm" variant="danger-outline" onClick={() => setRates((list) => list.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            ))}
          </div>
          <Button className="mt-2" size="sm" variant="ghost" onClick={() => setRates((list) => [...list, { aircraftType: '', ratePercent: '', aliases: '' }])}>Add aircraft</Button>
          <label className="mt-4 block text-sm">
            <span className="mb-1 block font-semibold">Complimentary domains</span>
            <span className="mb-1 block text-2xs text-content-muted">One broker email domain per line. Checkout from these domains is recorded as 100% complimentary.</span>
            <textarea value={domains} onChange={(event) => setDomains(event.target.value)} rows={4} className="w-full rounded border border-edge bg-surface px-2 py-1 text-sm" />
          </label>
          <Button className="mt-3" variant="primary" loading={busy} onClick={saveSettings}>Save settings</Button>
          {settings?.updatedBy && <p className="mt-2 text-2xs text-content-muted">Last saved by {settings.updatedBy} {stamp(settings.updatedAt)}</p>}
        </Card>
      )}

      {unmatchedContracts.length > 0 && (
        <Card className="mb-4">
          <h2 className="text-sm font-semibold">Unmatched contracts</h2>
          <p className="mt-1 text-2xs text-content-muted">
            These signed charter contracts are saved, but no trip matched. Attaching one puts the PDF on every leg that shares that trip id. Coverage level does not matter.
          </p>
          <div className="mt-3 space-y-3">
            {unmatchedContracts.map((record) => (
              <UnmatchedContract key={record.id} record={record} busy={busy} onAttach={(tripUid) => attachContract(record, tripUid)} />
            ))}
          </div>
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search trip, email, tail" aria-label="Search coverage" className="h-8 rounded border border-edge bg-surface px-2 text-sm" />
        <select aria-label="Coverage level" value={level} onChange={(event) => setLevel(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
          {LEVEL_OPTIONS.map((option) => <option key={option || 'all'} value={option}>{option ? coverageLevelLabel(option) : 'All levels'}</option>)}
        </select>
        <select aria-label="Payment status" value={payment} onChange={(event) => setPayment(event.target.value)} className="h-8 rounded border border-edge bg-surface px-2 text-sm">
          {PAYMENT_OPTIONS.map((option) => <option key={option || 'all'} value={option}>{option ? paymentStatusLabel(option) : 'All payments'}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-content-muted">
          <input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />
          Needs review
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-edge">
        <table className="min-w-[1100px] w-full text-left text-xs">
          <thead className="bg-surface-raised text-content-muted">
            <tr>
              {['Trip', 'Broker', 'Checkout email', 'Tail', 'Aircraft', 'Dates', 'Route', 'Trip total', 'Coverage', 'Premium', 'Payment', 'Stripe', 'Contracts', 'Offer sent', 'Bind sent'].map((heading) => (
                <th key={heading} className="px-2 py-2 font-medium">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={15} className="px-3 py-8 text-center text-content-muted">No coverage records yet. Inbox scans and gifted trips show up here.</td></tr>
            )}
            {filtered.map((record) => (
              <tr
                key={record.id}
                onClick={() => setSelectedId(record.id)}
                className={cx('cursor-pointer border-t border-edge hover:bg-surface-raised', selectedId === record.id && 'bg-accent-soft')}
              >
                <td className="px-2 py-2 font-mono">{record.tripId || '—'}</td>
                <td className="px-2 py-2">{record.brokerCompany || '—'}</td>
                <td className="px-2 py-2">{record.checkoutEmail || '—'}</td>
                <td className="px-2 py-2 font-mono">{record.tail || '—'}</td>
                <td className="px-2 py-2">{record.aircraftType || '—'}</td>
                <td className="px-2 py-2">{record.datesLabel || '—'}</td>
                <td className="px-2 py-2">{record.route || '—'}</td>
                <td className="px-2 py-2">{fmtMoney(record.tripTotal)}</td>
                <td className="px-2 py-2">{coverageLevelLabel(record.coverageLevel)}{record.needsReview ? ' · review' : ''}{record.matchStatus !== 'linked' ? ' · unmatched' : ''}{contractIsOnTrip(record.contractAttachStatus) ? ' · contract on trip' : ''}{isUnmatchedContract(record) ? ' · contract unmatched' : ''}</td>
                <td className="px-2 py-2">{premiumLabel(record)}</td>
                <td className="px-2 py-2">{paymentStatusLabel(record.paymentStatus)}</td>
                <td className="px-2 py-2 font-mono">{record.stripeReference || '—'}</td>
                <td className="px-2 py-2">
                  {record.electionContractPath && <button type="button" className="mr-2 text-accent underline" onClick={(event) => { event.stopPropagation(); download(record, 'election'); }}>Election</button>}
                  {record.charterContractPath && <button type="button" className="text-accent underline" onClick={(event) => { event.stopPropagation(); download(record, 'charter'); }}>Charter</button>}
                  {!record.electionContractPath && !record.charterContractPath && '—'}
                </td>
                <td className="px-2 py-2">{stamp(record.offerSentAt || record.coveredNoticeSentAt || record.includedNoticeSentAt)}</td>
                <td className="px-2 py-2">{stamp(record.bindEmailSentAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <Card className="mt-4">
          <h2 className="text-sm font-semibold">Review {selected.tripId || selected.id}</h2>
          {(selected.parserNotes || []).length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-warning">
              {selected.parserNotes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
          {(selected.uncertainFields || []).length > 0 && (
            <p className="mt-2 text-xs text-content-muted">Uncertain: {selected.uncertainFields.join(', ')}</p>
          )}
          <ReviewForm record={selected} busy={busy} onSave={(fields) => runAction('correct', { fields })} onLink={(tripUid) => runAction('link', { tripUid })} onResendOffer={() => runAction('resend-offer')} onResendBind={() => runAction('resend-bind')} />
        </Card>
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

function UnmatchedContract({ record, busy, onAttach }) {
  const [tripUid, setTripUid] = useState(record.contractCandidateTripUids?.[0] || record.linkedTripUid || '');
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
      {record.contractAmbiguous && <p className="text-xs text-warning">More than one trip matched. Pick the leg uid.</p>}
      {(record.contractCandidateTripUids || []).length > 0 && (
        <p className="text-2xs text-content-muted">Candidates: {record.contractCandidateTripUids.join(', ')}</p>
      )}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-2xs text-content-muted">
          Trip id or leg uid
          <input aria-label={`Attach contract ${record.tripId || record.id}`} value={tripUid} onChange={(event) => setTripUid(event.target.value)} className="mt-1 w-64 rounded border border-edge bg-surface px-2 py-1 text-xs text-content" />
        </label>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => onAttach(tripUid)}>Attach to trip</Button>
      </div>
    </div>
  );
}

function ReviewForm({ record, busy, onSave, onLink, onResendOffer, onResendBind }) {
  const [fields, setFields] = useState(() => ({
    tripId: record.tripId || '',
    brokerCompany: record.brokerCompany || '',
    checkoutEmail: record.checkoutEmail || '',
    tail: record.tail || '',
    aircraftType: record.aircraftType || '',
    routeFrom: record.routeFrom || '',
    routeTo: record.routeTo || '',
    departDate: record.departDate || '',
    returnDate: record.returnDate || '',
    tripTotal: record.tripTotal ?? '',
  }));
  const [tripUid, setTripUid] = useState(record.linkedTripUid || '');
  useEffect(() => {
    setFields({
      tripId: record.tripId || '',
      brokerCompany: record.brokerCompany || '',
      checkoutEmail: record.checkoutEmail || '',
      tail: record.tail || '',
      aircraftType: record.aircraftType || '',
      routeFrom: record.routeFrom || '',
      routeTo: record.routeTo || '',
      departDate: record.departDate || '',
      returnDate: record.returnDate || '',
      tripTotal: record.tripTotal ?? '',
    });
    setTripUid(record.linkedTripUid || '');
  }, [record.id, record.linkedTripUid, record.tripId, record.brokerCompany, record.checkoutEmail, record.tail, record.aircraftType, record.routeFrom, record.routeTo, record.departDate, record.returnDate, record.tripTotal]);

  const locked = record.paymentStatus === 'paid' || record.coverageLevel === 'purchased_100';
  const set = (key) => (event) => setFields((current) => ({ ...current, [key]: event.target.value }));

  return (
    <div className="mt-3 grid gap-3">
      <div className="grid gap-2 md:grid-cols-3">
        {[['tripId', 'Trip ID'], ['brokerCompany', 'Broker/company'], ['checkoutEmail', 'Checkout email'], ['tail', 'Tail'], ['aircraftType', 'Aircraft'], ['routeFrom', 'From'], ['routeTo', 'To'], ['departDate', 'Depart'], ['returnDate', 'Return'], ['tripTotal', 'Trip total']].map(([key, label]) => (
          <label key={key} className="text-2xs text-content-muted">
            {label}
            <input aria-label={label} value={fields[key]} onChange={set(key)} disabled={locked} className="mt-1 w-full rounded border border-edge bg-surface px-2 py-1 text-xs text-content disabled:opacity-60" />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={locked} onClick={() => onSave(fields)}>Save corrections</Button>
        <Button size="sm" variant="outline" loading={busy} disabled={!record.upgradeAvailable} onClick={onResendOffer}>Resend offer</Button>
        <Button size="sm" variant="outline" loading={busy} disabled={!['purchased_100', 'gifted_100', 'complimentary_100'].includes(record.coverageLevel)} onClick={onResendBind}>Resend CFS bind</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs text-content-muted">
          Link trip uid
          <input aria-label="Link trip uid" value={tripUid} onChange={(event) => setTripUid(event.target.value)} className="mt-1 w-64 rounded border border-edge bg-surface px-2 py-1 text-xs text-content" />
        </label>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => onLink(tripUid)}>Link trip</Button>
        <span className="text-2xs text-content-muted">{record.matchStatus === 'linked' ? `Linked ${record.linkedTripUid}` : 'Unmatched'}. Linking also attaches the charter contract when the PDF is on file.</span>
      </div>
    </div>
  );
}
