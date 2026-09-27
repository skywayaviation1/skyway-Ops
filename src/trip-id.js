// Skyway's trip ID is the JetInsight trip code stored on
// trip-state as tripSheetData.tripCode. Real codes are 6 or 7
// letters and digits, for example WEQVQD or X9K2M4. A longer
// leg uid or a purely numeric trip number is not this id.

export function normalizeTripId(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6,7}$/.test(raw)) return '';
  if (!/[A-Z]/.test(raw)) return '';
  return raw;
}
