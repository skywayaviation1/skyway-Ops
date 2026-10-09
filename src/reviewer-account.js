// App Review sandbox identity policy.
//
// Email/password sign-in exists for exactly one Firebase account. Every other
// password session is rejected in the client, in API token checks, and in
// Firestore rules. The password itself is never stored in this repository.

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

function providerOf(decoded) {
  return decoded?.firebase?.sign_in_provider
    || decoded?.signInProvider
    || '';
}

/**
 * Whether a decoded Firebase ID token may call company APIs.
 * Password sessions never may. The reviewer account is sandboxed.
 * A password session for any other email is a rejected back door.
 */
export function classifyAuthToken(decoded) {
  const email = normalizeEmail(decoded?.email);
  const provider = providerOf(decoded);
  const claim = decoded?.[APP_REVIEWER_CLAIM] === true;
  const reviewerEmail = email === APP_REVIEWER_EMAIL;

  if (provider === 'password') {
    if (!(reviewerEmail && claim)) {
      return {
        block: true,
        reviewer: false,
        code: 'password-provider-blocked',
        error: 'Email and password sign-in is not available for this account.',
      };
    }
    return {
      block: true,
      reviewer: true,
      code: 'app-reviewer-sandbox',
      error: 'The App Review sandbox cannot use company services.',
    };
  }

  if (claim || reviewerEmail) {
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
 * Throws for the reviewer sandbox and for every other password session.
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
