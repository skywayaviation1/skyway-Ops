// LodgingDashboard.jsx — aggregate crew-lodging view for the top nav.
//
// Different from Lodging.jsx (trip-detail tab):
//   - Cross-trip: shows every booking with a tripUid set, all in one place
//   - Searchable + filterable by time window
//   - Each row links back to its trip detail
//   - "+ ADD LODGING" requires picking a trip first (since there's no
//     current trip context)
//
// Permissions:
//   - ops/admin see every booking with a tripUid
//   - crew see only their own bookings
//
// Data path:
//   - ops/admin: query `travel-bookings where tripUid != null`
//   - crew:     query `travel-bookings where userUid == me AND tripUid != null`
//
// Both use Firestore listeners so the page updates in real time as
// bookings are added or modified elsewhere (e.g. on the trip detail
// LODGING tab).

import React, { useEffect, useMemo, useState } from 'react';
import { Hotel, Plane, Search, Plus, Loader2, X, Calendar, MapPin, ChevronRight } from 'lucide-react';
import { db } from './firebase.js';
import {
  collection, query, where, onSnapshot, orderBy,
} from 'firebase/firestore';

// ====================================================================
// MAIN
// ====================================================================

export default function LodgingDashboard({ currentUser, users = [], allTrips = [], onOpenTrip }) {
  const isOpsOrAdmin = ['ops', 'admin'].includes(currentUser?.role);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('upcoming'); // all | today | thisweek | upcoming | past
  const [searchTerm, setSearchTerm] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  // Real-time subscription. Ops/admin get every booking with a tripUid;
  // crew get only their own. We deliberately exclude bookings without
  // a tripUid (those are personal travel from the WALLET tab, not crew
  // lodging for a trip).
  useEffect(() => {
    if (!currentUser?.uid) return;
    setLoading(true);
    let q;
    if (isOpsOrAdmin) {
      // All bookings with tripUid set. Firestore doesn't support
      // "where field exists" natively — we filter on the client.
      q = query(collection(db, 'travel-bookings'));
    } else {
      q = query(collection(db, 'travel-bookings'), where('userUid', '==', currentUser.uid));
    }
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = [];
        snap.forEach((d) => {
          const data = d.data();
          // Only include bookings linked to a trip
          if (!data.tripUid) return;
          list.push({ id: d.id, ...data });
        });
        // Sort by check-in date descending (most recent / upcoming first)
        list.sort((a, b) => {
          const ad = a.checkInDate || a.startDate || '';
          const bd = b.checkInDate || b.startDate || '';
          return bd.localeCompare(ad);
        });
        setBookings(list);
        setLoading(false);
      },
      (err) => {
        console.error('[lodging-dashboard] subscribe error:', err);
        setBookings([]);
        setLoading(false);
      }
    );
    return () => { try { unsub(); } catch (_) {} };
  }, [currentUser?.uid, isOpsOrAdmin]);

  // Build a tripUid → trip map for the row display (so we can show
  // tail / route / date next to each booking). allTrips is the parsed
  // iCal + manual-trips list from App.jsx.
  const tripsByUid = useMemo(() => {
    const m = new Map();
    allTrips.forEach((t) => { if (t.uid) m.set(t.uid, t); });
    return m;
  }, [allTrips]);

  // User lookup for the "for crewmember" display
  const lookupUserName = (uid) => {
    const u = users.find((x) => x.uid === uid || x.id === uid);
    return u?.name || u?.displayName || 'Unknown';
  };

  // Apply filter + search to the booking list
  const filtered = useMemo(() => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const weekFromNow = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);

    let result = bookings;
    if (filter === 'today') {
      result = result.filter((b) => b.checkInDate === today || (b.checkInDate < today && b.checkOutDate >= today));
    } else if (filter === 'thisweek') {
      result = result.filter((b) => b.checkInDate >= today && b.checkInDate <= weekFromNow);
    } else if (filter === 'upcoming') {
      result = result.filter((b) => b.checkOutDate >= today);
    } else if (filter === 'past') {
      result = result.filter((b) => b.checkOutDate < today);
    }
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      result = result.filter((b) => {
        const trip = tripsByUid.get(b.tripUid);
        const crewName = lookupUserName(b.userUid).toLowerCase();
        return (
          (b.hotelName || '').toLowerCase().includes(q) ||
          (b.hotelBrand || '').toLowerCase().includes(q) ||
          (b.city || '').toLowerCase().includes(q) ||
          (b.confirmationCode || '').toLowerCase().includes(q) ||
          crewName.includes(q) ||
          (trip?.info?.tail || '').toLowerCase().includes(q) ||
          (trip?.info?.from || '').toLowerCase().includes(q) ||
          (trip?.info?.to || '').toLowerCase().includes(q)
        );
      });
    }
    return result;
  }, [bookings, filter, searchTerm, tripsByUid, users]);

  // Top-line stats for context
  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    let todayCount = 0;
    let upcomingCount = 0;
    bookings.forEach((b) => {
      if (b.checkInDate <= today && b.checkOutDate >= today) todayCount++;
      if (b.checkOutDate >= today) upcomingCount++;
    });
    return { today: todayCount, upcoming: upcomingCount, total: bookings.length };
  }, [bookings]);

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            CREW LODGING
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {isOpsOrAdmin
              ? 'All crew hotel bookings linked to operational trips.'
              : 'Your hotel bookings for crew trips.'}
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium tracking-widest"
          style={{ fontFamily: 'JetBrains Mono, monospace' }}
        >
          <Plus className="w-4 h-4 inline-block mr-1 -mt-0.5" /> ADD LODGING
        </button>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <div className="bg-slate-900/40 border border-slate-800 px-3 py-2">
          <div className="text-2xl tabular-nums text-cyan-300" style={{ fontWeight: 700 }}>{stats.today}</div>
          <div className="text-[10px] tracking-widest text-slate-400 mt-0.5">CHECKED IN TODAY</div>
        </div>
        <div className="bg-slate-900/40 border border-slate-800 px-3 py-2">
          <div className="text-2xl tabular-nums text-amber-300" style={{ fontWeight: 700 }}>{stats.upcoming}</div>
          <div className="text-[10px] tracking-widest text-slate-400 mt-0.5">UPCOMING</div>
        </div>
        <div className="bg-slate-900/40 border border-slate-800 px-3 py-2">
          <div className="text-2xl tabular-nums text-slate-200" style={{ fontWeight: 700 }}>{stats.total}</div>
          <div className="text-[10px] tracking-widest text-slate-400 mt-0.5">TOTAL ON RECORD</div>
        </div>
      </div>

      {/* Filters + search */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {[
            { id: 'upcoming', label: 'UPCOMING' },
            { id: 'today',    label: 'TODAY' },
            { id: 'thisweek', label: 'THIS WEEK' },
            { id: 'past',     label: 'PAST' },
            { id: 'all',      label: 'ALL' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1.5 text-[10px] tracking-widest border ${
                filter === f.id
                  ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                  : 'border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-500'
              }`}
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-[200px] relative">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500 pointer-events-none" />
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search hotel, crew, tail, airport..."
            className="w-full bg-slate-900 border border-slate-700 pl-10 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="p-12 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Loading lodging...
        </div>
      ) : filtered.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-12 text-center">
          <Hotel className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">
            {bookings.length === 0
              ? 'No crew lodging on record yet'
              : 'No bookings match this filter'}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            {bookings.length === 0
              ? 'Add lodging from a trip detail page, or click ADD LODGING above.'
              : 'Try ALL or a different filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((b) => (
            <BookingRow
              key={b.id}
              booking={b}
              trip={tripsByUid.get(b.tripUid)}
              crewName={lookupUserName(b.userUid)}
              onClick={() => onOpenTrip && onOpenTrip(b.tripUid)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <PickTripModal
          currentUser={currentUser}
          allTrips={allTrips}
          onClose={() => setShowAdd(false)}
          onPickTrip={(uid) => {
            setShowAdd(false);
            if (onOpenTrip) onOpenTrip(uid);
          }}
        />
      )}
    </div>
  );
}

// ====================================================================
// BOOKING ROW
// ====================================================================

function BookingRow({ booking, trip, crewName, onClick }) {
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d + 'T00:00:00');
    if (isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const nights = (() => {
    if (!booking.checkInDate || !booking.checkOutDate) return null;
    const diff = (new Date(booking.checkOutDate) - new Date(booking.checkInDate)) / (1000 * 60 * 60 * 24);
    return Math.round(diff);
  })();
  // Status: upcoming / current / past
  const today = new Date().toISOString().slice(0, 10);
  let statusLabel = 'BOOKED';
  let statusColor = 'border-slate-600 text-slate-400 bg-slate-800/40';
  if (booking.checkInDate <= today && booking.checkOutDate >= today) {
    statusLabel = 'CHECKED IN';
    statusColor = 'border-cyan-500/60 text-cyan-200 bg-cyan-500/15';
  } else if (booking.checkOutDate < today) {
    statusLabel = 'PAST';
    statusColor = 'border-slate-700 text-slate-500 bg-slate-800/20';
  } else if (booking.checkInDate === today) {
    statusLabel = 'TODAY';
    statusColor = 'border-amber-500/60 text-amber-200 bg-amber-500/15';
  }

  return (
    <button
      onClick={onClick}
      disabled={!trip || !onClick}
      className="w-full text-left bg-slate-900/40 hover:bg-slate-900/70 border border-slate-800 hover:border-slate-700 px-3 py-2.5 transition-colors disabled:cursor-default disabled:hover:bg-slate-900/40"
    >
      <div className="grid grid-cols-[80px_1fr_180px_80px_24px] gap-3 items-center">
        {/* Status pill */}
        <div className={`text-center text-[10px] tracking-widest font-semibold px-2 py-1 border ${statusColor}`}
          style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {statusLabel}
        </div>
        {/* Hotel */}
        <div className="min-w-0">
          <div className="text-base text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
            {booking.hotelName || '(unnamed)'}
            {booking.hotelBrand && (
              <span className="text-xs text-slate-500 ml-2 font-normal">{booking.hotelBrand}</span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            <span className="text-slate-500">FOR</span>
            <span className="text-slate-300">{crewName}</span>
            {trip?.info && (
              <>
                <span className="text-slate-700">·</span>
                <span className="text-slate-500">TRIP</span>
                <span className="text-slate-300">{trip.info.tail}</span>
                <span className="text-slate-500">{trip.info.from} → {trip.info.to}</span>
              </>
            )}
          </div>
        </div>
        {/* Dates */}
        <div className="text-xs tabular-nums text-slate-300" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {fmtDate(booking.checkInDate)} → {fmtDate(booking.checkOutDate)}
          {nights !== null && (
            <div className="text-[10px] text-slate-500 mt-0.5">{nights} night{nights === 1 ? '' : 's'}</div>
          )}
        </div>
        {/* Conf */}
        <div className="text-right">
          <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CONF
          </div>
          <div className="text-xs font-mono text-slate-200 truncate" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {booking.confirmationCode || '—'}
          </div>
        </div>
        {/* Chevron */}
        <div className="text-slate-600">
          <ChevronRight className="w-4 h-4" />
        </div>
      </div>
    </button>
  );
}

// ====================================================================
// PICK TRIP MODAL — for "+ ADD LODGING" when there's no current trip
// ====================================================================

function PickTripModal({ currentUser, allTrips, onClose, onPickTrip }) {
  const [searchTerm, setSearchTerm] = useState('');
  const isOpsOrAdmin = ['ops', 'admin'].includes(currentUser?.role);
  const now = Date.now();

  // Operational trips (revenue/repo) in the next 14 days. Crew see only
  // trips they're on; ops/admin see everything.
  const candidateTrips = useMemo(() => {
    const cutoff = now + 14 * 86400 * 1000;
    return (allTrips || [])
      .filter((t) => {
        if (!t.info?.isOps) return false;
        const ts = t.start instanceof Date ? t.start.getTime() : new Date(t.start).getTime();
        if (!Number.isFinite(ts)) return false;
        if (ts > cutoff) return false;
        if (ts < now - 86400 * 1000) return false; // not more than 1 day in past
        // Crew filter — must be on the trip
        if (!isOpsOrAdmin) {
          const myName = (currentUser?.name || currentUser?.displayName || '').toLowerCase();
          if (!myName) return false;
          const pic = (t.info.pic || '').toLowerCase();
          const sic = (t.info.sic || '').toLowerCase();
          if (!pic.includes(myName) && !sic.includes(myName)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ta = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
        const tb = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
        return ta - tb;
      });
  }, [allTrips, currentUser, isOpsOrAdmin]);

  const filtered = useMemo(() => {
    if (!searchTerm.trim()) return candidateTrips;
    const q = searchTerm.toLowerCase();
    return candidateTrips.filter((t) => {
      return (
        (t.info?.tail || '').toLowerCase().includes(q) ||
        (t.info?.from || '').toLowerCase().includes(q) ||
        (t.info?.to || '').toLowerCase().includes(q) ||
        (t.info?.pic || '').toLowerCase().includes(q) ||
        (t.info?.sic || '').toLowerCase().includes(q)
      );
    });
  }, [candidateTrips, searchTerm]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 shrink-0">
          <div>
            <h3 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              PICK A TRIP
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Lodging is added to a specific trip. Choose which one.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 border-b border-slate-800 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-500 pointer-events-none" />
            <input
              autoFocus
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search tail, route, crew..."
              className="w-full bg-slate-800 border border-slate-700 pl-10 pr-3 py-2 text-slate-100 placeholder:text-slate-600"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-slate-500 text-sm">
              {candidateTrips.length === 0
                ? 'No upcoming operational trips in the next 14 days.'
                : 'No trips match your search.'}
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((t) => {
                const dt = t.start instanceof Date ? t.start : new Date(t.start);
                return (
                  <button
                    key={t.uid}
                    onClick={() => onPickTrip(t.uid)}
                    className="w-full text-left bg-slate-800/40 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <div className="text-xs tabular-nums text-slate-400 w-20 shrink-0" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        <div className="text-[10px] text-slate-500">
                          {dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                          {t.info?.tail || '?'}
                          <span className="text-slate-500 font-normal text-xs ml-2 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                            {t.info?.from} → {t.info?.to}
                          </span>
                        </div>
                        <div className="text-xs text-slate-400 mt-0.5">
                          {t.info?.pic || 'No crew'}
                          {t.info?.sic && ` / ${t.info.sic}`}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-600 shrink-0" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Tip: tap a trip to jump to its LODGING tab where you can add the booking.
        </div>
      </div>
    </div>
  );
}
