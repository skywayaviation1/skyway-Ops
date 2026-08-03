export const OVER_14_RECIPIENTS = [
  'Jim@flyskyway.com',
  'Jake@flyskyway.com',
  'zack.taylor@flyskyway.com',
];

function hours(ms) {
  return (ms / 3600_000).toFixed(2);
}

export async function sendOver14DutyEmail({
  period,
  verifiedBy,
  verificationSource,
}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[duty-over14] RESEND_API_KEY missing; escalation email not sent');
    return { sent: false, reason: 'RESEND_API_KEY missing' };
  }
  const duration = Number(period.dutyOffAt) - Number(period.dutyOnAt);
  const subject = `Duty over 14 hours verified · ${period.pilotName || period.pilotUid}`;
  const text = [
    'A Skyway duty period over 14 hours was explicitly verified.',
    '',
    `Pilot: ${period.pilotName || 'Unknown'} (${period.pilotUid || 'no uid'})`,
    `Role: ${period.role || 'Unknown'}`,
    `Tail: ${period.tail || 'Not recorded'}`,
    `Trip: ${period.tripId || 'Not recorded'}`,
    `Location: ${period.location || 'Not recorded'}`,
    `Duty on: ${new Date(period.dutyOnAt).toISOString()}`,
    `Duty off: ${new Date(period.dutyOffAt).toISOString()}`,
    `Duration: ${hours(duration)} hours`,
    `Verified by: ${verifiedBy || 'Unknown'}`,
    `Source: ${verificationSource || 'duty workflow'}`,
    `Excursion reason: ${period.excursionReason || 'Not provided'}`,
    '',
    'This message records the verification; it does not itself approve a regulatory exception.',
  ].join('\n');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.DUTY_ALERT_FROM_EMAIL
        || process.env.OPS_FROM_EMAIL
        || 'Skyway Duty <noreply@send.flyskyway.com>',
      to: OVER_14_RECIPIENTS,
      subject,
      text,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`over-14 email failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  return { sent: true };
}

