// src/AogTab.jsx
//
// AOG Coverage tab — ops + admin only. Gate with your existing role
// check when placing this tab in the app:
//
//   {isAdminOrOps && <AogTab currentUser={currentUser} />}
//
// This component handles:
//   - Manual invoice upload for eligible tails (CJ3s + LR60)
//   - Trip total entry with live coverage cost calculation
//   - "Send offer" button → emails broker with Accept/Decline links
//   - Table of all tracked coverage records with status
//   - Monthly rollup for CFS reconciliation (accepted totals)
//   - Config panel for CFS + ops notification recipients

import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, orderBy, onSnapshot, addDoc, doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, getStorage } from 'firebase/storage';
import { db } from './firebase.js';

// Your firebase.js only exports `db`. Storage isn't exported, so we
// grab the default Storage instance from the already-initialized
// Firebase app that firebase.js set up. getStorage() with no args uses
// the default app — safe because if the app weren't initialized, the
// `db` import above would have failed first.
const storage = getStorage();
import {
  AOG_ELIGIBLE_TAILS, AOG_TAIL_CLASS, AOG_COVERAGE_RATES,
  classifyTail, computeCoverage, fmtCurrency, fmtPct, DEFAULT_FET_RATE,
} from './aog-utils.js';

// ── Firestore live subscriptions ───────────────────────────────────────
function useAogCoverage() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const q = query(collection(db, 'aogCoverage'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, []);
  return { docs, loading };
}

function useAogConfig() {
  const [cfg, setCfg] = useState({ opsRecipients: [], cfsRecipients: [], fetRate: DEFAULT_FET_RATE });
  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'aogConfig', 'settings'), (snap) => {
      if (snap.exists()) setCfg({ opsRecipients: [], cfsRecipients: [], fetRate: DEFAULT_FET_RATE, ...snap.data() });
    });
    return unsub;
  }, []);
  return cfg;
}

// ── Format helpers ─────────────────────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusBadge(status) {
  const map = {
    pending:  { bg: '#374151', fg: '#94a3b8', label: 'PENDING' },
    offered:  { bg: 'rgba(56,189,248,0.15)', fg: '#38bdf8', label: 'OFFERED' },
    accepted: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'ACCEPTED' },
    declined: { bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8', label: 'DECLINED' },
    expired:  { bg: 'rgba(239,68,68,0.15)', fg: '#f87171', label: 'EXPIRED' },
  };
  const s = map[status] || map.pending;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 3,
      background: s.bg, color: s.fg,
      fontFamily: 'ui-monospace, monospace', fontSize: 10,
      fontWeight: 600, letterSpacing: '0.1em',
    }}>{s.label}</span>
  );
}

// ── Month key: YYYY-MM in Eastern ──────────────────────────────────────
function monthKey(ts) {
  if (!ts) return null;
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  const yr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric' });
  const mo = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit' });
  return `${yr}-${mo}`;
}

// ─────────────────────────────────────────────────────────────────────
// NEW COVERAGE MODAL
// ─────────────────────────────────────────────────────────────────────
function NewCoverageModal({ onClose, onSaved, currentUser }) {
  const [tail, setTail] = useState('');
  const [broker, setBroker] = useState('');
  const [brokerEmail, setBrokerEmail] = useState('');
  const [routeFrom, setRouteFrom] = useState('');
  const [routeTo, setRouteTo] = useState('');
  const [tripDate, setTripDate] = useState('');
  const [tripTotal, setTripTotal] = useState('');
  const [fetAmount, setFetAmount] = useState('');
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const preview = useMemo(() => {
    if (!tail || !tripTotal) return null;
    const fetVal = fetAmount === '' ? undefined : Number(fetAmount);
    return computeCoverage({ tail, tripTotal: Number(tripTotal), fetAmount: fetVal });
  }, [tail, tripTotal, fetAmount]);

  async function handleSave() {
    setErr('');
    if (!tail || !broker || !brokerEmail || !routeFrom || !routeTo || !tripDate || !tripTotal) {
      setErr('Fill in all required fields');
      return;
    }
    if (!preview?.eligible) {
      setErr(preview?.error || 'Coverage calculation failed');
      return;
    }
    setSaving(true);
    try {
      // Create the doc first so we have an ID for the storage path
      const docRef = await addDoc(collection(db, 'aogCoverage'), {
        tail: tail.toUpperCase(),
        class: preview.class,
        broker,
        brokerEmail: brokerEmail.trim().toLowerCase(),
        routeFrom: routeFrom.toUpperCase(),
        routeTo: routeTo.toUpperCase(),
        tripDate: Timestamp.fromDate(new Date(tripDate)),
        tripTotal: preview.tripTotal,
        fetAmount: preview.fetAmount,
        netAmount: preview.netAmount,
        rate: preview.rate,
        coverageCost: preview.coverageCost,
        status: 'pending',
        invoiceUrl: null,
        invoicePath: null,
        invoiceFilename: null,
        tripUid: null, // filled by future iCal auto-matcher
        createdAt: serverTimestamp(),
        createdBy: currentUser?.uid || currentUser?.email || 'unknown',
        updatedAt: serverTimestamp(),
      });

      // Upload invoice if provided
      if (file) {
        const safeName = file.name.replace(/[^\w.\-]/g, '_');
        const path = `aog-coverage/${docRef.id}/${Date.now()}_${safeName}`;
        const ref = storageRef(storage, path);
        await uploadBytes(ref, file);
        const url = await getDownloadURL(ref);
        await updateDoc(docRef, {
          invoiceUrl: url,
          invoicePath: path,
          invoiceFilename: file.name,
          updatedAt: serverTimestamp(),
        });
      }

      onSaved?.(docRef.id);
      onClose();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <div style={{ fontSize: 10, letterSpacing: '0.15em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'ui-monospace, monospace', marginBottom: 4 }}>New Coverage Record</div>
          <h2 style={{ margin: 0, fontSize: 18, color: '#e2e8f0' }}>Track AOG Coverage</h2>
        </div>
        <div style={modalBody}>
          <div style={row2}>
            <Field label="Tail *">
              <select value={tail} onChange={e => setTail(e.target.value)} style={inputStyle}>
                <option value="">Select…</option>
                {AOG_ELIGIBLE_TAILS.map(t => (
                  <option key={t} value={t}>{t} — {AOG_TAIL_CLASS[t]} ({fmtPct(AOG_COVERAGE_RATES[AOG_TAIL_CLASS[t]])})</option>
                ))}
              </select>
            </Field>
            <Field label="Trip Date *">
              <input type="date" value={tripDate} onChange={e => setTripDate(e.target.value)} style={inputStyle} />
            </Field>
          </div>

          <div style={row2}>
            <Field label="Route From *">
              <input value={routeFrom} onChange={e => setRouteFrom(e.target.value.toUpperCase())} placeholder="KAPF" maxLength={4} style={inputStyle} />
            </Field>
            <Field label="Route To *">
              <input value={routeTo} onChange={e => setRouteTo(e.target.value.toUpperCase())} placeholder="KTEB" maxLength={4} style={inputStyle} />
            </Field>
          </div>

          <Field label="Broker Company *">
            <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="Broker Company Name" style={inputStyle} />
          </Field>
          <Field label="Broker Email *">
            <input type="email" value={brokerEmail} onChange={e => setBrokerEmail(e.target.value)} placeholder="ops@broker.com" style={inputStyle} />
          </Field>

          <div style={row2}>
            <Field label="Trip Total (gross) *">
              <input type="number" step="0.01" value={tripTotal} onChange={e => setTripTotal(e.target.value)} placeholder="0.00" style={inputStyle} />
            </Field>
            <Field label={`FET (auto: ${(DEFAULT_FET_RATE * 100).toFixed(1)}%)`}>
              <input type="number" step="0.01" value={fetAmount} onChange={e => setFetAmount(e.target.value)} placeholder="auto" style={inputStyle} />
            </Field>
          </div>

          <Field label="Invoice PDF (optional but recommended)">
            <input type="file" accept="application/pdf,image/*" onChange={e => setFile(e.target.files?.[0] || null)} style={{ ...inputStyle, padding: 8 }} />
          </Field>

          {preview && preview.eligible && (
            <div style={{
              marginTop: 16, padding: 16,
              background: 'rgba(56,189,248,0.08)',
              border: '1px solid rgba(56,189,248,0.25)',
              borderRadius: 6,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 13,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8' }}>
                <span>Net (post-FET)</span><span style={{ color: '#e2e8f0' }}>{fmtCurrency(preview.netAmount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', marginTop: 4 }}>
                <span>Rate ({preview.class})</span><span style={{ color: '#e2e8f0' }}>{fmtPct(preview.rate)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(148,163,184,0.2)' }}>
                <span style={{ color: '#94a3b8' }}>Coverage Cost</span>
                <span style={{ color: '#38bdf8', fontSize: 18, fontWeight: 600 }}>{fmtCurrency(preview.coverageCost)}</span>
              </div>
            </div>
          )}
          {preview && !preview.eligible && (
            <div style={errBox}>{preview.error}</div>
          )}
          {err && <div style={errBox}>{err}</div>}
        </div>
        <div style={modalFooter}>
          <button onClick={onClose} style={btnGhost} disabled={saving}>Cancel</button>
          <button onClick={handleSave} style={btnPrimary} disabled={saving || !preview?.eligible}>
            {saving ? 'Saving…' : 'Save Record'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// CONFIG MODAL — CFS + Ops recipients
// ─────────────────────────────────────────────────────────────────────
function ConfigModal({ onClose }) {
  const cfg = useAogConfig();
  const [ops, setOps] = useState('');
  const [cfs, setCfs] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setOps((cfg.opsRecipients || []).join(', '));
    setCfs((cfg.cfsRecipients || []).join(', '));
  }, [cfg]);

  async function handleSave() {
    setSaving(true);
    setErr('');
    try {
      const parse = (s) => s.split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
      await setDoc(doc(db, 'aogConfig', 'settings'), {
        opsRecipients: parse(ops),
        cfsRecipients: parse(cfs),
        fetRate: cfg.fetRate ?? DEFAULT_FET_RATE,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...modal, maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={modalHeader}>
          <div style={{ fontSize: 10, letterSpacing: '0.15em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'ui-monospace, monospace', marginBottom: 4 }}>Configuration</div>
          <h2 style={{ margin: 0, fontSize: 18, color: '#e2e8f0' }}>Notification Recipients</h2>
        </div>
        <div style={modalBody}>
          <p style={{ color: '#94a3b8', fontSize: 13, lineHeight: 1.5, marginBottom: 16 }}>
            When a broker accepts or declines coverage, these people receive an email notification. Separate multiple emails with commas.
          </p>
          <Field label="Ops team recipients">
            <textarea value={ops} onChange={e => setOps(e.target.value)} rows={3} placeholder="ops@flyskyway.com, dispatch@flyskyway.com" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }} />
          </Field>
          <Field label="CFS / JetSure recipients">
            <textarea value={cfs} onChange={e => setCfs(e.target.value)} rows={3} placeholder="agent@charterflightsupport.com" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }} />
          </Field>
          {err && <div style={errBox}>{err}</div>}
        </div>
        <div style={modalFooter}>
          <button onClick={onClose} style={btnGhost} disabled={saving}>Cancel</button>
          <button onClick={handleSave} style={btnPrimary} disabled={saving}>{saving ? 'Saving…' : 'Save Recipients'}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MAIN TAB
// ─────────────────────────────────────────────────────────────────────
export default function AogTab({ currentUser }) {
  const { docs: coverage, loading } = useAogCoverage();
  const [showNew, setShowNew] = useState(false);
  const [showCfg, setShowCfg] = useState(false);
  const [monthFilter, setMonthFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sendingOffer, setSendingOffer] = useState(null); // coverageId
  const [sendErr, setSendErr] = useState('');

  // Month options — every distinct month present in the records + a couple back
  const monthOptions = useMemo(() => {
    const set = new Set();
    coverage.forEach(c => {
      const k = monthKey(c.tripDate);
      if (k) set.add(k);
    });
    // Always show current month even if no records
    set.add(monthKey(new Date()));
    return ['all', ...[...set].sort().reverse()];
  }, [coverage]);

  const filtered = useMemo(() => {
    return coverage.filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (monthFilter !== 'all' && monthKey(c.tripDate) !== monthFilter) return false;
      return true;
    });
  }, [coverage, statusFilter, monthFilter]);

  // Rollups
  const rollup = useMemo(() => {
    let accepted = 0, offered = 0, pending = 0, declined = 0, acceptedCount = 0;
    filtered.forEach(c => {
      if (c.status === 'accepted') { accepted += c.coverageCost || 0; acceptedCount++; }
      if (c.status === 'offered')  offered += c.coverageCost || 0;
      if (c.status === 'pending')  pending += c.coverageCost || 0;
      if (c.status === 'declined') declined += c.coverageCost || 0;
    });
    return { accepted, offered, pending, declined, acceptedCount };
  }, [filtered]);

  async function handleSendOffer(coverageId) {
    setSendErr('');
    setSendingOffer(coverageId);
    try {
      const r = await fetch('/api/aog-offer-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coverageId }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Send failed');
    } catch (e) {
      setSendErr(`Failed to send offer: ${e.message}`);
    } finally {
      setSendingOffer(null);
    }
  }

  return (
    <div style={{ padding: '24px', color: '#e2e8f0', fontFamily: 'inherit', minHeight: '100vh' }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid #1e293b' }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.15em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'ui-monospace, monospace' }}>Charter Flight Support / JetSure</div>
          <h1 style={{ margin: '4px 0 0', fontSize: 22, fontWeight: 600 }}>AOG Coverage</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowCfg(true)} style={btnGhost}>Config</button>
          <button onClick={() => setShowNew(true)} style={btnPrimary}>+ New Coverage</button>
        </div>
      </div>

      {/* Rollup cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <RollupCard label="Accepted" value={fmtCurrency(rollup.accepted)} sub={`${rollup.acceptedCount} trip${rollup.acceptedCount === 1 ? '' : 's'}`} color="#10b981" />
        <RollupCard label="Offered — Pending Response" value={fmtCurrency(rollup.offered)} sub="awaiting broker" color="#38bdf8" />
        <RollupCard label="Pending Send" value={fmtCurrency(rollup.pending)} sub="not yet offered" color="#94a3b8" />
        <RollupCard label="Declined" value={fmtCurrency(rollup.declined)} sub="broker declined" color="#64748b" />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <span style={eyebrow}>Filter</span>
        <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)} style={filterSelect}>
          {monthOptions.map(m => <option key={m} value={m}>{m === 'all' ? 'All months' : m}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={filterSelect}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="offered">Offered</option>
          <option value="accepted">Accepted</option>
          <option value="declined">Declined</option>
          <option value="expired">Expired</option>
        </select>
        <span style={{ marginLeft: 'auto', color: '#64748b', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
          {filtered.length} record{filtered.length === 1 ? '' : 's'}
        </span>
      </div>

      {sendErr && <div style={{ ...errBox, marginBottom: 12 }}>{sendErr}</div>}

      {/* Table */}
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#131a26', borderBottom: '1px solid #1e293b' }}>
              {['DATE','TAIL','ROUTE','BROKER','TRIP TOTAL','NET','COST','STATUS','ACTIONS'].map(h => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#64748b', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>Loading…</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: 'center', color: '#64748b', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>No records match current filters</td></tr>
            )}
            {filtered.map(c => (
              <tr key={c.id} style={{ borderBottom: '1px solid #1e293b' }}>
                <td style={td}>{fmtDate(c.tripDate)}</td>
                <td style={{ ...td, color: '#38bdf8', fontFamily: 'ui-monospace, monospace' }}>{c.tail}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{c.routeFrom} → {c.routeTo}</td>
                <td style={td}>{c.broker}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{fmtCurrency(c.tripTotal)}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: '#94a3b8' }}>{fmtCurrency(c.netAmount)}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: '#38bdf8', fontWeight: 600 }}>{fmtCurrency(c.coverageCost)}</td>
                <td style={td}>{statusBadge(c.status)}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {c.invoiceUrl && (
                      <a href={c.invoiceUrl} target="_blank" rel="noopener noreferrer" style={btnMini}>PDF</a>
                    )}
                    {c.status === 'pending' && (
                      <button onClick={() => handleSendOffer(c.id)} disabled={sendingOffer === c.id} style={btnMiniPrimary}>
                        {sendingOffer === c.id ? '…' : 'SEND OFFER'}
                      </button>
                    )}
                    {c.status === 'offered' && (
                      <button onClick={() => handleSendOffer(c.id)} disabled={sendingOffer === c.id} style={btnMini} title="Resend offer email">
                        {sendingOffer === c.id ? '…' : 'RESEND'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && <NewCoverageModal onClose={() => setShowNew(false)} currentUser={currentUser} />}
      {showCfg && <ConfigModal onClose={() => setShowCfg(false)} />}
    </div>
  );
}

// ── Presentational helpers ─────────────────────────────────────────────
function RollupCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 6, padding: 16 }}>
      <div style={eyebrow}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 22, fontWeight: 600, color, fontFamily: 'ui-monospace, monospace' }}>{value}</div>
      <div style={{ marginTop: 4, fontSize: 11, color: '#64748b', fontFamily: 'ui-monospace, monospace' }}>{sub}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 10, letterSpacing: '0.15em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'ui-monospace, monospace', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────
const eyebrow = { fontSize: 10, letterSpacing: '0.15em', color: '#64748b', textTransform: 'uppercase', fontFamily: 'ui-monospace, monospace' };
const inputStyle = {
  width: '100%', padding: '8px 10px',
  background: '#0b0f17', border: '1px solid #1e293b',
  color: '#e2e8f0', borderRadius: 4, fontSize: 13,
  fontFamily: 'inherit', boxSizing: 'border-box',
};
const filterSelect = { ...inputStyle, width: 'auto', padding: '6px 10px' };
const th = { padding: '10px 12px', textAlign: 'left', fontFamily: 'ui-monospace, monospace', fontSize: 9, color: '#64748b', letterSpacing: '0.15em', textTransform: 'uppercase' };
const td = { padding: '10px 12px', fontSize: 13, color: '#e2e8f0' };
const btnBase = { padding: '8px 14px', borderRadius: 4, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.05em', fontFamily: 'inherit' };
const btnPrimary = { ...btnBase, background: '#0ea5e9', color: '#0b0f17' };
const btnGhost = { ...btnBase, background: 'transparent', color: '#94a3b8', border: '1px solid #334155' };
const btnMini = { padding: '4px 10px', borderRadius: 3, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', fontSize: 10, fontWeight: 600, cursor: 'pointer', letterSpacing: '0.1em', fontFamily: 'ui-monospace, monospace', textDecoration: 'none', display: 'inline-block' };
const btnMiniPrimary = { ...btnMini, background: '#0ea5e9', color: '#0b0f17', border: 'none' };
const errBox = { marginTop: 12, padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', borderRadius: 4, fontSize: 12, fontFamily: 'ui-monospace, monospace' };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 };
const modal = { background: '#131a26', border: '1px solid #1e293b', borderRadius: 8, maxWidth: 640, width: '100%', maxHeight: '90vh', overflow: 'auto', color: '#e2e8f0' };
const modalHeader = { padding: '20px 24px', borderBottom: '1px solid #1e293b' };
const modalBody = { padding: '20px 24px' };
const modalFooter = { padding: '16px 24px', borderTop: '1px solid #1e293b', display: 'flex', gap: 8, justifyContent: 'flex-end' };
const row2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
