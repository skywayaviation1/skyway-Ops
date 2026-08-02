// Lodging.jsx — trip crew lodging + IATA commission hotel booking.
//
// Surfaces:
//   1. Trip lodging list (travel-bookings where tripUid matches)
//   2. Full booking window: search → results → rooms → checkout → confirm
//   3. Manual add (outside-app reservations)
//
// Commission: agency IATA is stored in app-config/lodging. Rates show
// Expedia marketing_fee (live Rapid) or an estimated % (demo / fallback).

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Hotel, Plane, Plus, Loader2, X, Search, Star, AlertTriangle,
  ChevronLeft, DollarSign, ExternalLink, Trash2, Shield,
} from 'lucide-react';
import {
  Button, EmptyState, StatusChip, Spinner, cx, notify,
} from './ui.jsx';
import {
  searchHotels, getHotelDetail, bookHotel, getHotelApiStatus,
} from './hotel-api.js';
import {
  subscribeToLodgingConfig, buildTaapSearchUrl, DEFAULT_LODGING_CONFIG,
} from './firebase-lodging.js';

export default function Lodging({ trip, currentUser, users = [] }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showBook, setShowBook] = useState(false);
  const [lodgingConfig, setLodgingConfig] = useState(DEFAULT_LODGING_CONFIG);
  const [apiStatus, setApiStatus] = useState(null);

  useEffect(() => {
    if (!trip?.uid) return undefined;
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
    return () => { cancelled = true; try { unsub(); } catch (_) { /* ignore */ } };
  }, [trip?.uid]);

  useEffect(() => {
    const unsub = subscribeToLodgingConfig(setLodgingConfig);
    getHotelApiStatus().then(setApiStatus).catch(() => {});
    return () => { try { unsub(); } catch (_) { /* ignore */ } };
  }, []);

  const lookupUser = (uid) => {
    const u = users.find((x) => x.uid === uid || x.id === uid);
    return u?.name || u?.displayName || 'Unknown';
  };

  const isOpsOrAdmin = ['ops', 'admin'].includes(currentUser?.role);
  const iata = lodgingConfig.agencyIata;
  const commissionTotal = useMemo(() => bookings.reduce((sum, b) => {
    const n = Number(b.commissionAmount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0), [bookings]);

  async function handleDelete(booking) {
    if (!isOpsOrAdmin && booking.userUid !== currentUser?.uid) return;
    if (!window.confirm(`Remove lodging record ${booking.confirmationCode || booking.hotelName || ''}?`)) return;
    try {
      const { deleteBooking } = await import('./firebase-travel.js');
      await deleteBooking(booking.id);
      notify.success('Lodging removed');
    } catch (e) {
      notify.error(e.message || 'Could not delete');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold text-content">Crew lodging</h2>
          <p className="mt-1 text-2xs text-content-muted">
            Book commissionable hotels under Skyway’s IATA, or log a reservation made outside the app.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {iata ? (
            <StatusChip tone="accent" icon={Shield}>IATA {iata}</StatusChip>
          ) : (
            <StatusChip tone="warning" icon={AlertTriangle}>Set IATA in Settings</StatusChip>
          )}
          {apiStatus?.live ? (
            <StatusChip tone="success">Live Rapid</StatusChip>
          ) : (
            <StatusChip tone="warning">Demo rates</StatusChip>
          )}
          <Button variant="outline" size="sm" icon={Plus} onClick={() => setShowAdd(true)}>
            Log booking
          </Button>
          <Button variant="primary" size="sm" icon={Search} onClick={() => setShowBook(true)}>
            Book hotel
          </Button>
        </div>
      </div>

      {!iata && (
        <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2.5 text-2xs text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Add your agency IATA number in Settings → Lodging &amp; IATA so bookings are tagged for commission.
            {apiStatus?.live ? '' : ' Demo inventory is available now; connect Expedia Rapid on Vercel for live rates.'}
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-3 rounded-xl border border-edge bg-surface-sunken px-3 py-2.5 font-mono text-2xs text-content-muted">
        <span>
          <span className="text-content-subtle">Trip</span>{' '}
          <span className="text-content">{trip.info?.tail || '?'}</span>
        </span>
        <span className="text-content-subtle">·</span>
        <span className="text-content">{trip.info?.from} → {trip.info?.to}</span>
        <span className="text-content-subtle">·</span>
        <span className="text-content">
          {trip.start ? new Date(trip.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
        </span>
        {commissionTotal > 0 && (
          <>
            <span className="text-content-subtle">·</span>
            <span className="text-accent">
              Est. commission ${commissionTotal.toFixed(2)}
            </span>
          </>
        )}
      </div>

      {loading ? (
        <Spinner label="Loading lodging…" />
      ) : bookings.length === 0 ? (
        <EmptyState
          icon={Hotel}
          title="No lodging booked yet"
          description="Book a hotel under your IATA for commission, or log a confirmation from Marriott / another channel."
          action={(
            <Button variant="primary" size="sm" icon={Search} onClick={() => setShowBook(true)}>
              Book hotel
            </Button>
          )}
        />
      ) : (
        <div className="space-y-3">
          {bookings.map((b) => (
            <LodgingRow
              key={b.id}
              booking={b}
              crewName={lookupUser(b.userUid)}
              canDelete={isOpsOrAdmin || b.userUid === currentUser?.uid}
              onDelete={() => handleDelete(b)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddLodgingModal
          trip={trip}
          currentUser={currentUser}
          users={users}
          isOpsOrAdmin={isOpsOrAdmin}
          lodgingConfig={lodgingConfig}
          onClose={() => setShowAdd(false)}
        />
      )}

      {showBook && (
        <HotelBookingWindow
          trip={trip}
          currentUser={currentUser}
          users={users}
          isOpsOrAdmin={isOpsOrAdmin}
          lodgingConfig={lodgingConfig}
          apiStatus={apiStatus}
          onClose={() => setShowBook(false)}
        />
      )}
    </div>
  );
}

function LodgingRow({ booking, crewName, canDelete, onDelete }) {
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(`${d}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return d;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const nights = (() => {
    if (!booking.checkInDate || !booking.checkOutDate) return null;
    const diff = (new Date(booking.checkOutDate) - new Date(booking.checkInDate)) / 86400000;
    return Math.round(diff);
  })();
  const isFlight = booking.type === 'flight';
  const Icon = isFlight ? Plane : Hotel;
  const commission = Number(booking.commissionAmount);

  return (
    <div className="rounded-xl border border-edge bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="rounded-lg border border-edge bg-surface-raised p-2">
            <Icon className="h-5 w-5 text-content-muted" />
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-semibold tracking-wide text-content-subtle">
              {isFlight ? 'FLIGHT' : (booking.hotelBrand || 'HOTEL').toUpperCase()}
              {booking.sourceDemo ? ' · DEMO' : ''}
              {booking.agencyIata ? ` · IATA ${booking.agencyIata}` : ''}
            </div>
            <h3 className="mt-0.5 truncate text-base font-semibold text-content">
              {isFlight
                ? `${booking.airline || ''} ${booking.flightNumber || ''}`.trim() || '(flight)'
                : (booking.hotelName || '(unnamed)')}
            </h3>
            {!isFlight && booking.city && (
              <p className="mt-0.5 text-2xs text-content-muted">
                {booking.city}{booking.state ? `, ${booking.state}` : ''}
              </p>
            )}
            <p className="mt-2 text-2xs text-content-muted">
              For <span className="text-content">{crewName}</span>
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[10px] text-content-subtle">CONF</div>
          <div className="font-mono text-sm font-semibold text-content">
            {booking.confirmationCode || '—'}
          </div>
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="mt-2 inline-flex items-center gap-1 text-2xs text-content-subtle hover:text-danger"
              title="Remove record"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-3 border-t border-edge pt-3 font-mono text-2xs">
        <div>
          <div className="text-content-subtle">
            {isFlight ? 'Depart' : 'Check-in → check-out'}
          </div>
          <div className="mt-0.5 text-content">
            {isFlight
              ? fmtDate(booking.departDate)
              : (
                <>
                  {fmtDate(booking.checkInDate)} → {fmtDate(booking.checkOutDate)}
                  {nights != null && (
                    <span className="ml-2 text-content-subtle">
                      ({nights} night{nights === 1 ? '' : 's'})
                    </span>
                  )}
                </>
              )}
          </div>
        </div>
        <div className="text-right">
          {booking.nightlyRate != null && (
            <div className="text-content">${Number(booking.nightlyRate).toFixed(0)}/night</div>
          )}
          {Number.isFinite(commission) && commission > 0 && (
            <div className="text-accent">
              Commission ${commission.toFixed(2)}
              {booking.commissionPct != null ? ` · ${booking.commissionPct}%` : ''}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* =========================================================================
   FULL HOTEL BOOKING WINDOW
   ========================================================================= */

function HotelBookingWindow({
  trip, currentUser, users, isOpsOrAdmin, lodgingConfig, apiStatus, onClose,
}) {
  const tripDate = trip.start ? new Date(trip.start) : new Date();
  const defaultCheckIn = tripDate.toISOString().slice(0, 10);
  const defaultCheckOut = new Date(tripDate.getTime() + 86400000).toISOString().slice(0, 10);

  const crewOptions = useMemo(() => buildCrewOptions(trip, currentUser, users), [trip, currentUser, users]);

  const [step, setStep] = useState('search'); // search|results|detail|checkout|success
  const [airportCode, setAirportCode] = useState(trip.info?.to || '');
  const [checkInDate, setCheckInDate] = useState(defaultCheckIn);
  const [checkOutDate, setCheckOutDate] = useState(defaultCheckOut);
  const [forUid, setForUid] = useState(crewOptions[0]?.uid || currentUser?.uid || '');
  const [occupancyAdults, setOccupancyAdults] = useState(1);

  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [demoMode, setDemoMode] = useState(!apiStatus?.live);
  const [statusMessage, setStatusMessage] = useState(apiStatus?.message || '');
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [selectedRooms, setSelectedRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [selectedRate, setSelectedRate] = useState(null);
  const [booking, setBooking] = useState(false);
  const [bookingResult, setBookingResult] = useState(null);
  const [error, setError] = useState(null);

  const guestUser = users.find((u) => u.uid === forUid) || currentUser;
  const [givenName, setGivenName] = useState(() => splitName(guestUser?.name).given);
  const [familyName, setFamilyName] = useState(() => splitName(guestUser?.name).family);
  const [email, setEmail] = useState(currentUser?.email || '');
  const [phone, setPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpMonth, setCardExpMonth] = useState('');
  const [cardExpYear, setCardExpYear] = useState('');
  const [cardCvv, setCardCvv] = useState('');

  useEffect(() => {
    const parts = splitName(guestUser?.name);
    setGivenName(parts.given);
    setFamilyName(parts.family);
  }, [forUid]); // eslint-disable-line react-hooks/exhaustive-deps

  const nights = useMemo(() => {
    const a = new Date(`${checkInDate}T00:00:00`).getTime();
    const b = new Date(`${checkOutDate}T00:00:00`).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
    return Math.max(1, Math.round((b - a) / 86400000));
  }, [checkInDate, checkOutDate]);

  const iata = lodgingConfig.agencyIata;
  const taapUrl = buildTaapSearchUrl(lodgingConfig, {
    destination: airportCode,
    checkIn: checkInDate,
    checkOut: checkOutDate,
  });

  async function handleSearch() {
    setSearching(true);
    setError(null);
    try {
      const data = await searchHotels({
        airportCode,
        checkInDate,
        checkOutDate,
        occupancyAdults,
        agencyIata: iata,
        defaultCommissionPct: lodgingConfig.defaultCommissionPct,
      });
      setResults(data.properties || []);
      setDemoMode(!!data.demo);
      setStatusMessage(data.message || '');
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
      const data = await getHotelDetail({
        propertyId: property.property_id,
        checkInDate,
        checkOutDate,
        occupancyAdults,
        defaultCommissionPct: lodgingConfig.defaultCommissionPct,
      });
      setSelectedProperty(data.property || property);
      setSelectedRooms(data.rooms || property.rooms || []);
      setDemoMode(!!data.demo);
      setStep('detail');
    } catch (e) {
      setError(e.message || 'Failed to load hotel');
    } finally {
      setSearching(false);
    }
  }

  function goCheckout(room, rate) {
    setSelectedRoom(room);
    setSelectedRate(rate);
    setStep('checkout');
  }

  async function handleConfirmBook() {
    if (!selectedProperty || !selectedRoom || !selectedRate) return;
    if (!givenName.trim() || !familyName.trim()) {
      setError('Guest first and last name are required');
      return;
    }
    setBooking(true);
    setError(null);
    try {
      const payment = (!demoMode && cardNumber) ? {
        card_number: cardNumber,
        security_code: cardCvv,
        expiration_month: cardExpMonth,
        expiration_year: cardExpYear,
      } : undefined;

      const result = await bookHotel({
        propertyId: selectedProperty.property_id,
        roomId: selectedRoom.room_id,
        rateId: selectedRate.rate_id,
        checkInDate,
        checkOutDate,
        guests: [{ given_name: givenName.trim(), family_name: familyName.trim() }],
        email: email.trim(),
        phone: phone.trim(),
        agencyIata: iata,
        priceCheckHref: selectedRate.price_check_href,
        bedGroupId: selectedRate.bed_group_id,
        payment,
      });

      if (!result.ok) {
        setError(result.error || 'Booking failed');
        return;
      }

      const commissionAmount = Number(selectedRate.marketing_fee?.request_currency?.value || 0);
      const nightly = Number(selectedRate.nightly_rate?.request_currency?.value || 0);
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
        address: addr.line_1 || null,
        checkInDate,
        checkOutDate,
        confirmationCode: result.confirmation_code,
        nightlyRate: nightly || null,
        totalRate: Number(selectedRate.total_in_request_currency?.request_currency?.value || 0) || null,
        commissionAmount: commissionAmount || null,
        commissionPct: selectedRate.commission_pct || lodgingConfig.defaultCommissionPct || null,
        agencyIata: iata || null,
        notes: [
          selectedRoom.room_name,
          selectedRate.refundable ? 'Refundable' : 'Non-refundable',
          selectedRate.meal_plan,
          result.demo ? 'DEMO — not a real reservation' : 'Expedia Rapid',
        ].filter(Boolean).join(' · '),
        source: result.demo ? 'rapid-demo' : 'rapid-live',
        sourceDemo: !!result.demo,
        rapidPropertyId: selectedProperty.property_id,
        rapidRoomId: selectedRoom.room_id,
        rapidRateId: selectedRate.rate_id,
        itineraryId: result.itinerary_id || null,
        startDate: checkInDate,
        createdBy: currentUser?.uid || null,
        createdByName: currentUser?.name || currentUser?.displayName || null,
      });

      setBookingResult({ ...result, room: selectedRoom, rate: selectedRate, property: selectedProperty, commissionAmount });
      setStep('success');
      notify.success(result.demo ? 'Demo lodging saved' : 'Hotel booked');
    } catch (e) {
      setError(e.message || 'Failed to book');
    } finally {
      setBooking(false);
    }
  }

  const title = {
    search: 'Book hotel',
    results: `${results.length} hotel${results.length === 1 ? '' : 's'} near ${airportCode.toUpperCase()}`,
    detail: selectedProperty?.name || 'Hotel',
    checkout: 'Confirm booking',
    success: bookingResult?.demo ? 'Demo booking saved' : 'Booking confirmed',
  }[step];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-stretch justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex h-full w-full max-w-3xl flex-col overflow-hidden border border-edge bg-surface shadow-overlay sm:h-auto sm:max-h-[92vh] sm:rounded-xl">
        {(demoMode || !iata) && (
          <div className="flex items-start gap-2 border-b border-warning-border bg-warning-soft px-4 py-2.5 text-2xs text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {demoMode
                ? 'Demo inventory — rates and confirmations are not real. '
                : ''}
              {iata
                ? `Booking under IATA ${iata}${lodgingConfig.agencyName ? ` · ${lodgingConfig.agencyName}` : ''}.`
                : 'No IATA on file — add it in Settings so commission is attributed to Skyway.'}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-b border-edge px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {step !== 'search' && (
              <button
                type="button"
                className="rounded p-1 text-content-muted hover:bg-surface-raised hover:text-content"
                onClick={() => {
                  if (step === 'success') { onClose(); return; }
                  if (step === 'checkout') setStep('detail');
                  else if (step === 'detail') setStep('results');
                  else if (step === 'results') setStep('search');
                }}
                aria-label="Back"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-content">{title}</h3>
              <p className="font-mono text-[10px] text-content-subtle">
                {checkInDate} → {checkOutDate} · {nights} night{nights === 1 ? '' : 's'}
                {iata ? ` · IATA ${iata}` : ''}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-content-muted hover:text-content" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-2xs text-danger">
              {error}
            </div>
          )}
          {statusMessage && step === 'results' && (
            <p className="mb-3 text-2xs text-content-muted">{statusMessage}</p>
          )}

          {step === 'search' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Airport">
                  <input
                    value={airportCode}
                    onChange={(e) => setAirportCode(e.target.value.toUpperCase())}
                    placeholder="FXE"
                    className={inputClass}
                  />
                </Field>
                <Field label="For crew">
                  <select value={forUid} onChange={(e) => setForUid(e.target.value)} className={inputClass}>
                    {crewOptions.map((c) => (
                      <option key={c.uid} value={c.uid}>{c.name}</option>
                    ))}
                    {isOpsOrAdmin && users
                      .filter((u) => u.approved !== false && !crewOptions.find((c) => c.uid === u.uid))
                      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                      .map((u) => (
                        <option key={u.uid} value={u.uid}>{u.name}</option>
                      ))}
                  </select>
                </Field>
                <Field label="Check-in">
                  <input type="date" value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Check-out">
                  <input type="date" value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Adults">
                  <select value={occupancyAdults} onChange={(e) => setOccupancyAdults(Number(e.target.value))} className={inputClass}>
                    {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>
              </div>

              <div className="rounded-xl border border-edge bg-surface-sunken p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-content">
                  <DollarSign className="h-4 w-4 text-accent" />
                  Commission under IATA
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-content-muted">
                  {iata
                    ? `Rates below include estimated marketing fee / commission for agency IATA ${iata}. Default estimate ${lodgingConfig.defaultCommissionPct}% when Expedia doesn’t return a fee.`
                    : `Set your IATA in Settings to attribute commission. Default estimate ${lodgingConfig.defaultCommissionPct}% will still show on rates.`}
                </p>
                <a
                  href={taapUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-2xs font-semibold text-accent hover:underline"
                >
                  Open Expedia TAAP portal <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          )}

          {step === 'results' && (
            <div className="space-y-2">
              {results.length === 0 ? (
                <EmptyState
                  icon={Hotel}
                  title={`No hotels near ${airportCode.toUpperCase()}`}
                  description="Try another airport code, or open TAAP to shop the full Expedia inventory."
                  action={(
                    <a href={taapUrl} target="_blank" rel="noreferrer">
                      <Button variant="outline" size="sm" icon={ExternalLink}>Open TAAP</Button>
                    </a>
                  )}
                />
              ) : results.map((p) => {
                const nightly = p.from_nightly?.request_currency?.value;
                const commission = p.from_commission?.request_currency?.value;
                return (
                  <button
                    key={p.property_id}
                    type="button"
                    onClick={() => handleSelectProperty(p)}
                    disabled={searching}
                    className="flex w-full gap-3 rounded-xl border border-edge bg-surface-raised p-3 text-left transition-colors hover:border-accent-border disabled:opacity-50"
                  >
                    {p.images?.[0]?.url ? (
                      <img src={p.images[0].url} alt="" className="h-20 w-20 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-surface-sunken">
                        <Hotel className="h-6 w-6 text-content-subtle" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[10px] font-semibold text-accent">
                        {(p.brand || 'Hotel').toUpperCase()}
                      </div>
                      <div className="truncate text-sm font-semibold text-content">{p.name}</div>
                      <div className="mt-0.5 truncate text-2xs text-content-muted">
                        {[p.address?.line_1, p.address?.city].filter(Boolean).join(', ')}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs">
                        {p.star_rating != null && (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <Star className="h-3 w-3 fill-current" /> {p.star_rating}
                          </span>
                        )}
                        {nightly != null && (
                          <span className="font-mono text-content">${Number(nightly).toFixed(0)}/night</span>
                        )}
                        {commission != null && (
                          <span className="font-mono text-accent">Est. commission ${Number(commission).toFixed(2)}</span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === 'detail' && selectedProperty && (
            <div className="space-y-4">
              {selectedProperty.images?.[0]?.url && (
                <img
                  src={selectedProperty.images[0].url}
                  alt=""
                  className="h-44 w-full rounded-xl object-cover"
                />
              )}
              <div>
                <p className="text-sm text-content-muted">
                  {[selectedProperty.address?.line_1, selectedProperty.address?.city, selectedProperty.address?.state_province_code]
                    .filter(Boolean).join(', ')}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(selectedProperty.amenities || []).slice(0, 8).map((a) => (
                    <span key={a} className="rounded border border-edge bg-surface-sunken px-2 py-1 text-[10px] text-content-muted">
                      {a}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-2xs font-semibold text-content-muted">Available rooms</h4>
                {selectedRooms.map((room) => (
                  <div key={room.room_id} className="rounded-xl border border-edge p-3">
                    <div className="text-sm font-semibold text-content">{room.room_name}</div>
                    <div className="mt-0.5 text-2xs text-content-subtle">
                      Sleeps {room.max_occupancy?.total || '—'}
                    </div>
                    <div className="mt-2 space-y-2">
                      {(room.rates || []).map((rate) => {
                        const nightly = rate.nightly_rate?.request_currency?.value;
                        const total = rate.total_in_request_currency?.request_currency?.value;
                        const commission = rate.marketing_fee?.request_currency?.value;
                        return (
                          <button
                            key={rate.rate_id}
                            type="button"
                            onClick={() => goCheckout(room, rate)}
                            className="flex w-full items-center justify-between gap-3 rounded-lg border border-edge bg-surface-sunken px-3 py-2.5 text-left transition-colors hover:border-accent-border"
                          >
                            <div className="min-w-0">
                              <div className="text-2xs text-content">
                                {rate.refundable ? 'Refundable' : 'Non-refundable'}
                                {rate.meal_plan ? ` · ${rate.meal_plan}` : ''}
                              </div>
                              {commission != null && (
                                <div className="mt-1 font-mono text-[11px] text-accent">
                                  Skyway commission ${Number(commission).toFixed(2)}
                                  {rate.commission_pct != null ? ` (${rate.commission_pct}%)` : ''}
                                </div>
                              )}
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="font-mono text-base font-semibold text-content">
                                ${Number(nightly || 0).toFixed(0)}
                              </div>
                              <div className="text-[10px] text-content-subtle">/night · ${Number(total || 0).toFixed(0)} total</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 'checkout' && selectedProperty && selectedRoom && selectedRate && (
            <div className="space-y-4">
              <div className="rounded-xl border border-edge bg-surface-sunken p-3">
                <div className="text-sm font-semibold text-content">{selectedProperty.name}</div>
                <div className="mt-1 text-2xs text-content-muted">
                  {selectedRoom.room_name} · {selectedRate.refundable ? 'Refundable' : 'Non-refundable'}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 font-mono text-2xs">
                  <div>
                    <div className="text-content-subtle">Stay total</div>
                    <div className="text-content">
                      ${Number(selectedRate.total_in_request_currency?.request_currency?.value || 0).toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-content-subtle">Est. commission</div>
                    <div className="text-accent">
                      ${Number(selectedRate.marketing_fee?.request_currency?.value || 0).toFixed(2)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Guest first name">
                  <input value={givenName} onChange={(e) => setGivenName(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Guest last name">
                  <input value={familyName} onChange={(e) => setFamilyName(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Email">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
                </Field>
                <Field label="Phone">
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="5551234567" className={inputClass} />
                </Field>
              </div>

              {!demoMode && (
                <div className="space-y-3 rounded-xl border border-edge p-3">
                  <div className="text-2xs font-semibold text-content-muted">
                    Corporate card (sent to Expedia — not stored in Skyway)
                  </div>
                  <Field label="Card number">
                    <input value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} inputMode="numeric" className={inputClass} autoComplete="off" />
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Exp month">
                      <input value={cardExpMonth} onChange={(e) => setCardExpMonth(e.target.value)} placeholder="MM" className={inputClass} />
                    </Field>
                    <Field label="Exp year">
                      <input value={cardExpYear} onChange={(e) => setCardExpYear(e.target.value)} placeholder="YYYY" className={inputClass} />
                    </Field>
                    <Field label="CVV">
                      <input value={cardCvv} onChange={(e) => setCardCvv(e.target.value)} className={inputClass} autoComplete="off" />
                    </Field>
                  </div>
                </div>
              )}

              {demoMode && (
                <p className="text-2xs text-content-muted">
                  Demo mode skips payment. The lodging record will be saved to this trip with a DEMO confirmation code and estimated commission.
                </p>
              )}
            </div>
          )}

          {step === 'success' && bookingResult && (
            <div className="space-y-4">
              <div className={cx(
                'rounded-xl border p-4',
                bookingResult.demo ? 'border-warning-border bg-warning-soft' : 'border-success-border bg-success-soft',
              )}>
                <div className={cx('text-sm font-semibold', bookingResult.demo ? 'text-warning' : 'text-success')}>
                  {bookingResult.demo ? 'Demo lodging recorded on this trip' : 'Reservation confirmed'}
                </div>
                <p className={cx('mt-1 text-2xs', bookingResult.demo ? 'text-warning' : 'text-success')}>
                  {bookingResult.demo
                    ? 'No real hotel reservation was created. Connect Expedia Rapid credentials to book live under your IATA.'
                    : 'Confirmation is on the trip lodging list and the crew member’s travel wallet.'}
                </p>
              </div>
              <div className="space-y-2 rounded-xl border border-edge p-4 text-sm">
                <Row label="Hotel" value={bookingResult.property.name} />
                <Row label="Confirmation" value={bookingResult.confirmation_code} mono />
                <Row label="Room" value={bookingResult.room.room_name} />
                <Row
                  label="Commission"
                  value={`$${Number(bookingResult.commissionAmount || bookingResult.rate.marketing_fee?.request_currency?.value || 0).toFixed(2)}`}
                  accent
                />
                {iata && <Row label="IATA" value={iata} mono />}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-4 py-3">
          {step === 'search' && (
            <>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button
                variant="primary"
                icon={Search}
                loading={searching}
                disabled={!airportCode || !checkInDate || !checkOutDate || searching}
                onClick={handleSearch}
              >
                {searching ? 'Searching…' : 'Search hotels'}
              </Button>
            </>
          )}
          {step === 'checkout' && (
            <>
              <Button variant="ghost" onClick={() => setStep('detail')} disabled={booking}>Back</Button>
              <Button variant="primary" loading={booking} disabled={booking} onClick={handleConfirmBook}>
                {booking ? 'Booking…' : (demoMode ? 'Save demo booking' : 'Book & earn commission')}
              </Button>
            </>
          )}
          {step === 'success' && (
            <Button variant="primary" onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* =========================================================================
   MANUAL ADD
   ========================================================================= */

function AddLodgingModal({ trip, currentUser, users, isOpsOrAdmin, lodgingConfig, onClose }) {
  const tripDate = trip.start ? new Date(trip.start) : new Date();
  const defaultCheckIn = tripDate.toISOString().slice(0, 10);
  const defaultCheckOut = new Date(tripDate.getTime() + 86400000).toISOString().slice(0, 10);
  const crewOptions = useMemo(() => buildCrewOptions(trip, currentUser, users), [trip, currentUser, users]);

  const [forUid, setForUid] = useState(crewOptions[0]?.uid || currentUser?.uid || '');
  const [hotelName, setHotelName] = useState('');
  const [hotelBrand, setHotelBrand] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [checkInDate, setCheckInDate] = useState(defaultCheckIn);
  const [checkOutDate, setCheckOutDate] = useState(defaultCheckOut);
  const [confirmationCode, setConfirmationCode] = useState('');
  const [nightlyRate, setNightlyRate] = useState('');
  const [commissionAmount, setCommissionAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [channel, setChannel] = useState('taap');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const { saveBooking, newBookingId } = await import('./firebase-travel.js');
      const id = newBookingId('hotel');
      const nightly = nightlyRate ? Number(nightlyRate) : null;
      let commission = commissionAmount ? Number(commissionAmount) : null;
      if (commission == null && nightly != null && lodgingConfig.defaultCommissionPct) {
        const nights = Math.max(1, Math.round((new Date(checkOutDate) - new Date(checkInDate)) / 86400000));
        commission = Math.round(nightly * nights * (lodgingConfig.defaultCommissionPct / 100) * 100) / 100;
      }
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
        hotelName: hotelName.trim(),
        hotelBrand: hotelBrand.trim() || null,
        city: city.trim() || null,
        state: state.trim() || null,
        checkInDate: checkInDate || null,
        checkOutDate: checkOutDate || null,
        confirmationCode: confirmationCode.trim() || null,
        nightlyRate: nightly,
        commissionAmount: commission,
        commissionPct: lodgingConfig.defaultCommissionPct || null,
        agencyIata: lodgingConfig.agencyIata || null,
        channel,
        notes: notes.trim() || null,
        source: 'manual',
        sourceDemo: false,
        startDate: checkInDate || null,
        createdBy: currentUser?.uid || null,
        createdByName: currentUser?.name || currentUser?.displayName || null,
      });
      notify.success('Lodging saved');
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const canSave = hotelName.trim() && forUid && checkInDate && checkOutDate;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-0 sm:items-center sm:p-4">
      <div className="flex min-h-screen w-full max-w-lg flex-col border border-edge bg-surface sm:min-h-0 sm:max-h-[90vh] sm:rounded-xl">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h3 className="text-base font-semibold text-content">Log lodging</h3>
          <button type="button" onClick={onClose} className="text-content-muted hover:text-content"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <Field label="For crewmember">
            <select value={forUid} onChange={(e) => setForUid(e.target.value)} className={inputClass}>
              {crewOptions.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}
              {isOpsOrAdmin && (
                <optgroup label="Other crew">
                  {users
                    .filter((u) => u.approved !== false && !crewOptions.find((c) => c.uid === u.uid))
                    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                    .map((u) => <option key={u.uid} value={u.uid}>{u.name}</option>)}
                </optgroup>
              )}
            </select>
          </Field>
          <Field label="Channel">
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputClass}>
              <option value="taap">Expedia TAAP (commission)</option>
              <option value="marriott">Marriott direct</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Hotel name *">
            <input value={hotelName} onChange={(e) => setHotelName(e.target.value)} className={inputClass} placeholder="Hilton Garden Inn" />
          </Field>
          <Field label="Brand">
            <input value={hotelBrand} onChange={(e) => setHotelBrand(e.target.value)} className={inputClass} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City"><input value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} /></Field>
            <Field label="State"><input value={state} onChange={(e) => setState(e.target.value)} maxLength={2} className={inputClass} /></Field>
            <Field label="Check-in *"><input type="date" value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} className={inputClass} /></Field>
            <Field label="Check-out *"><input type="date" value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} className={inputClass} /></Field>
            <Field label="Confirmation #"><input value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value)} className={inputClass} /></Field>
            <Field label="Nightly rate ($)"><input type="number" value={nightlyRate} onChange={(e) => setNightlyRate(e.target.value)} className={inputClass} /></Field>
            <Field label="Commission earned ($)">
              <input type="number" value={commissionAmount} onChange={(e) => setCommissionAmount(e.target.value)} className={inputClass} placeholder="Auto from %" />
            </Field>
          </div>
          <Field label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputClass} />
          </Field>
          {error && <div className="rounded border border-danger-border bg-danger-soft px-3 py-2 text-2xs text-danger">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-edge px-4 py-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ---- tiny helpers ---- */

const inputClass = 'mt-1 w-full rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-sm text-content outline-none focus:border-accent-border';

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-content-subtle">{label}</span>
      {children}
    </label>
  );
}

function Row({ label, value, mono, accent }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-2xs text-content-subtle">{label}</span>
      <span className={cx('text-sm', mono && 'font-mono', accent ? 'font-semibold text-accent' : 'text-content')}>{value}</span>
    </div>
  );
}

function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { given: 'Crew', family: 'Member' };
  if (parts.length === 1) return { given: parts[0], family: 'Crew' };
  return { given: parts[0], family: parts.slice(1).join(' ') };
}

function buildCrewOptions(trip, currentUser, users) {
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
}
