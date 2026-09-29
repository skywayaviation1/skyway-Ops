// Charter contract on the trip detail. The inbox scan writes `charterContract`
// onto every leg that shares the trip id. This reads that field directly so
// it does not have to go through subscribeToTripState (draft PRs #29 and #30
// both edit that helper).

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { getDownloadURL, ref } from 'firebase/storage';
import { db } from './firebase.js';
import { storage } from './firebase-storage.js';

function safeTripId(tripUid) {
  return String(tripUid || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

function when(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function money(cents) {
  if (!Number.isInteger(cents)) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function CharterContractDocument({ contract, facts, onOpen }) {
  if (!contract?.path && !contract?.url) return null;
  const source = contract.source || {};
  const received = when(source.receivedAt);
  const versions = Array.isArray(contract.versions) ? contract.versions.length : 0;
  const route = [facts?.origin, facts?.destination].filter(Boolean).join(' → ');
  const total = money(facts?.tripTotalCents);
  return (
    <section className="mx-4 mt-3 rounded-lg border border-edge bg-surface px-3 py-3 md:mx-6" aria-label="Trip documents">
      <h2 className="text-2xs uppercase tracking-[0.14em] text-content-muted">Documents</h2>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-content">Signed charter contract</p>
          <p className="text-xs text-content-muted">{contract.filename || 'charter-contract.pdf'}</p>
          {(facts?.tripId || route || total) && (
            <p className="mt-1 text-xs text-content">
              {[facts?.tripId, facts?.tail, route, total].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className="mt-1 text-xs text-content-muted">
            From {source.sender || 'unknown sender'}
            {received ? ` · received ${received}` : ''}
          </p>
          {source.messageId && (
            <p className="text-2xs text-content-muted">Mailbox message {source.messageId}</p>
          )}
          {versions > 0 && (
            <p className="text-2xs text-content-muted">
              {versions} earlier version{versions === 1 ? '' : 's'} kept
            </p>
          )}
        </div>
        <button
          type="button"
          className="rounded-md border border-edge px-3 py-1.5 text-xs font-medium text-accent"
          onClick={onOpen}
        >
          Open PDF
        </button>
      </div>
    </section>
  );
}

export default function TripCharterContract({ tripUid }) {
  const [contract, setContract] = useState(null);
  const [facts, setFacts] = useState(null);

  useEffect(() => {
    const id = safeTripId(tripUid);
    if (!id) return undefined;
    return onSnapshot(doc(db, 'trip-state', id), (snap) => {
      const data = snap.exists() ? snap.data() || {} : {};
      setContract(data.charterContract || null);
      setFacts(data.charterContractData || null);
    }, () => { setContract(null); setFacts(null); });
  }, [tripUid]);

  async function open() {
    if (!contract) return;
    try {
      const url = contract.url || await getDownloadURL(ref(storage, contract.path));
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      window.alert(err.message || 'Could not open the charter contract');
    }
  }

  return <CharterContractDocument contract={contract} facts={facts} onOpen={open} />;
}
