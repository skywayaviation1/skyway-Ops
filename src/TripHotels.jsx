// src/screens/TripHotels.jsx
// Trip Hotels module: pilots/ops/admin manage hotel bookings for trip overnights.
// - Marriott direct (pilot keeps points/elite nights)
// - Expedia TAAP (Skyway earns commission)
// Both shown side-by-side per the product decision.

import React, { useEffect, useMemo, useState } from "react";
import {
  getHotelBookingsForTrip,
  createHotelBookingRecord,
  addBookingToRecord,
  removeBookingFromRecord,
  markRecordNotNeeded,
  reopenRecord,
  buildMarriottUrl,
  buildTaapUrl,
} from "../firebase-hotels";

/**
 * Props:
 *   trip         - the trip object from your existing data model. Expected fields:
 *                    id, legs: [{ id, arrivalAirport, departureAirport, arrivalDate,
 *                                  departureDate, isOvernight, cityLabel?, crewIds? }]
 *                  If your trip shape is different, adjust deriveOvernights() below.
 *   currentUser  - { id, name, role: "pilot"|"sales"|"ops"|"admin" }
 *   crewOnTrip   - array of { id, name, role } for everyone assigned to this trip
 *                  (used to decide if currentUser is "a pilot on this trip")
 *   onClose      - optional callback to return to the trip detail view
 */
export default function TripHotels({ trip, currentUser, crewOnTrip = [], onClose }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const canEdit = useMemo(() => {
    if (!currentUser) return false;
    if (currentUser.role === "admin" || currentUser.role === "ops") return true;
    if (currentUser.role === "pilot") {
      return crewOnTrip.some((c) => c.id === currentUser.id);
    }
    return false;
  }, [currentUser, crewOnTrip]);

  // ---------- Load / sync ----------

  useEffect(() => {
    if (!trip?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const existing = await getHotelBookingsForTrip(trip.id);
        const overnights = deriveOvernights(trip);

        // Ensure a record exists for every overnight; create stubs if missing.
        const missing = overnights.filter(
          (o) => !existing.find((r) => r.legId === o.legId)
        );
        for (const o of missing) {
          await createHotelBookingRecord({
            tripId: trip.id,
            legId: o.legId,
            airportCode: o.airportCode,
            cityLabel: o.cityLabel,
            checkIn: o.checkIn,
            checkOut: o.checkOut,
            crewMemberIds: o.crewMemberIds,
            status: "needed",
          });
        }
        const refreshed =
          missing.length > 0 ? await getHotelBookingsForTrip(trip.id) : existing;
        if (!cancelled) setRecords(refreshed);
      } catch (e) {
        console.error(e);
        if (!cancelled) setError(e.message || "Failed to load hotels.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trip?.id]);

  const refresh = async () => {
    const refreshed = await getHotelBookingsForTrip(trip.id);
    setRecords(refreshed);
  };

  // ---------- Render ----------

  if (loading) {
    return (
      <div style={styles.wrap}>
        <Header trip={trip} onClose={onClose} />
        <div style={styles.muted}>Loading hotel bookings…</div>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <Header trip={trip} onClose={onClose} />

      {error && <div style={styles.error}>{error}</div>}

      {records.length === 0 && (
        <div style={styles.card}>
          <div style={styles.muted}>
            No overnights detected on this trip. If that's wrong, check the
            trip legs.
          </div>
        </div>
      )}

      {records.map((rec) => (
        <OvernightCard
          key={rec.id}
          record={rec}
          canEdit={canEdit}
          currentUser={currentUser}
          crewOnTrip={crewOnTrip}
          onRefresh={refresh}
        />
      ))}

      <PolicyFooter />
    </div>
  );
}

// =====================================================================
// Header
// =====================================================================

function Header({ trip, onClose }) {
  return (
    <div style={styles.header}>
      <div>
        <div style={styles.title}>Trip Hotels</div>
        <div style={styles.subtitle}>
          Trip {trip?.id || "—"}{" "}
          {trip?.tailNumber ? `• ${trip.tailNumber}` : ""}
        </div>
      </div>
      {onClose && (
        <button onClick={onClose} style={styles.btnGhost}>
          ← Back to Trip
        </button>
      )}
    </div>
  );
}

// =====================================================================
// Per-overnight card
// =====================================================================

function OvernightCard({ record, canEdit, currentUser, crewOnTrip, onRefresh }) {
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [showOptOut, setShowOptOut] = useState(false);

  const marriottUrl = buildMarriottUrl({
    airportCode: record.airportCode,
    cityLabel: record.cityLabel,
    checkIn: record.checkIn,
    checkOut: record.checkOut,
    rooms: Math.max(1, record.crewMemberIds?.length || 1),
    adults: 1,
  });
  const taapUrl = buildTaapUrl({
    airportCode: record.airportCode,
    cityLabel: record.cityLabel,
    checkIn: record.checkIn,
    checkOut: record.checkOut,
  });

  const handleOptOut = async (reason) => {
    await markRecordNotNeeded(record.id, reason);
    setShowOptOut(false);
    onRefresh();
  };

  const handleReopen = async () => {
    await reopenRecord(record.id);
    onRefresh();
  };

  const handleRemoveBooking = async (bookingId) => {
    if (!window.confirm("Remove this booking entry?")) return;
    await removeBookingFromRecord(record.id, bookingId);
    onRefresh();
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHeaderRow}>
        <div>
          <div style={styles.cardTitle}>
            {record.cityLabel || record.airportCode || "Overnight"}
          </div>
          <div style={styles.cardSubtitle}>
            {formatDateRange(record.checkIn, record.checkOut)} •{" "}
            {nightsBetween(record.checkIn, record.checkOut)} night
            {nightsBetween(record.checkIn, record.checkOut) === 1 ? "" : "s"} •{" "}
            {record.crewMemberIds?.length || 0} crew
          </div>
        </div>
        <StatusBadge status={record.status} />
      </div>

      {record.status === "not_needed" && (
        <div style={styles.optedOut}>
          <div style={styles.muted}>
            Marked not needed
            {record.notNeededReason ? `: ${record.notNeededReason}` : ""}.
          </div>
          {canEdit && (
            <button onClick={handleReopen} style={styles.btnGhost}>
              Reopen
            </button>
          )}
        </div>
      )}

      {record.status !== "not_needed" && (
        <>
          {/* Booking options */}
          <div style={styles.choiceRow}>
            <BookingChoice
              title="Marriott Direct"
              subtitle="Pilot earns Bonvoy points & elite nights"
              detail="Skyway corporate rate applied (when code is active)."
              url={marriottUrl}
              channel="marriott"
              accent="#1F3A5F"
            />
            <BookingChoice
              title="Expedia TAAP"
              subtitle="Skyway earns commission"
              detail="Use for any non-Marriott property. No loyalty credit."
              url={taapUrl}
              channel="taap"
              accent="#7A5C12"
            />
          </div>

          {/* Booking entries */}
          {record.bookings?.length > 0 && (
            <div style={styles.bookingList}>
              <div style={styles.sectionLabel}>Confirmed bookings</div>
              {record.bookings.map((b) => (
                <BookingRow
                  key={b.bookingId}
                  booking={b}
                  canEdit={canEdit}
                  onRemove={() => handleRemoveBooking(b.bookingId)}
                />
              ))}
            </div>
          )}

          {/* Actions */}
          {canEdit && (
            <div style={styles.actionRow}>
              <button
                onClick={() => setShowBookingForm(!showBookingForm)}
                style={styles.btnPrimary}
              >
                {showBookingForm ? "Cancel" : "+ Enter Confirmation"}
              </button>
              {record.status === "needed" && (
                <button
                  onClick={() => setShowOptOut(!showOptOut)}
                  style={styles.btnGhost}
                >
                  Mark not needed
                </button>
              )}
            </div>
          )}

          {showBookingForm && canEdit && (
            <BookingForm
              record={record}
              currentUser={currentUser}
              crewOnTrip={crewOnTrip}
              onSaved={() => {
                setShowBookingForm(false);
                onRefresh();
              }}
              onCancel={() => setShowBookingForm(false)}
            />
          )}

          {showOptOut && canEdit && (
            <OptOutForm
              onConfirm={handleOptOut}
              onCancel={() => setShowOptOut(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

// =====================================================================
// Subcomponents
// =====================================================================

function BookingChoice({ title, subtitle, detail, url, channel, accent }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ ...styles.choiceCard, borderColor: accent }}
    >
      <div style={{ ...styles.choiceTitle, color: accent }}>{title} →</div>
      <div style={styles.choiceSubtitle}>{subtitle}</div>
      <div style={styles.choiceDetail}>{detail}</div>
    </a>
  );
}

function BookingRow({ booking, canEdit, onRemove }) {
  const channelLabel =
    booking.channel === "marriott" ? "Marriott" : "Expedia TAAP";
  const channelColor = booking.channel === "marriott" ? "#1F3A5F" : "#7A5C12";
  return (
    <div style={styles.bookingRow}>
      <div style={{ flex: 1 }}>
        <div style={styles.bookingMain}>
          <span style={{ ...styles.channelChip, background: channelColor }}>
            {channelLabel}
          </span>
          <strong>{booking.hotelName}</strong>
        </div>
        <div style={styles.bookingMeta}>
          Conf #{booking.confirmationNumber} • {booking.pilotName} •{" "}
          {formatCurrency(booking.totalCost, booking.currency)} total
          {booking.nightlyRate
            ? ` (${formatCurrency(booking.nightlyRate, booking.currency)}/night)`
            : ""}
        </div>
        {booking.notes && (
          <div style={styles.bookingNotes}>{booking.notes}</div>
        )}
      </div>
      {canEdit && (
        <button onClick={onRemove} style={styles.btnDanger}>
          Remove
        </button>
      )}
    </div>
  );
}

function BookingForm({ record, currentUser, crewOnTrip, onSaved, onCancel }) {
  const [channel, setChannel] = useState("marriott");
  const [pilotId, setPilotId] = useState(
    currentUser?.role === "pilot" ? currentUser.id : ""
  );
  const [hotelName, setHotelName] = useState("");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [nightlyRate, setNightlyRate] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const pilotOptions = crewOnTrip.filter((c) => c.role === "pilot");
  const selectedPilot =
    pilotOptions.find((p) => p.id === pilotId) ||
    (currentUser?.role === "pilot" ? currentUser : null);

  const handleSave = async () => {
    setErr("");
    if (!hotelName.trim()) return setErr("Hotel name required.");
    if (!confirmationNumber.trim())
      return setErr("Confirmation number required.");
    if (!pilotId) return setErr("Select which pilot the room is under.");
    if (!totalCost || isNaN(Number(totalCost)))
      return setErr("Enter a valid total cost.");

    setSaving(true);
    try {
      await addBookingToRecord(record.id, {
        channel,
        pilotId,
        pilotName: selectedPilot?.name || "",
        hotelName: hotelName.trim(),
        confirmationNumber: confirmationNumber.trim(),
        nightlyRate: Number(nightlyRate) || 0,
        totalCost: Number(totalCost),
        currency: "USD",
        notes: notes.trim(),
        bookedByUserId: currentUser?.id || "",
      });
      onSaved();
    } catch (e) {
      console.error(e);
      setErr(e.message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.form}>
      <div style={styles.formGrid}>
        <Field label="Booking channel">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            style={styles.input}
          >
            <option value="marriott">Marriott Direct</option>
            <option value="taap">Expedia TAAP</option>
          </select>
        </Field>

        <Field label="Room under (pilot)">
          <select
            value={pilotId}
            onChange={(e) => setPilotId(e.target.value)}
            style={styles.input}
          >
            <option value="">— Select —</option>
            {pilotOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Hotel name" wide>
          <input
            value={hotelName}
            onChange={(e) => setHotelName(e.target.value)}
            placeholder="e.g. Courtyard by Marriott Teterboro"
            style={styles.input}
          />
        </Field>

        <Field label="Confirmation #">
          <input
            value={confirmationNumber}
            onChange={(e) => setConfirmationNumber(e.target.value)}
            placeholder="e.g. 89234571"
            style={styles.input}
          />
        </Field>

        <Field label="Nightly rate (USD)">
          <input
            type="number"
            step="0.01"
            value={nightlyRate}
            onChange={(e) => setNightlyRate(e.target.value)}
            placeholder="289.00"
            style={styles.input}
          />
        </Field>

        <Field label="Total cost (USD)">
          <input
            type="number"
            step="0.01"
            value={totalCost}
            onChange={(e) => setTotalCost(e.target.value)}
            placeholder="578.00"
            style={styles.input}
          />
        </Field>

        <Field label="Notes (optional)" wide>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Room type, FBO shuttle, etc."
            style={styles.input}
          />
        </Field>
      </div>

      {err && <div style={styles.error}>{err}</div>}

      <div style={styles.actionRow}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={styles.btnPrimary}
        >
          {saving ? "Saving…" : "Save booking"}
        </button>
        <button onClick={onCancel} style={styles.btnGhost}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OptOutForm({ onConfirm, onCancel }) {
  const [reason, setReason] = useState("");
  return (
    <div style={styles.form}>
      <Field label="Why is no hotel needed?" wide>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Pilot staying with family / day trip extended"
          style={styles.input}
        />
      </Field>
      <div style={styles.actionRow}>
        <button
          onClick={() => onConfirm(reason || "Pilot opted out")}
          style={styles.btnPrimary}
        >
          Confirm
        </button>
        <button onClick={onCancel} style={styles.btnGhost}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, wide }) {
  return (
    <div style={{ ...styles.field, gridColumn: wide ? "1 / -1" : "auto" }}>
      <label style={styles.label}>{label}</label>
      {children}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    needed: { bg: "#FEF3C7", color: "#92400E", label: "Needs booking" },
    booked: { bg: "#DCFCE7", color: "#166534", label: "Booked" },
    not_needed: { bg: "#E5E7EB", color: "#374151", label: "Not needed" },
    completed: { bg: "#DBEAFE", color: "#1E40AF", label: "Completed" },
  };
  const s = map[status] || map.needed;
  return (
    <span
      style={{
        ...styles.badge,
        background: s.bg,
        color: s.color,
      }}
    >
      {s.label}
    </span>
  );
}

function PolicyFooter() {
  return (
    <div style={styles.policy}>
      <strong>Booking policy:</strong> Marriott Direct preserves your Bonvoy
      points and elite night credit. Expedia TAAP routes commission to Skyway
      but does <em>not</em> earn loyalty credit at the property. Pick whichever
      fits the situation. All bookings are logged for ops visibility and expense
      tracking.
    </div>
  );
}

// =====================================================================
// Helpers
// =====================================================================

/**
 * deriveOvernights(trip): inspects the trip and returns one entry per
 * overnight stay. Adjust the field names here if your trip object shape
 * differs from what's described in the TripHotels prop docs.
 */
function deriveOvernights(trip) {
  if (!trip?.legs?.length) return [];
  const out = [];
  const sorted = [...trip.legs].sort((a, b) =>
    (a.arrivalDate || "").localeCompare(b.arrivalDate || "")
  );
  for (let i = 0; i < sorted.length; i++) {
    const leg = sorted[i];
    const next = sorted[i + 1];
    const isOvernight =
      leg.isOvernight === true ||
      (next &&
        leg.arrivalDate &&
        next.departureDate &&
        next.departureDate > leg.arrivalDate);
    if (!isOvernight) continue;

    const checkIn = (leg.arrivalDate || "").slice(0, 10);
    const checkOut = next
      ? (next.departureDate || "").slice(0, 10)
      : addDays(checkIn, 1);

    out.push({
      legId: leg.id,
      airportCode: leg.arrivalAirport || "",
      cityLabel: leg.cityLabel || leg.arrivalAirport || "",
      checkIn,
      checkOut,
      crewMemberIds: leg.crewIds || trip.crewIds || [],
    });
  }
  return out;
}

function addDays(isoDate, n) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function nightsBetween(a, b) {
  if (!a || !b) return 1;
  const da = new Date(a);
  const db = new Date(b);
  const ms = db - da;
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function formatDateRange(a, b) {
  if (!a || !b) return "";
  const opts = { month: "short", day: "numeric" };
  const da = new Date(a + "T00:00:00").toLocaleDateString("en-US", opts);
  const db = new Date(b + "T00:00:00").toLocaleDateString("en-US", opts);
  return `${da} – ${db}`;
}

function formatCurrency(n, currency = "USD") {
  if (n == null || isNaN(Number(n))) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(n));
}

// =====================================================================
// Styles (inline to keep this drop-in single-file)
// =====================================================================

const styles = {
  wrap: {
    maxWidth: 980,
    margin: "0 auto",
    padding: "16px",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#111827",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    paddingBottom: 12,
    borderBottom: "1px solid #E5E7EB",
  },
  title: { fontSize: 22, fontWeight: 700 },
  subtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  card: {
    background: "#FFFFFF",
    border: "1px solid #E5E7EB",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  },
  cardHeaderRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  cardTitle: { fontSize: 17, fontWeight: 600 },
  cardSubtitle: { fontSize: 13, color: "#6B7280", marginTop: 2 },
  choiceRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 12,
  },
  choiceCard: {
    display: "block",
    border: "2px solid",
    borderRadius: 10,
    padding: 12,
    textDecoration: "none",
    background: "#FAFAFA",
    transition: "transform 0.05s",
  },
  choiceTitle: { fontWeight: 700, fontSize: 15 },
  choiceSubtitle: {
    fontSize: 13,
    color: "#111827",
    marginTop: 4,
    fontWeight: 500,
  },
  choiceDetail: { fontSize: 12, color: "#6B7280", marginTop: 4 },
  bookingList: {
    background: "#F9FAFB",
    border: "1px solid #E5E7EB",
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "#6B7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  bookingRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "8px 0",
    borderTop: "1px solid #E5E7EB",
    gap: 12,
  },
  bookingMain: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  bookingMeta: { fontSize: 13, color: "#374151", marginTop: 4 },
  bookingNotes: { fontSize: 12, color: "#6B7280", marginTop: 2, fontStyle: "italic" },
  channelChip: {
    fontSize: 11,
    color: "#FFFFFF",
    padding: "2px 8px",
    borderRadius: 4,
    fontWeight: 600,
  },
  badge: {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
  },
  optedOut: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 8,
    background: "#F9FAFB",
    borderRadius: 6,
  },
  actionRow: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" },
  form: {
    background: "#F9FAFB",
    border: "1px solid #E5E7EB",
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  formGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  field: { display: "flex", flexDirection: "column" },
  label: { fontSize: 12, color: "#374151", marginBottom: 4, fontWeight: 500 },
  input: {
    padding: "8px 10px",
    border: "1px solid #D1D5DB",
    borderRadius: 6,
    fontSize: 14,
    background: "#FFFFFF",
    width: "100%",
    boxSizing: "border-box",
  },
  btnPrimary: {
    padding: "8px 14px",
    background: "#1F3A5F",
    color: "#FFFFFF",
    border: "none",
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnGhost: {
    padding: "8px 14px",
    background: "transparent",
    color: "#374151",
    border: "1px solid #D1D5DB",
    borderRadius: 6,
    fontSize: 14,
    cursor: "pointer",
  },
  btnDanger: {
    padding: "6px 10px",
    background: "transparent",
    color: "#B91C1C",
    border: "1px solid #FCA5A5",
    borderRadius: 6,
    fontSize: 12,
    cursor: "pointer",
  },
  muted: { color: "#6B7280", fontSize: 14 },
  error: {
    background: "#FEE2E2",
    color: "#991B1B",
    padding: 10,
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 10,
  },
  policy: {
    fontSize: 12,
    color: "#6B7280",
    background: "#F9FAFB",
    border: "1px solid #E5E7EB",
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
    lineHeight: 1.5,
  },
};
