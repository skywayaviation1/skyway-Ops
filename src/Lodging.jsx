// Lodging.jsx — crew lodging on a trip. Shown as a tab on the trip
// detail page (ops/admin/crew can see it). Each booking is a record
// in the existing `travel-bookings` collection, with a `tripUid` field
// linking it to this trip.
//
// What this shows:
//   - All hotel + flight bookings linked to the trip
//   - Who the booking is for (crewmember name from userUid)
//   - Dates, confirmation #, hotel name + brand
//   - For lodging, a "+ Add Lodging" button that opens a form pre-filled
//     with trip context (tripUid, suggested dates from trip departure)
//
// What this does NOT do (yet):
//   - Search Expedia / Booking.com for hotels (no API access — manual entry)
//   - Take payment (out of scope — corporate card / invoice happens externally)
//   - Send confirmations to crew (could be added — for now bookings are
//     visible in the crew's own TRAVEL tab + on this trip)
//
// When TAAP Lodging Shopping API access arrives, the manual form will
// gain a search button that auto-fills hotel name/address/conf# from
// the API. The data model below already supports it — no schema change
// needed when search is added.

import React, { useEffect, useState } from 'react';
import { Hotel, Plane, Plus, Loader2, X, Search, Star, AlertTriangle, ChevronLeft } from 'lucide-react';
import { searchProperties, getPropertyDetail, bookRoom, DEMO_MODE } from './rapid-mock.js';

// ====================================================================
// MAIN COMPONENT
// ====================================================================

export default function Lodging({ trip, currentUser, users = [] }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  // FIND HOTELS flow — opens the search modal. Currently powered by
  // mock data; when real Rapid API credentials arrive, the mock client
  // gets swapped for real fetches and DEMO_MODE flips to false.
  const [showFind, setShowFind] = useState(false);

  // Subscribe to all bookings linked to this trip. Updates in real time
  // as crew or dispatch add hotels.
  useEffect(() => {
    if (!trip?.uid) return;
    let unsub = () => {};
    let cancelled = false;
    setLoading(true);
    (async () => {
      const m = await import('./firebase-travel.js');
      if (cancelled) return;
      unsub = m.subscribeToTripBookings(trip.uid, (list) => {
        setBookings(list);
        setLoading(false);
      });
    })();
    return () => { cancelled = true; try { unsub(); } catch (_) {} };
  }, [trip?.uid]);

  // Look up crewmember name from userUid for the booking-belongs-to display
  const lookupUser = (uid) => {
    const u = users.find((x) => x.uid === uid || x.id === uid);
    return u?.name || u?.displayName || 'Unknown';
  };

  // Permissions: anyone on the trip + ops/admin can see this tab.
  // Only ops/admin and the booking's own crewmember can add/edit.
  const isOpsOrAdmin = ['ops', 'admin'].includes(currentUser?.role);

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            CREW LODGING
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Hotels and overnight stays for this trip.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFind(true)}
            className="px-3 py-2 border border-amber-500/60 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
            title="Search Expedia for hotels (currently DEMO mode)"
          >
            <Search className="w-4 h-4 inline-block mr-1 -mt-0.5" /> FIND HOTELS
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="px-3 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Plus className="w-4 h-4 inline-block mr-1 -mt-0.5" /> ADD MANUALLY
          </button>
        </div>
      </div>

      {/* Demo-mode banner — only rendered while DEMO_MODE is true. When
          real Rapid credentials are wired up and DEMO_MODE flips to
          false, this disappears entirely. Until then it's a persistent,
          unmissable signal that any "booking" made via FIND HOTELS is
          not a real reservation. */}
      {DEMO_MODE && (
        <div className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0" />
          <span className="text-xs text-amber-200" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            FIND HOTELS is in DEMO mode — searches return mock data and bookings are not real. ADD MANUALLY records real bookings made outside the app.
          </span>
        </div>
      )}

      {/* Trip context strip — show key trip info so dispatch doesn't have
          to switch tabs to remember dates / destination */}
      <div className="border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <span className="text-slate-500">TRIP</span>{' '}
        <span className="text-slate-200">{trip.info?.tail || '?'}</span>
        <span className="text-slate-600 mx-2">·</span>
        <span className="text-slate-200">{trip.info?.from} → {trip.info?.to}</span>
        <span className="text-slate-600 mx-2">·</span>
        <span className="text-slate-200">
          {trip.start ? new Date(trip.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
        </span>
        {trip.info?.pic && (
          <>
            <span className="text-slate-600 mx-2">·</span>
            <span className="text-slate-500">PIC</span>{' '}
            <span className="text-slate-200">{trip.info.pic}</span>
          </>
        )}
        {trip.info?.sic && (
          <>
            <span className="text-slate-600 mx-1">/</span>
            <span className="text-slate-200">{trip.info.sic}</span>
          </>
        )}
      </div>

      {/* Bookings list */}
      {loading ? (
        <div className="p-8 text-center text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          Loading lodging...
        </div>
      ) : bookings.length === 0 ? (
        <div className="border border-dashed border-slate-700 p-12 text-center">
          <Hotel className="w-8 h-8 text-slate-700 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No lodging booked yet</p>
          <p className="text-xs text-slate-600 mt-1">
            Tap FIND HOTELS to search, or ADD MANUALLY to record an existing reservation.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {bookings.map((b) => (
            <LodgingRow key={b.id} booking={b} crewName={lookupUser(b.userUid)} />
          ))}
        </div>
      )}

      {showAdd && (
        <AddLodgingModal
          trip={trip}
          currentUser={currentUser}
          users={users}
          isOpsOrAdmin={isOpsOrAdmin}
          onClose={() => setShowAdd(false)}
        />
      )}

      {showFind && (
        <FindHotelsModal
          trip={trip}
          currentUser={currentUser}
          users={users}
          isOpsOrAdmin={isOpsOrAdmin}
          onClose={() => setShowFind(false)}
        />
      )}
    </div>
  );
}

// ====================================================================
// SINGLE BOOKING ROW
// ====================================================================

function LodgingRow({ booking, crewName }) {
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
  const isFlight = booking.type === 'flight';
  const Icon = isFlight ? Plane : Hotel;
  const accentColor = isFlight ? 'border-cyan-500' : 'border-amber-500';

  return (
    <div className={`border-l-4 ${accentColor} bg-slate-900/40 p-4`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="bg-slate-800 rounded p-2 shrink-0">
            <Icon className="w-5 h-5 text-slate-300" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
              {isFlight ? 'FLIGHT' : (booking.hotelBrand || 'HOTEL').toUpperCase()}
            </div>
            <h3 className="text-base mt-0.5" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
              {isFlight
                ? `${booking.airline || ''} ${booking.flightNumber || ''}`.trim() || '(flight)'
                : (booking.hotelName || '(unnamed)')}
            </h3>
            {!isFlight && booking.city && (
              <p className="text-xs text-slate-500 mt-0.5">
                {booking.city}{booking.state ? `, ${booking.state}` : ''}
              </p>
            )}
            <p className="text-xs text-slate-400 mt-2">
              <span className="text-slate-500">For:</span> {crewName}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            CONF
          </div>
          <div className="text-sm font-mono text-slate-200" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
            {booking.confirmationCode || '—'}
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800 pt-2 mt-3 text-xs" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        <span className="text-slate-500">
          {isFlight ? 'DEPART' : 'CHECK-IN → CHECK-OUT'}
        </span>
        <div className="text-slate-200 mt-0.5">
          {isFlight
            ? fmtDate(booking.departDate)
            : <>
                {fmtDate(booking.checkInDate)} → {fmtDate(booking.checkOutDate)}
                {nights !== null && <span className="text-slate-500 ml-2">({nights} night{nights === 1 ? '' : 's'})</span>}
              </>
          }
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// ADD LODGING MODAL
// ====================================================================

function AddLodgingModal({ trip, currentUser, users, isOpsOrAdmin, onClose }) {
  // Pre-fill from trip context. Check-in date = trip start date (crew
  // usually checks in same day as arrival); check-out 1 day later.
  // Crewmember defaults to current user, but ops/admin can pick from
  // PIC/SIC.
  const tripDate = trip.start ? new Date(trip.start) : new Date();
  const defaultCheckIn = tripDate.toISOString().slice(0, 10);
  const defaultCheckOut = new Date(tripDate.getTime() + 86400000).toISOString().slice(0, 10);

  // Build the crewmember picker options. PIC + SIC if we have them in
  // the users list; otherwise fall back to current user.
  const crewOptions = (() => {
    const opts = [];
    const seen = new Set();
    const tryAddByName = (name) => {
      if (!name) return;
      const u = users.find((x) => x.name === name || x.displayName === name);
      if (u && !seen.has(u.uid)) {
        opts.push({ uid: u.uid, name: u.name || u.displayName });
        seen.add(u.uid);
      }
    };
    tryAddByName(trip.info?.pic);
    tryAddByName(trip.info?.sic);
    if (currentUser && !seen.has(currentUser.uid)) {
      opts.push({ uid: currentUser.uid, name: currentUser.name || currentUser.displayName || 'Me' });
    }
    return opts;
  })();

  const [forUid, setForUid] = useState(crewOptions[0]?.uid || currentUser?.uid || '');
  const [hotelName, setHotelName] = useState('');
  const [hotelBrand, setHotelBrand] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [checkInDate, setCheckInDate] = useState(defaultCheckIn);
  const [checkOutDate, setCheckOutDate] = useState(defaultCheckOut);
  const [confirmationCode, setConfirmationCode] = useState('');
  const [nightlyRate, setNightlyRate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { saveBooking, newBookingId } = await import('./firebase-travel.js');
      const id = newBookingId('hotel');
      await saveBooking({
        id,
        type: 'hotel',
        // Linkage: this is what surfaces it on the trip
        tripUid: trip.uid,
        tripContext: {
          tail: trip.info?.tail || null,
          from: trip.info?.from || null,
          to: trip.info?.to || null,
          startDate: trip.start ? new Date(trip.start).toISOString() : null,
        },
        // Who the lodging is for
        userUid: forUid,
        // Hotel fields (matching existing AddBookingModal schema)
        hotelName: hotelName.trim(),
        hotelBrand: hotelBrand.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        checkInDate: checkInDate || null,
        checkOutDate: checkOutDate || null,
        confirmationCode: confirmationCode.trim() || null,
        nightlyRate: nightlyRate ? Number(nightlyRate) : null,
        notes: notes.trim() || null,
        // For sorting in user travel view
        startDate: checkInDate || null,
        // Who created the record (audit)
        createdBy: currentUser?.uid || null,
        createdByName: currentUser?.name || currentUser?.displayName || null,
      });
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const canSave = hotelName.trim() && forUid && checkInDate && checkOutDate;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-lg my-8">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h3 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
            ADD LODGING
          </h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Crewmember */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              FOR CREWMEMBER
            </label>
            <select
              value={forUid}
              onChange={(e) => setForUid(e.target.value)}
              disabled={!isOpsOrAdmin && crewOptions.length === 1}
              className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {crewOptions.map((c) => (
                <option key={c.uid} value={c.uid}>{c.name}</option>
              ))}
              {isOpsOrAdmin && (
                <optgroup label="Other crew">
                  {users
                    .filter((u) => u.approved !== false && !crewOptions.find((c) => c.uid === u.uid))
                    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                    .map((u) => (
                      <option key={u.uid} value={u.uid}>{u.name} ({u.role})</option>
                    ))}
                </optgroup>
              )}
            </select>
          </div>

          {/* Hotel name + brand */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              HOTEL NAME *
            </label>
            <input
              type="text"
              value={hotelName}
              onChange={(e) => setHotelName(e.target.value)}
              placeholder="e.g. Hilton Garden Inn"
              className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </div>
          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              BRAND (optional)
            </label>
            <input
              type="text"
              value={hotelBrand}
              onChange={(e) => setHotelBrand(e.target.value)}
              placeholder="e.g. Hilton"
              className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CITY
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              />
            </div>
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                STATE
              </label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                maxLength={2}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CHECK-IN *
              </label>
              <input
                type="date"
                value={checkInDate}
                onChange={(e) => setCheckInDate(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              />
            </div>
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CHECK-OUT *
              </label>
              <input
                type="date"
                value={checkOutDate}
                onChange={(e) => setCheckOutDate(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          {/* Conf # + rate */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CONFIRMATION #
              </label>
              <input
                type="text"
                value={confirmationCode}
                onChange={(e) => setConfirmationCode(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 font-mono"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              />
            </div>
            <div>
              <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                NIGHTLY RATE ($)
              </label>
              <input
                type="number"
                value={nightlyRate}
                onChange={(e) => setNightlyRate(e.target.value)}
                min="0"
                step="0.01"
                className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              NOTES
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Special requests, room type, etc."
              className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
            />
          </div>

          {error && (
            <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 text-sm font-medium tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            {saving ? <Loader2 className="w-4 h-4 inline-block mr-1 animate-spin" /> : null}
            {saving ? 'SAVING...' : 'SAVE'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// FIND HOTELS MODAL  (DEMO — mock data; swap rapid-mock.js for real)
// ====================================================================

function FindHotelsModal({ trip, currentUser, users, isOpsOrAdmin, onClose }) {
  // Modal has three steps:
  //   'search'  — entry: airport + dates + crewmember picker
  //   'results' — list of hotels matching search
  //   'detail'  — picked one hotel: shows rooms + rate options
  //   'success' — booking complete, shows confirmation
  const [step, setStep] = useState('search');

  // Search params — pre-filled from trip context
  const tripDate = trip.start ? new Date(trip.start) : new Date();
  const defaultCheckIn = tripDate.toISOString().slice(0, 10);
  const defaultCheckOut = new Date(tripDate.getTime() + 86400000).toISOString().slice(0, 10);
  const [airportCode, setAirportCode] = useState(trip.info?.to || '');
  const [checkInDate, setCheckInDate] = useState(defaultCheckIn);
  const [checkOutDate, setCheckOutDate] = useState(defaultCheckOut);

  // Crewmember picker — same logic as AddLodgingModal
  const crewOptions = (() => {
    const opts = [];
    const seen = new Set();
    const tryAddByName = (name) => {
      if (!name) return;
      const u = users.find((x) => x.name === name || x.displayName === name);
      if (u && !seen.has(u.uid)) {
        opts.push({ uid: u.uid, name: u.name || u.displayName });
        seen.add(u.uid);
      }
    };
    tryAddByName(trip.info?.pic);
    tryAddByName(trip.info?.sic);
    if (currentUser && !seen.has(currentUser.uid)) {
      opts.push({ uid: currentUser.uid, name: currentUser.name || currentUser.displayName || 'Me' });
    }
    return opts;
  })();
  const [forUid, setForUid] = useState(crewOptions[0]?.uid || currentUser?.uid || '');

  // Results + detail state
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [selectedRooms, setSelectedRooms] = useState([]);
  const [booking, setBooking] = useState(false);
  const [bookingResult, setBookingResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleSearch() {
    setSearching(true);
    setError(null);
    try {
      const data = await searchProperties({ airportCode, checkInDate, checkOutDate });
      setResults(data.properties || []);
      setStep('results');
    } catch (e) {
      setError(e.message || 'Search failed');
    } finally {
      setSearching(false);
    }
  }

  async function handleSelectProperty(property) {
    setSelectedProperty(property);
    setSearching(true);
    setError(null);
    try {
      const data = await getPropertyDetail(property.property_id, { checkInDate, checkOutDate });
      setSelectedRooms(data.rooms || []);
      setStep('detail');
    } catch (e) {
      setError(e.message || 'Failed to load hotel details');
    } finally {
      setSearching(false);
    }
  }

  async function handleBookRoom(room, rate) {
    setBooking(true);
    setError(null);
    try {
      const result = await bookRoom({
        propertyId: selectedProperty.property_id,
        roomId: room.room_id,
        rateId: rate.rate_id,
        guests: [{ first_name: 'Crew', last_name: 'Member', occupants: 1 }],
        dates: { checkIn: checkInDate, checkOut: checkOutDate },
      });
      if (!result.ok) {
        setError(result.error || 'Booking failed');
        return;
      }
      // Save the booking to Firestore — same data path as the manual
      // AddLodgingModal, so the new booking appears in the LODGING list
      // immediately. Conf number is prefixed DEMO- so it's clear at a
      // glance which bookings came from mock data.
      const { saveBooking, newBookingId } = await import('./firebase-travel.js');
      const id = newBookingId('hotel');
      const addr = selectedProperty.address || {};
      await saveBooking({
        id,
        type: 'hotel',
        tripUid: trip.uid,
        tripContext: {
          tail: trip.info?.tail || null,
          from: trip.info?.from || null,
          to: trip.info?.to || null,
          startDate: trip.start ? new Date(trip.start).toISOString() : null,
        },
        userUid: forUid,
        hotelName: selectedProperty.name,
        hotelBrand: selectedProperty.brand || null,
        city: addr.city || null,
        state: addr.state_province_code || null,
        checkInDate,
        checkOutDate,
        confirmationCode: result.confirmation_code,
        nightlyRate: rate.nightly_rate?.request_currency?.value || null,
        notes: `${room.room_name} · ${rate.refundable ? 'Refundable' : 'Non-refundable'} · ${rate.meal_plan || ''}`.trim(),
        // Tag fields so we know this came from the search flow + which mock IDs
        source: 'rapid-search',
        sourceDemo: true,
        rapidPropertyId: selectedProperty.property_id,
        rapidRoomId: room.room_id,
        rapidRateId: rate.rate_id,
        startDate: checkInDate,
        createdBy: currentUser?.uid || null,
        createdByName: currentUser?.name || currentUser?.displayName || null,
      });
      setBookingResult({ ...result, room, rate });
      setStep('success');
    } catch (e) {
      setError(e.message || 'Failed to save booking');
    } finally {
      setBooking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-slate-900 border-2 border-amber-500/60 w-full max-w-3xl my-8">
        {/* Demo banner — runs across the top of EVERY step so the user
            never loses sight of what mode they're in. */}
        {DEMO_MODE && (
          <div className="bg-amber-500/20 border-b border-amber-500/40 px-4 py-2 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0" />
            <span className="text-xs text-amber-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              DEMO MODE — NO REAL BOOKINGS WILL BE MADE. Hotels and prices are mock data for testing the UI.
            </span>
          </div>
        )}

        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-3">
            {step !== 'search' && (
              <button
                onClick={() => {
                  if (step === 'success') { onClose(); return; }
                  if (step === 'detail') setStep('results');
                  else if (step === 'results') setStep('search');
                }}
                className="text-slate-500 hover:text-slate-200"
                title="Back"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            <h3 className="text-lg tracking-wider" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              {step === 'search' && 'FIND HOTELS'}
              {step === 'results' && `${results.length} HOTELS NEAR ${airportCode.toUpperCase()}`}
              {step === 'detail' && (selectedProperty?.name || 'HOTEL DETAILS')}
              {step === 'success' && 'BOOKING CONFIRMED (DEMO)'}
            </h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 mb-3">
              {error}
            </div>
          )}

          {/* STEP: SEARCH */}
          {step === 'search' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    AIRPORT
                  </label>
                  <input
                    type="text"
                    value={airportCode}
                    onChange={(e) => setAirportCode(e.target.value.toUpperCase())}
                    placeholder="e.g. FXE or CYYZ"
                    className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 font-mono"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  />
                </div>
                <div>
                  <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    FOR
                  </label>
                  <select
                    value={forUid}
                    onChange={(e) => setForUid(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    {crewOptions.map((c) => (
                      <option key={c.uid} value={c.uid}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    CHECK-IN
                  </label>
                  <input
                    type="date"
                    value={checkInDate}
                    onChange={(e) => setCheckInDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  />
                </div>
                <div>
                  <label className="text-[10px] tracking-widest text-slate-400 block mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    CHECK-OUT
                  </label>
                  <input
                    type="date"
                    value={checkOutDate}
                    onChange={(e) => setCheckOutDate(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                  />
                </div>
              </div>
            </div>
          )}

          {/* STEP: RESULTS */}
          {step === 'results' && (
            <div className="space-y-2">
              {results.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">
                  No hotels found near {airportCode.toUpperCase()}.
                  <div className="text-xs text-slate-600 mt-1">
                    (Demo data covers a limited set of airports.)
                  </div>
                </div>
              ) : (
                results.map((p) => (
                  <button
                    key={p.property_id}
                    onClick={() => handleSelectProperty(p)}
                    disabled={searching}
                    className="w-full text-left bg-slate-800/50 hover:bg-slate-800 border border-slate-700 p-3 flex gap-3 disabled:opacity-50"
                  >
                    {p.images?.[0]?.url && (
                      <img src={p.images[0].url} alt={p.name} className="w-20 h-20 object-cover rounded shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] tracking-widest text-amber-300 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                        {(p.brand || 'HOTEL').toUpperCase()}
                      </div>
                      <div className="text-base text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                        {p.name}
                      </div>
                      <div className="text-xs text-slate-400 mt-0.5">
                        {p.address?.line_1}{p.address?.city ? `, ${p.address.city}` : ''}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs">
                        <span className="flex items-center gap-1 text-amber-300">
                          <Star className="w-3 h-3 fill-current" />
                          {p.star_rating}
                        </span>
                        <span className="text-slate-500">·</span>
                        <span className="text-slate-300">{p.guest_rating}/5 guest rating</span>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {/* STEP: DETAIL */}
          {step === 'detail' && selectedProperty && (
            <div className="space-y-4">
              {selectedProperty.images?.[0]?.url && (
                <img src={selectedProperty.images[0].url} alt={selectedProperty.name} className="w-full h-48 object-cover rounded" />
              )}
              <div className="text-sm text-slate-300">
                {selectedProperty.address?.line_1}, {selectedProperty.address?.city}, {selectedProperty.address?.state_province_code}
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedProperty.amenities?.map((a, i) => (
                  <span key={i} className="text-[10px] text-slate-300 bg-slate-800 border border-slate-700 px-2 py-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                    {a}
                  </span>
                ))}
              </div>

              <div className="space-y-2">
                <h4 className="text-sm tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  AVAILABLE ROOMS
                </h4>
                {selectedRooms.map((room) => (
                  <div key={room.room_id} className="border border-slate-700 p-3">
                    <div className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                      {room.room_name}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Sleeps {room.max_occupancy?.total} ·{' '}
                      {room.bed_groups?.[0]?.configuration?.map(c => `${c.quantity} ${c.type}`).join(', ')}
                    </div>
                    <div className="mt-2 space-y-1">
                      {room.rates.map((rate) => (
                        <button
                          key={rate.rate_id}
                          onClick={() => handleBookRoom(room, rate)}
                          disabled={booking}
                          className="w-full flex items-center justify-between bg-slate-800/60 hover:bg-amber-500/10 border border-slate-700 hover:border-amber-500/40 px-3 py-2 text-left disabled:opacity-50"
                        >
                          <div>
                            <div className="text-xs text-slate-300">
                              {rate.refundable ? 'Refundable' : 'Non-refundable'}{rate.meal_plan ? ` · ${rate.meal_plan}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <div className="text-base text-slate-100 tabular-nums" style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                                ${rate.nightly_rate?.request_currency?.value}
                              </div>
                              <div className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                /night
                              </div>
                            </div>
                            <span className="text-amber-300 text-xs tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                              {booking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'BOOK'}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP: SUCCESS */}
          {step === 'success' && bookingResult && (
            <div className="space-y-4">
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-4">
                <div className="text-sm text-emerald-200" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                  Demo booking saved
                </div>
                <div className="text-xs text-emerald-300/80 mt-1">
                  This booking has been recorded in the trip's lodging list for tracking purposes. No real reservation was created. When live Rapid API access is configured, this same flow will create actual bookings.
                </div>
              </div>
              <div className="bg-slate-800/60 border border-slate-700 p-4 space-y-2">
                <div>
                  <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>HOTEL</div>
                  <div className="text-sm text-slate-100">{bookingResult.property.name}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>CONFIRMATION</div>
                  <div className="text-sm font-mono text-slate-100" style={{ fontFamily: 'JetBrains Mono, monospace' }}>{bookingResult.confirmation_code}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>ROOM</div>
                  <div className="text-sm text-slate-100">{bookingResult.room.room_name} · ${bookingResult.rate.nightly_rate?.request_currency?.value}/night</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 flex items-center justify-end gap-2">
          {step === 'search' && (
            <>
              <button
                onClick={onClose}
                disabled={searching}
                className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                CANCEL
              </button>
              <button
                onClick={handleSearch}
                disabled={!airportCode || !checkInDate || !checkOutDate || searching}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 text-sm font-medium tracking-widest"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                {searching ? <Loader2 className="w-4 h-4 inline-block mr-1 animate-spin" /> : <Search className="w-4 h-4 inline-block mr-1 -mt-0.5" />}
                {searching ? 'SEARCHING...' : 'SEARCH'}
              </button>
            </>
          )}
          {step === 'success' && (
            <button
              onClick={onClose}
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-medium tracking-widest"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              DONE
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
