// Skyway's trip ID is the JetInsight trip code stored on
// trip-state as tripSheetData.tripCode. Real codes are 6 or 7
// letters and digits, for example WEQVQD or X9K2M4. A longer
// leg uid or a purely numeric trip number is not this id.

export const TRIP_ID_LABEL_WORDS = new Set([
  'LOCATOR', 'TRIPID', 'ITINERARY', 'QUOTE', 'CHARTER', 'AIRCRAFT', 'PASSENGER', 'PASSENGERS',
  'CONFIRM', 'BOOKING', 'INVOICE', 'CONTRACT', 'DEPARTURE', 'ARRIVAL', 'ROUTING', 'AIRPORT',
  'BROKER', 'COMPANY', 'TOTAL', 'DATES', 'RETURN', 'OUTBOUND', 'INBOUND', 'FLIGHT',
]);

export function normalizeTripId(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,7}$/.test(raw)) return '';
  if (!/[A-Z]/.test(raw)) return '';
  return raw;
}

export function acceptTripCode(value) {
  const id = normalizeTripId(value);
  if (!id || TRIP_ID_LABEL_WORDS.has(id)) return '';
  return id;
}
