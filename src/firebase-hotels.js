// src/firebase-hotels.js
// Firestore module for hotel booking records (Trip Hotels module)
// Mirrors the pattern used in firebase-customers.js and firebase-aircraft.js

import { db } from "./firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";

const COLLECTION = "tripHotelBookings";

/**
 * Hotel booking document shape:
 * {
 *   id: string (auto)
 *   tripId: string
 *   legId: string                 // identifier for which overnight on the trip
 *   airportCode: string           // e.g. "TEB"
 *   cityLabel: string             // human-readable, e.g. "Teterboro, NJ"
 *   checkIn: string               // ISO date "YYYY-MM-DD"
 *   checkOut: string              // ISO date "YYYY-MM-DD"
 *   crewMemberIds: string[]       // pilots assigned for this overnight
 *   status: "needed" | "booked" | "not_needed" | "completed"
 *   notNeededReason: string|null  // when status === "not_needed"
 *   bookings: HotelBooking[]      // one entry per room/pilot
 *   createdAt: Timestamp
 *   updatedAt: Timestamp
 * }
 *
 * HotelBooking shape:
 * {
 *   bookingId: string             // local uuid
 *   channel: "marriott" | "taap"  // booking channel used
 *   pilotId: string               // pilot the room is under
 *   pilotName: string             // denormalized for display
 *   hotelName: string
 *   confirmationNumber: string
 *   nightlyRate: number
 *   totalCost: number
 *   currency: string              // default "USD"
 *   notes: string
 *   bookedAt: Timestamp
 *   bookedByUserId: string        // who entered the record
 * }
 */

// ---------- Read ----------

export async function getHotelBookingsForTrip(tripId) {
  const q = query(
    collection(db, COLLECTION),
    where("tripId", "==", tripId),
    orderBy("checkIn", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getHotelBooking(id) {
  const ref = doc(db, COLLECTION, id);
  const snap = await getDoc(ref);
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getAllUpcomingHotelBookings() {
  const today = new Date().toISOString().slice(0, 10);
  const q = query(
    collection(db, COLLECTION),
    where("checkIn", ">=", today),
    orderBy("checkIn", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ---------- Write ----------

export async function createHotelBookingRecord(record) {
  const id =
    record.id ||
    `hotel_${record.tripId}_${record.legId}_${Date.now().toString(36)}`;
  const ref = doc(db, COLLECTION, id);
  const payload = {
    tripId: record.tripId,
    legId: record.legId,
    airportCode: record.airportCode || "",
    cityLabel: record.cityLabel || "",
    checkIn: record.checkIn,
    checkOut: record.checkOut,
    crewMemberIds: record.crewMemberIds || [],
    status: record.status || "needed",
    notNeededReason: record.notNeededReason || null,
    bookings: record.bookings || [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(ref, payload);
  return { id, ...payload };
}

export async function updateHotelBookingRecord(id, updates) {
  const ref = doc(db, COLLECTION, id);
  await updateDoc(ref, {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}

export async function addBookingToRecord(recordId, booking) {
  const record = await getHotelBooking(recordId);
  if (!record) throw new Error("Hotel booking record not found");
  const newBooking = {
    bookingId: `bk_${Date.now().toString(36)}`,
    channel: booking.channel,
    pilotId: booking.pilotId,
    pilotName: booking.pilotName || "",
    hotelName: booking.hotelName,
    confirmationNumber: booking.confirmationNumber,
    nightlyRate: Number(booking.nightlyRate) || 0,
    totalCost: Number(booking.totalCost) || 0,
    currency: booking.currency || "USD",
    notes: booking.notes || "",
    bookedAt: new Date().toISOString(),
    bookedByUserId: booking.bookedByUserId || "",
  };
  const updatedBookings = [...(record.bookings || []), newBooking];
  await updateHotelBookingRecord(recordId, {
    bookings: updatedBookings,
    status: "booked",
  });
  return newBooking;
}

export async function removeBookingFromRecord(recordId, bookingId) {
  const record = await getHotelBooking(recordId);
  if (!record) throw new Error("Hotel booking record not found");
  const updatedBookings = (record.bookings || []).filter(
    (b) => b.bookingId !== bookingId
  );
  await updateHotelBookingRecord(recordId, {
    bookings: updatedBookings,
    status: updatedBookings.length === 0 ? "needed" : "booked",
  });
}

export async function markRecordNotNeeded(recordId, reason) {
  await updateHotelBookingRecord(recordId, {
    status: "not_needed",
    notNeededReason: reason || "Pilot opted out",
    bookings: [],
  });
}

export async function reopenRecord(recordId) {
  await updateHotelBookingRecord(recordId, {
    status: "needed",
    notNeededReason: null,
  });
}

export async function deleteHotelBookingRecord(id) {
  await deleteDoc(doc(db, COLLECTION, id));
}

// ---------- Booking URL builders ----------

/**
 * SKYWAY_CORPORATE_CODE: set this to your Marriott Bonvoy for Business code
 * once approved. Leave empty string until then — the deep-link still works
 * without it, it just won't apply a corporate rate.
 *
 * To update: change the value below and redeploy. (No env var needed since
 * Vercel/Vite would just inline this anyway for a public-facing URL param.)
 */
export const SKYWAY_CORPORATE_CODE = ""; // <-- replace with Skyway code when approved

/**
 * SKYWAY_TAAP_PORTAL_URL: your Expedia TAAP agent portal landing URL.
 * Replace with your actual TAAP affiliate URL once your portal is live.
 */
export const SKYWAY_TAAP_PORTAL_URL =
  "https://www.expedia.com/affiliates"; // <-- replace with Skyway's TAAP affiliate URL

function formatDateForMarriott(isoDate) {
  // Marriott expects MM/DD/YYYY
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${m}/${d}/${y}`;
}

export function buildMarriottUrl({
  airportCode,
  cityLabel,
  checkIn,
  checkOut,
  rooms = 1,
  adults = 1,
}) {
  const destination = encodeURIComponent(cityLabel || airportCode || "");
  const params = new URLSearchParams({
    "destinationAddress.destination": destination,
    fromDate: formatDateForMarriott(checkIn),
    toDate: formatDateForMarriott(checkOut),
    numberOfRooms: String(rooms),
    numberOfAdults: String(adults),
  });
  if (SKYWAY_CORPORATE_CODE) {
    params.set("corporateCode", SKYWAY_CORPORATE_CODE);
  }
  return `https://www.marriott.com/search/findHotels.mi?${params.toString()}`;
}

export function buildTaapUrl({ cityLabel, airportCode, checkIn, checkOut }) {
  // TAAP doesn't accept arbitrary deep-link params for hotel search the
  // same way Marriott does — agents land at the portal and search there.
  // We append a hint query string for the agent's own reference.
  const dest = encodeURIComponent(cityLabel || airportCode || "");
  return `${SKYWAY_TAAP_PORTAL_URL}?dest=${dest}&in=${checkIn}&out=${checkOut}`;
}
