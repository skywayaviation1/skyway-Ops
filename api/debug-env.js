// Safe diagnostic endpoint — reports whether ANTHROPIC_API_KEY is visible
// to Vercel functions at runtime, without leaking the key.
//
// Returns prefix (first 7 chars) and length only — enough to verify the
// key is there and looks correct, never enough to use it.
//
// DELETE THIS FILE once the env var issue is resolved. Production
// deployments shouldn't expose any environment diagnostics, even safe ones.

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const key = process.env.ANTHROPIC_API_KEY;
  const allEnvNames = Object.keys(process.env).sort();

  // Find any env var names that contain "ANTHROPIC" or "API" (case-insensitive)
  // — useful if the user accidentally named it ANTROPIC_API_KEY (typo) or similar
  const relatedNames = allEnvNames.filter(n =>
    /anthrop|claude|api[_-]?key/i.test(n)
  );

  // Build a safe report
  const report = {
    timestamp: new Date().toISOString(),
    runtime: 'nodejs',
    nodeVersion: process.version,
    vercelEnv: process.env.VERCEL_ENV || 'unknown',
    vercelRegion: process.env.VERCEL_REGION || 'unknown',
    anthropicKey: {
      present: !!key,
      length: key ? key.length : 0,
      prefix: key ? key.slice(0, 7) : null,
      suffix: key ? key.slice(-4) : null,
      hasLeadingSpace: key ? key !== key.trimStart() : false,
      hasTrailingSpace: key ? key !== key.trimEnd() : false,
      startsWithExpectedPrefix: key ? key.startsWith('sk-ant-') : false,
    },
    relatedEnvVarNames: relatedNames,
    totalEnvVarCount: allEnvNames.length,
  };

  return res.status(200).json(report);
}
