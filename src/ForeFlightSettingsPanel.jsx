/**
 * Settings → ForeFlight Dispatch connection panel.
 * Stores the operator's Dispatch API key server-side and registers the webhook.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { brand } from './brand.js';

async function idToken() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser.getIdToken();
}

export default function ForeFlightSettingsPanel({ currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const refresh = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    setError(null);
    try {
      const token = await idToken();
      const r = await fetch('/api/foreflight-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setStatus(data);
      if (data.vendorId) setVendorId(data.vendorId);
    } catch (err) {
      setError(err.message || 'Failed to load ForeFlight status');
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => { refresh(); }, [refresh]);

  async function save() {
    if (!isAdmin || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const token = await idToken();
      const r = await fetch('/api/foreflight-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: token,
          action: 'save',
          apiKey: apiKey.trim() || undefined,
          vendorId: vendorId.trim() || undefined,
          enabled: true,
          registerWebhook: true,
          rotateWebhookSecret: !status?.hasWebhookSecret,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setStatus(data);
      setApiKey('');
      setInfo(
        data.webhookRegistered
          ? `Connected${data.organisationName ? ` to ${data.organisationName}` : ''}. Webhook registered at ${data.webhookUrl}.`
          : `API key saved${data.webhookError ? ` — webhook: ${data.webhookError}` : ''}.`,
      );
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!isAdmin || busy) return;
    if (!window.confirm('Disconnect ForeFlight Dispatch? Linked flight IDs on trips are kept, but sync stops until a new key is saved.')) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const token = await idToken();
      const r = await fetch('/api/foreflight-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, action: 'clear' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setStatus(data);
      setInfo('ForeFlight Dispatch disconnected.');
    } catch (err) {
      setError(err.message || 'Disconnect failed');
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const token = await idToken();
      const r = await fetch('/api/foreflight-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, action: 'test' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const org = data.result?.info?.organisationName || data.result?.info?.organisationUUID;
      setInfo(org ? `Key OK — ${org}` : 'Key OK');
      await refresh();
    } catch (err) {
      setError(err.message || 'Test failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="text-xs tracking-widest text-cyan-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
        FOREFLIGHT DISPATCH
      </h3>

      <p className="text-xs text-slate-400 mb-3" style={{ fontFamily: 'DM Sans, sans-serif' }}>
        Connect {brand().name} to your ForeFlight Dispatch account so the Flight Plan tab can create, update, and release flights, and receive filing / OOOI webhooks. Requires a Dispatch subscription and an API key from Dispatch → Tools → API Console.
      </p>

      {info && (
        <div className="mb-3 p-2 border border-emerald-500/40 bg-emerald-500/5 text-xs text-emerald-300">{info}</div>
      )}
      {error && (
        <div className="mb-3 p-2 border border-red-500/40 bg-red-500/5 text-xs text-red-300">{error}</div>
      )}

      {loading ? (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking connection...
        </div>
      ) : status?.connected ? (
        <div className="space-y-2">
          <div className="p-3 border border-emerald-500/40 bg-emerald-500/5">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="text-sm text-slate-100" style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 600 }}>
                {status.organisationName || 'Connected'}
              </span>
            </div>
            <div className="text-[10px] text-slate-500 space-y-0.5" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              {status.organisationUUID && <div>Org: {status.organisationUUID}</div>}
              {status.vendorId && <div>Vendor ID: {status.vendorId}</div>}
              <div>Webhook: {status.webhookRegistered ? status.webhookUrl : 'not registered'}</div>
              {status.lastWebhookAt && <div>Last webhook: {new Date(status.lastWebhookAt).toLocaleString()}</div>}
              {status.updatedByName && <div>Updated by: {status.updatedByName}</div>}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={testConnection}
              disabled={busy}
              className="py-2 border border-slate-700 text-slate-300 hover:border-cyan-500/40 text-xs tracking-widest disabled:opacity-50"
              style={{ fontFamily: 'JetBrains Mono, monospace' }}
            >
              {busy ? 'WORKING…' : 'TEST CONNECTION'}
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={clear}
                disabled={busy}
                className="py-2 border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs tracking-widest disabled:opacity-50"
                style={{ fontFamily: 'JetBrains Mono, monospace' }}
              >
                DISCONNECT
              </button>
            )}
          </div>
          {isAdmin && (
            <details className="text-[10px] text-slate-500" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
              <summary className="cursor-pointer hover:text-slate-300">Replace API key</summary>
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="New Dispatch API key"
                  className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 text-slate-200"
                />
                <input
                  type="text"
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                  placeholder="Vendor ID (optional)"
                  className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 text-slate-200"
                />
                <button
                  type="button"
                  onClick={save}
                  disabled={busy || !apiKey.trim()}
                  className="w-full py-2 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-xs tracking-widest disabled:opacity-50"
                >
                  SAVE KEY + REGISTER WEBHOOK
                </button>
              </div>
            </details>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {!isAdmin ? (
            <div className="p-2 border border-slate-700 bg-slate-900/40 text-[11px] text-slate-500">
              An administrator must connect ForeFlight Dispatch.
            </div>
          ) : (
            <>
              <label className="block">
                <span className="block text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  DISPATCH API KEY
                </span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste key from Dispatch → Tools → API Console"
                  className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 text-slate-200 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </label>
              <label className="block">
                <span className="block text-[10px] tracking-widest text-slate-500 mb-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  VENDOR ID (optional)
                </span>
                <input
                  type="text"
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                  placeholder="x-vendorId from ForeFlight"
                  className="w-full px-2 py-1.5 bg-slate-950 border border-slate-800 text-slate-200 text-sm"
                  style={{ fontFamily: 'JetBrains Mono, monospace' }}
                />
              </label>
              <button
                type="button"
                onClick={save}
                disabled={busy || !apiKey.trim()}
                className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-medium tracking-widest"
                style={{ fontFamily: 'DM Sans, sans-serif', fontWeight: 700 }}
              >
                {busy ? 'CONNECTING…' : 'CONNECT FOREFLIGHT DISPATCH'}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
