import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Phone } from 'lucide-react';
import { Button, Card, CardHeader, StatusChip } from './ui.jsx';
import { brand } from './brand.js';
import { SKYWAY_CALLER_ID_DISPLAY } from './fbo-call.js';

async function idToken() {
  const { auth } = await import('./firebase.js');
  return auth.currentUser?.getIdToken();
}

export default function FboCallSettingsPanel({ currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [form, setForm] = useState({
    enabled: false,
    depLeadMinutes: 120,
    arrLeadMinutes: 90,
    retryMinutes: 15,
    maxAttempts: 3,
    opsTransferNumber: SKYWAY_CALLER_ID_DISPLAY,
  });

  const refresh = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    setError(null);
    try {
      const token = await idToken();
      const response = await fetch('/api/fbo-call-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, action: 'status' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStatus(data);
      setForm({
        enabled: data.enabled === true,
        depLeadMinutes: data.depLeadMinutes || 120,
        arrLeadMinutes: data.arrLeadMinutes || 90,
        retryMinutes: data.retryMinutes || 15,
        maxAttempts: data.maxAttempts || 3,
        opsTransferNumber: data.opsTransferNumber || SKYWAY_CALLER_ID_DISPLAY,
      });
    } catch (err) {
      setError(err.message || 'Could not load FBO calling settings');
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
      const response = await fetch('/api/fbo-call-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token, action: 'save', ...form }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Save failed');
      setStatus(data);
      setInfo('FBO calling settings saved. Voice API keys stay in the server environment.');
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  const field = (key, label, type = 'number') => (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        disabled={!isAdmin}
        className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
      />
    </label>
  );

  return (
    <Card>
      <CardHeader
        title="FBO calling agent"
        subtitle={`${brand.name} caller ID ${brand.contactPhone || SKYWAY_CALLER_ID_DISPLAY}. Vapi + Twilio.`}
        icon={Phone}
      />
      {loading ? (
        <p className="text-sm text-content-muted"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading…</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <StatusChip tone={status?.configured ? 'success' : 'warning'} size="sm">
              {status?.configured ? 'Vapi configured' : 'Vapi keys missing'}
            </StatusChip>
            <StatusChip tone={form.enabled ? 'success' : 'neutral'} size="sm">
              {form.enabled ? 'Enabled' : 'Disabled'}
            </StatusChip>
          </div>
          <p className="text-sm leading-relaxed text-content-muted">
            Outbound FBO calls require ops to arm each trip. The agent may speak the lead passenger
            name only when ground transportation is on the trip. FBO details come from the uploaded
            trip sheet; if hours are absent, the agent says they are not on file.
          </p>
          <label className="flex items-center gap-2 text-sm text-content">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={!isAdmin}
              onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Enable outbound FBO calling
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('depLeadMinutes', 'Minutes before departure')}
            {field('arrLeadMinutes', 'Minutes before arrival')}
            {field('retryMinutes', 'Minutes between retries')}
            {field('maxAttempts', 'Maximum attempts')}
            {field('opsTransferNumber', 'Ops warm-transfer number', 'tel')}
          </div>
          {error && (
            <p className="flex items-start gap-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
            </p>
          )}
          {info && (
            <p className="flex items-start gap-2 text-sm text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{info}
            </p>
          )}
          {isAdmin && (
            <Button variant="primary" loading={busy} onClick={save}>Save FBO calling</Button>
          )}
        </div>
      )}
    </Card>
  );
}
