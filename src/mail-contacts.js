// Client-side recipient autocomplete helpers.
//
// The server returns a mailbox address book (see extractContacts). The compose
// UI fetches it once, then filters locally on each keystroke so typing an email
// pulls up matching people without a network round-trip per character.

/** The recipient token currently being typed (after the last comma/semicolon). */
export function currentToken(value) {
  const parts = String(value || '').split(/[;,]/);
  return parts[parts.length - 1].trim();
}

/**
 * Rank contacts against the token being typed. Matches on name or address,
 * preferring prefix matches, then substring matches, and excludes addresses
 * already present in the field.
 */
export function filterContacts(contacts, value, limit = 6) {
  const token = currentToken(value).toLowerCase();
  if (token.length < 1) return [];
  const already = new Set(
    String(value || '')
      .split(/[;,]/)
      .slice(0, -1)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  const scored = [];
  for (const contact of Array.isArray(contacts) ? contacts : []) {
    const address = String(contact?.address || '').toLowerCase();
    const name = String(contact?.name || '').toLowerCase();
    if (!address || already.has(address)) continue;
    let score = 0;
    if (address.startsWith(token) || name.startsWith(token)) score = 3;
    else if (name.split(/\s+/).some((word) => word.startsWith(token))) score = 2;
    else if (address.includes(token) || name.includes(token)) score = 1;
    if (score > 0) scored.push({ contact, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.contact);
}

/** Replace the token being typed with a chosen address, ready for the next one. */
export function applyContact(value, address) {
  const parts = String(value || '').split(/[;,]/);
  parts[parts.length - 1] = ` ${address}`;
  return `${parts.map((part) => part.trim()).filter(Boolean).join(', ')}, `;
}
