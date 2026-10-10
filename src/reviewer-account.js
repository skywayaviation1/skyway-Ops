// App Review sandbox identity policy.
//
// Existing email/password accounts stay valid. Company APIs, the client, and
// production rules block only the reviewer: the appReviewer custom claim, or
// the address appreview@flyskyway.com. The reviewer sign-in form still refuses
// every other address before it contacts Firebase. The password itself is
// never stored in this repository.

export const APP_REVIEWER_EMAIL = 'appreview@flyskyway.com';
export const DEMO_DATABASE_ID = 'appreview';
export const APP_REVIEWER_CLAIM = 'appReviewer';
export const DEMO_TRACKING_TOKEN = 'demo-sandbox';

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function isReviewerEmail(email) {
  return normalizeEmail(email) === APP_REVIEWER_EMAIL;
}

/** Client-side gate before signInWithEmailAndPassword is even called. */
export function passwordSignInAllowed(email) {
  return isReviewerEmail(email);
}

/** Reviewer identity is the custom claim or the one sandbox address. */
export function isReviewerToken(decoded) {
  const email = normalizeEmail(decoded?.email);
  const claim = decoded?.[APP_REVIEWER_CLAIM] === true;
  return claim || email === APP_REVIEWER_EMAIL;
}

/**
 * Whether a decoded Firebase ID token may call company APIs.
 * Only the reviewer is blocked. Other password sessions are unchanged.
 */
export function classifyAuthToken(decoded) {
  if (isReviewerToken(decoded)) {
    return {
      block: true,
      reviewer: true,
      code: 'app-reviewer-sandbox',
      error: 'The App Review sandbox cannot use company services.',
    };
  }

  return { block: false, reviewer: false, code: null, error: null };
}

/**
 * Returns the decoded token when the session may use company APIs.
 * Throws only for the reviewer identity.
 */
export function reviewerSessionBlock(decoded) {
  const decision = classifyAuthToken(decoded);
  if (!decision.block) return decoded;
  const err = new Error(decision.error);
  err.code = decision.code;
  err.status = 403;
  throw err;
}

/** True only for the one activated reviewer password session. */
export function isActivatedReviewerSession({ email, claims, signInProvider }) {
  return claims?.[APP_REVIEWER_CLAIM] === true
    && isReviewerEmail(email || claims?.email)
    && signInProvider === 'password';
}
