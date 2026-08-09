// Pure decisions for merging a Microsoft identity onto an existing Firebase
// Auth user that already owns the same company email (typically a legacy
// password account). Kept free of Firebase imports so the rules can be tested.

const COMPANY_DOMAIN = 'flyskyway.com';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isCompanyEmail(email, domain = COMPANY_DOMAIN) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith(`@${domain}`)
    && normalized.slice(0, -(domain.length + 1)).length > 0;
}

/**
 * Pull the Microsoft directory identity out of a Graph /me response. Entra
 * puts the address on `mail` for most work accounts and on `userPrincipalName`
 * for others; either is authoritative when it is a company address.
 */
export function microsoftIdentityFromGraph(me) {
  if (!me || typeof me !== 'object') return null;
  const oid = String(me.id || '').trim();
  if (!oid) return null;
  const candidates = [me.mail, me.userPrincipalName, me.otherMails?.[0]];
  const email = candidates.map(normalizeEmail).find((value) => isCompanyEmail(value)) || null;
  if (!email) return null;
  const displayName = String(me.displayName || '').trim() || email.split('@')[0];
  return { oid, email, displayName };
}

/**
 * Decide how to reconcile an existing Firebase Auth user with a verified
 * Microsoft identity that shares its email. Returns the providers to link and
 * unlink so the Auth UID — and every Firestore document keyed by it — stays
 * put while the account becomes Microsoft-only.
 */
export function planProviderMerge(existingUser, microsoftIdentity) {
  if (!existingUser?.uid) {
    return { action: 'reject', reason: 'no-existing-user' };
  }
  if (!microsoftIdentity?.oid || !microsoftIdentity?.email) {
    return { action: 'reject', reason: 'no-microsoft-identity' };
  }

  const existingEmail = normalizeEmail(existingUser.email);
  if (!existingEmail || existingEmail !== normalizeEmail(microsoftIdentity.email)) {
    return { action: 'reject', reason: 'email-mismatch' };
  }

  const providers = Array.isArray(existingUser.providerData)
    ? existingUser.providerData
    : [];
  const microsoft = providers.find((p) => p?.providerId === 'microsoft.com');

  if (microsoft) {
    const linkedOid = String(microsoft.uid || '').trim();
    // Same directory subject already linked — nothing to do. A different oid
    // on the same email is a collision that must not be silently overwritten.
    if (linkedOid && linkedOid !== microsoftIdentity.oid) {
      return { action: 'reject', reason: 'microsoft-oid-conflict' };
    }
    return {
      action: 'already-linked',
      uid: existingUser.uid,
      unlink: providersToDrop(providers),
    };
  }

  return {
    action: 'link',
    uid: existingUser.uid,
    link: {
      providerId: 'microsoft.com',
      uid: microsoftIdentity.oid,
      email: microsoftIdentity.email,
      displayName: microsoftIdentity.displayName,
    },
    unlink: providersToDrop(providers),
  };
}

/** Every non-Microsoft provider on the account — password first, by design. */
function providersToDrop(providers) {
  return [...new Set(
    providers
      .map((p) => p?.providerId)
      .filter((id) => id && id !== 'microsoft.com'),
  )];
}
