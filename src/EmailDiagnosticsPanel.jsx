/**
 * Settings → Email delivery.
 *
 * When notification emails stop arriving the cause is almost always on the
 * server (missing provider key, unverified sending domain) or in the retry
 * queue — neither of which was visible from inside the app. This panel reports
 * both, shows the provider's verbatim error, and can send a live test.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Loader2, Mail, RefreshCw, Send,
} from 'lucide-react';

async function callDiagnostics(payload) {
  const { auth } = await import('./firebase.js');
  const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const r = await fetch('/api/email-diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...payload }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

function Row({ label, value, good }) {
  const tone = good === true ? 'text-emerald-300' : good === false ? 'text-red-300' : 'text-slate-300';
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        {label}
      </span>
      <span className={`text-[10px] ${tone} text-right`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
        {value}
      </span>
    </div>
  );
}

function fmtTime(ms) {
  if (!ms) return 'never';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return 'unknown';
  }
}

export default function EmailDiagnosticsPanel({ currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [testTo, setTestTo] = useState(currentUser?.email || '');

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      setReport(await callDiagnostics({ action: 'status' }));
    } catch (err) {
      setError(err.message || 'Could not read email delivery status');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { refresh(); }, [refresh]);

  async function runTest() {
    if (busy) return;
    setBusy('test');
    setError(null);
    setInfo(null);
    try {
      const data = await callDiagnostics({ action: 'test', to: testTo.trim() });
      if (data.result?.ok) {
        setInfo(data.result.route === 'tenant-mailbox'
          ? `Exchange accepted the test for ${data.to}. It was sent inside your tenant, so no spam filter sits in front of it.`
          : `Test email accepted by the provider for ${data.to}. If it does not arrive, check spam and the recipient's mail server.`);
      } else {
        setError(data.result?.explanation || data.result?.error || 'Test send failed');
      }
      await refresh();
    } catch (err) {
      setError(err.message || 'Test send failed');
    } finally {
      setBusy(null);
    }
  }

  async function retryOne(queueId) {
    if (busy) return;
    setBusy(queueId);
    setError(null);
    setInfo(null);
    try {
      await callDiagnostics({ action: 'retry', queueId });
      setInfo(`Queued ${queueId} for another delivery attempt.`);
      await refresh();
    } catch (err) {
      setError(err.message || 'Retry failed');
    } finally {
      setBusy(null);
    }
  }

  if (!isAdmin) {
    return (
      <section>
        <h3 className="text-xs tracking-widest text-cyan-400 mb-3 flex items-center gap-2" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
          <Mail className="w-3.5 h-3.5" /> EMAIL DELIVERY
        </h3>
        <div className="p-2 border border-slate-700 bg-slate-900/40 text-[11px] text-slate-500">
          An administrator can check notification email delivery here.
        </div>
      </section>
    );
  }

  const config = report?.config;
  const domains = report?.domains;
  const queue = report?.queue;

  return (
    <section>
      <h3 className="text-xs tracking-widest text-cyan-400 mb-3 flex items-center gap-2" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
        <Mail className="w-3.5 h-3.5" /> EMAIL DELIVERY
      </h3>

      <p className="text-xs text-slate-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        Why notification emails are or are not arriving: server configuration, sending-domain
        verification, and the retry queue with the mail provider&apos;s own error text.
      </p>

      {info && (
        <div className="mb-3 p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">{info}</div>
      )}
      {error && (
        <div className="mb-3 p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">{error}</div>
      )}

      {loading && !report ? (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking delivery…
        </div>
      ) : report ? (
        <div className="space-y-3">
          {/* Headline */}
          <div className={`p-3 border ${report.healthy ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5'}`}>
            <div className="flex items-center gap-2">
              {report.healthy
                ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                : <AlertTriangle className="w-4 h-4 text-red-400" />}
              <span className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {report.healthy ? 'Delivery configured' : 'Delivery is broken'}
              </span>
            </div>
            {report.problems?.length > 0 && (
              <ul className="mt-2 space-y-1">
                {report.problems.map((problem) => (
                  <li key={problem} className="text-[11px] text-red-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                    • {problem}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Server config */}
          <div className="border border-slate-800 bg-slate-900/40 p-3">
            <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              SERVER CONFIGURATION
            </div>
            <Row label="Provider API key" value={config.resendApiKey ? 'set' : 'MISSING'} good={config.resendApiKey} />
            <Row label="From address" value={config.fromAddress} />
            <Row label="Reply-to" value={config.replyTo} />
            <Row
              label="Sending domain"
              value={domains?.sendingDomainStatus || (domains?.checked ? 'not registered' : 'unchecked')}
              good={domains?.checked && domains?.ok ? domains.sendingDomainVerified : undefined}
            />
            <Row
              label="Dead-letter alerts"
              value={config.deadLetterAlertRecipients > 0 ? `${config.deadLetterAlertRecipients} recipient(s)` : 'nobody'}
              good={config.deadLetterAlertRecipients > 0}
            />
          </div>

          {/* Queue */}
          <div className="border border-slate-800 bg-slate-900/40 p-3">
            <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              QUEUE (LAST {queue.sampled})
            </div>
            <Row label="Sent" value={String(queue.counts.sent)} good={queue.counts.sent > 0 ? true : undefined} />
            <Row label="Waiting / retrying" value={String(queue.counts.pending + queue.counts.failed + queue.counts.sending)} />
            <Row label="Abandoned" value={String(queue.counts.dead)} good={queue.counts.dead === 0} />
            <Row label="Last successful send" value={fmtTime(queue.lastSentAt)} />
          </div>

          {/* Own-tenant mailboxes — Exchange sends these, not the provider */}
          {report.tenantMail && (
            <div className="border border-slate-800 bg-slate-900/40 p-3">
              <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                YOUR OWN MAILBOXES
              </div>
              <Row label="Domain delivered by Exchange" value={report.tenantMail.domain || 'not detected'} />
              <Row label="Sent as" value={report.tenantMail.sendAsMailbox} />
              <Row
                label="Graph credentials"
                value={report.tenantMail.graphConfigured ? 'configured' : 'NOT CONFIGURED'}
                good={report.tenantMail.graphConfigured}
              />
              <Row label="Sent by Exchange" value={String(report.tenantMail.sentByExchange)} good={report.tenantMail.sentByExchange > 0 ? true : undefined} />
              <Row label="Filed directly" value={String(report.tenantMail.filedDirectly)} />
              <Row
                label="Fell back to provider"
                value={String(report.tenantMail.fellBackToProvider)}
                good={report.tenantMail.fellBackToProvider === 0}
              />
              <p className="mt-2 text-[10px] text-slate-400" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                Notices for your own mailboxes are handed to Microsoft Exchange instead of the mail
                provider. Provider mail arrives from a subdomain of your own domain, which Exchange
                Online Protection treats as spoofing and keeps out of the inbox.
              </p>
              {report.tenantMail.lastError && (
                <p className="mt-1 text-[10px] text-red-300 break-all" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {report.tenantMail.lastError}
                </p>
              )}
            </div>
          )}

          {/* Charter inbox — its copy is written into the mailbox, not emailed */}
          {report.charterInbox && (
            <div className="border border-slate-800 bg-slate-900/40 p-3">
              <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                CHARTER INBOX COPY
              </div>
              <Row label="Address" value={report.charterInbox.address} />
              <Row
                label="Mailbox write"
                value={report.charterInbox.mailboxWriteConfigured ? 'configured' : 'NOT CONFIGURED'}
                good={report.charterInbox.mailboxWriteConfigured}
              />
              <Row label="Copies filed" value={String(report.charterInbox.copiesFiled)} good={report.charterInbox.copiesFiled > 0 ? true : undefined} />
              <Row label="Copies failed" value={String(report.charterInbox.copiesFailed)} good={report.charterInbox.copiesFailed === 0} />
              {report.charterInbox.sameTenantAsSender && (
                <p className="mt-2 text-[10px] text-amber-200/80" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  Notifications are sent from a subdomain of this mailbox&apos;s own domain, so its
                  tenant treats the emailed copy as spoofed and filters it. Copies are written
                  directly into the mailbox instead.
                </p>
              )}
              {report.charterInbox.lastError && (
                <p className="mt-1 text-[10px] text-red-300 break-all" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {report.charterInbox.lastError}
                </p>
              )}
            </div>
          )}

          {/* Per-message outcome straight from the provider */}
          {report.recentDeliveries?.length > 0 && (
            <div className="border border-slate-800 bg-slate-900/40 p-3 space-y-1">
              <div className="text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                PROVIDER DELIVERY OUTCOME
              </div>
              {report.recentDeliveries.map((d) => (
                <div key={d.queueId} className="flex items-start justify-between gap-3">
                  <span className="text-[11px] text-slate-300 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                    {d.subject || '(no subject)'}
                  </span>
                  <span
                    className={`shrink-0 text-[10px] ${
                      d.lastEvent === 'delivered' ? 'text-emerald-300'
                        : d.lastEvent ? 'text-amber-300' : 'text-slate-500'
                    }`}
                    style={{ fontFamily: 'JetBrains Mono, monospace' }}
                  >
                    {d.lastEvent || d.error || 'unknown'}
                  </span>
                </div>
              ))}
              {report.deliveredButUnseenHint && (
                <p className="pt-1 text-[10px] text-slate-500" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                  {report.deliveredButUnseenHint}
                </p>
              )}
            </div>
          )}

          {/* Failures */}
          {queue.failures?.length > 0 && (
            <div className="border border-slate-800 bg-slate-900/40 p-3 space-y-2">
              <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                RECENT FAILURES
              </div>
              {queue.failures.map((f) => (
                <div key={f.queueId} className="border border-slate-800/80 p-2 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] text-slate-200 truncate" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                        {f.subject || '(no subject)'}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                        {(f.to || []).join(', ')} · {f.status} · {f.attempts} attempt{f.attempts === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => retryOne(f.queueId)}
                      disabled={busy === f.queueId}
                      className="shrink-0 px-2 py-1 text-[10px] tracking-widest border border-slate-700 text-slate-300 hover:border-cyan-500/40 disabled:opacity-50"
                      style={{ fontFamily: 'JetBrains Mono, monospace' }}
                    >
                      {busy === f.queueId ? '…' : 'RETRY'}
                    </button>
                  </div>
                  <div className="text-[10px] text-amber-200/80" style={{ fontFamily: 'DM Sans, sans-serif' }}>
                    {f.explanation}
                  </div>
                  {f.lastError && (
                    <div className="text-[9px] text-slate-500 break-all" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                      {f.lastError}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Test send */}
          <div className="border border-slate-800 bg-slate-900/40 p-3 space-y-2">
            <div className="text-[10px] tracking-widest text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              TEST SEND
            </div>
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 text-slate-200 text-sm"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            />
            <button
              type="button"
              onClick={runTest}
              disabled={busy === 'test' || !testTo.trim()}
              className="w-full inline-flex items-center justify-center gap-2 py-2 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 text-xs tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {busy === 'test'
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> SENDING…</>
                : <><Send className="w-3.5 h-3.5" /> SEND TEST EMAIL</>}
            </button>
          </div>

          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 py-2 border border-slate-700 text-slate-300 hover:border-cyan-500/40 text-xs tracking-widest disabled:opacity-50"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> RE-CHECK
          </button>
        </div>
      ) : null}
    </section>
  );
}
