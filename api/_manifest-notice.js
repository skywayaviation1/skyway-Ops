// Copy for the load-manifest filing email.
//
// An amendment must not look like a brand-new manifest. The subject, body,
// and PDF filename all say AMENDED and include the revision plus what changed.
//
// Outside production, the message goes only to jake@flyskyway.com so a preview
// or a test run cannot mail the filing desk, charters@, brokers, or passengers.

export const MANIFEST_FILING_INBOX = 'Loadmanifest@flyskyway.com';
export const MANIFEST_TEST_INBOX = 'jake@flyskyway.com';
export const FORM_REV = 'S-5/R-37/10-30-23';

function text(value) {
  return String(value || '').trim();
}

/**
 * Production (VERCEL_ENV=production, and no explicit jake sink) files to the
 * load-manifest desk. Every other environment sinks to Jake only.
 */
export function manifestFilingRecipients(env = process.env) {
  const production = env?.VERCEL_ENV === 'production' && env?.MANIFEST_EMAIL_SINK !== 'jake';
  if (!production) {
    return { to: [MANIFEST_TEST_INBOX], testing: true };
  }
  return { to: [MANIFEST_FILING_INBOX], testing: false };
}

export function buildManifestFilename(tripDate, tail, revision) {
  const safeTail = String(tail || 'TAIL').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let mm = '';
  let dd = '';
  let yyyy = '';
  const dateStr = text(tripDate);

  let match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    yyyy = match[1];
    mm = match[2].padStart(2, '0');
    dd = match[3].padStart(2, '0');
  } else {
    match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (match) {
      mm = match[1].padStart(2, '0');
      dd = match[2].padStart(2, '0');
      yyyy = match[3].length === 2 ? `20${match[3]}` : match[3];
    }
  }

  const rev = Number(revision) > 1 ? ` REV${Number(revision)}` : '';
  if (mm && dd && yyyy) return `${mm}-${dd}-${yyyy} ${safeTail}${rev}.pdf`;
  return `Manifest ${safeTail}${rev}.pdf`;
}

export function isAmendedManifest(manifest) {
  const revision = Number(manifest?.revision) || 1;
  return revision > 1 || manifest?.amended === true;
}

/**
 * Subject, plain text, and routing for one filing email.
 * `testing: true` means the caller must not add any other recipient.
 */
export function composeManifestNotice(manifest, env = process.env) {
  const revision = Number(manifest?.revision) || 1;
  const amended = isAmendedManifest(manifest);
  const tail = manifest?.tail || 'Unknown';
  const date = manifest?.tripDate || manifest?.date || '';
  const code = manifest?.tripCode ? ` [${manifest.tripCode}]` : '';
  const summary = text(manifest?.changeSummary);
  const note = text(manifest?.amendmentNote);
  const filing = manifestFilingRecipients(env);

  const subject = amended
    ? `AMENDED Load Manifest (Rev ${revision}) — ${tail} ${date}${code}`.replace(/\s+/g, ' ').trim()
    : `Load Manifest — ${tail} ${date}${code}`.replace(/\s+/g, ' ').trim();

  const lines = [];
  if (amended) {
    lines.push(`AMENDED REVISION ${revision}. This replaces the previously filed load manifest. Use this version.`);
    lines.push('');
    lines.push(`Amended by: ${manifest?.amendedBy || manifest?.submittedBy || 'crew'}`);
    if (note) lines.push(`Note: ${note}`);
    if (summary) {
      lines.push('');
      lines.push('What changed:');
      lines.push(summary);
    }
    lines.push('');
  } else {
    lines.push(`Load Manifest submitted by ${manifest?.submittedBy || 'crew'}.`);
    lines.push('');
  }

  lines.push(
    `Aircraft:       ${manifest?.tail || ''}`,
    `Date:           ${date}`,
    `Trip code:      ${manifest?.tripCode || ''}`,
    `Revision:       ${revision}`,
    `Hobbs out:      ${manifest?.hobbsOut || ''}`,
    `Hobbs in:       ${manifest?.hobbsIn || ''}`,
    `Hobbs total:    ${manifest?.hobbsTotal || ''}`,
    `Legs:           ${(manifest?.legs || []).length}`,
    '',
    `PIC: ${manifest?.picSig?.name || ''} (${manifest?.picSig?.email || ''})`,
    `SIC: ${manifest?.sicSig?.name || ''} (${manifest?.sicSig?.email || ''})`,
    '',
    'PDF attached. This email was sent automatically by Skyway Ops.',
  );
  if (amended) {
    lines.push('The attached PDF is marked AMENDED and supersedes the prior filing.');
  }
  lines.push(`Form revision: ${FORM_REV}`);

  return {
    subject,
    text: lines.join('\n'),
    filename: buildManifestFilename(date, manifest?.tail, amended ? revision : 1),
    to: filing.to,
    testing: filing.testing,
    amended,
    revision,
  };
}
