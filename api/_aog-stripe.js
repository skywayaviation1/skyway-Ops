// Stripe Checkout for the AOG premium only. Card data stays on Stripe.
// Live secret keys are refused so a test deployment cannot charge a real card.

import Stripe from 'stripe';
import crypto from 'crypto';

export const STRIPE_API_VERSION = '2026-07-29.dahlia';

export function assertStripeTestKey(key = process.env.STRIPE_SECRET_KEY) {
  const value = String(key || '').trim();
  if (!value) {
    const error = new Error('STRIPE_SECRET_KEY is not configured');
    error.status = 503;
    throw error;
  }
  if (value.startsWith('sk_live_') || value.startsWith('rk_live_')) {
    const error = new Error('Live Stripe keys are refused. Use a test key (sk_test_ or rk_test_).');
    error.status = 503;
    throw error;
  }
  if (!value.startsWith('sk_test_') && !value.startsWith('rk_test_')) {
    const error = new Error('STRIPE_SECRET_KEY must be a Stripe test-mode key');
    error.status = 503;
    throw error;
  }
  return value;
}

export function stripeClient(key = process.env.STRIPE_SECRET_KEY) {
  return new Stripe(assertStripeTestKey(key), { apiVersion: STRIPE_API_VERSION });
}

function randomLetters(count) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(count);
  let out = '';
  for (let i = 0; i < count; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Checkout Session params. `amountCents` is the server-side premium.
 * Any amount supplied by the browser is ignored by the caller.
 */
export function buildCheckoutSessionParams({ record, successUrl, cancelUrl, amountCents }) {
  const cents = Number(amountCents);
  const tripCents = Math.round(Number(record?.tripTotal) * 100);
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error('Premium is not payable');
  }
  if (Number.isFinite(tripCents) && tripCents > 0 && cents >= tripCents) {
    throw new Error('Refusing to charge the trip total. Premium must be less than the trip.');
  }
  const email = String(record?.checkoutEmail || '').trim();
  const params = {
    mode: 'payment',
    client_reference_id: String(record.id || ''),
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: cents,
        product_data: {
          name: 'AOG mechanical recovery coverage — 100%',
          description: `Premium only. Trip ${record.tripId || record.id || ''}. Tail ${record.tail || '—'}.`,
        },
      },
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      coverageId: String(record.id || ''),
      tripId: String(record.tripId || ''),
      coverageProduct: 'aog-recovery',
    },
    integration_identifier: `aog_recovery_${randomLetters(8)}`,
  };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) params.customer_email = email;
  return params;
}
