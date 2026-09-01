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
    arrLeadMinutes: 120,
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
        arrLeadMinutes: data.arrLeadMinutes || 120,
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
        subtitle={`${brand.name} caller ID ${SKYWAY_CALLER_ID_DISPLAY}. Vapi + Twilio.`}
        icon={Phone}
      />
      {loading ? (
        <p className="text-sm text-content-muted"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />Loading…</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <StatusChip tone={status?.configured ? 'success' : 'warning'} size="sm">
              {status?.configured
                ? (status?.phoneNumberLookup === 'automatic_by_number' ? 'Vapi key detected' : 'Vapi configured')
                : 'Vapi keys missing'}
            </StatusChip>
            <StatusChip tone={form.enabled ? 'success' : 'neutral'} size="sm">
              {form.enabled ? 'Enabled' : 'Disabled'}
            </StatusChip>
            {status?.configured && (
              <StatusChip tone={status?.hasWebhookSecret ? 'success' : 'warning'} size="sm">
                {status?.hasWebhookSecret ? 'Webhook secret set' : 'VAPI_WEBHOOK_SECRET missing'}
              </StatusChip>
            )}
            {status?.configured && (
              <StatusChip tone={status?.promptSource === 'dashboard' ? 'info' : 'neutral'} size="sm">
                {status?.promptSource === 'dashboard'
                  ? 'Prompt and voice from Vapi Dashboard'
                  : 'Prompt and voice built into Skyway'}
              </StatusChip>
            )}
            {status?.configured && status?.phoneNumberLookup === 'automatic_by_number' && (
              <StatusChip tone="info" size="sm">
                Finding +1 (813) 859-5943 in Vapi automatically
              </StatusChip>
            )}
          </div>
          {!status?.configured && (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-content">
              <p className="font-semibold">
                This deployment cannot see {(status?.missing || []).join(' or ') || 'the Vapi keys'}.
              </p>
              <p className="mt-1 text-content-muted">
                Skyway reads these on the server at request time, so a value added in Vercel applies
                only to deployments created after it was saved. In Vercel, confirm the variable is on
                the <strong>Production</strong> environment for this project, then redeploy. Check for
                a stray leading or trailing space in the name.
              </p>
            </div>
          )}
          {(status?.warnings || []).map((warning) => (
            <p key={warning} className="flex items-start gap-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{warning}
            </p>
          ))}
          <p className="text-sm leading-relaxed text-content-muted">
            Outbound FBO calls require ops to arm each trip. Peter does not provide passenger names
            or make operational decisions. FBO details come from the uploaded trip sheet; arrival
            re-verification is fixed at two hours before arrival.
          </p>
          {status?.configured && (
            <p className="text-sm leading-relaxed text-content-muted">
              {status?.promptSource === 'dashboard'
                ? 'Because VAPI_ASSISTANT_ID is set, each call uses that saved assistant’s Vapi prompt and voice. Skyway still supplies trip variables and the transcript, recording, and live-listen settings. Set VAPI_PROMPT_SOURCE=skyway to use Skyway’s built-in prompt instead.'
                : 'Calls use Skyway’s built-in prompt and voice. To manage the prompt and voice in the Vapi Dashboard, set VAPI_ASSISTANT_ID to that assistant and redeploy.'}
            </p>
          )}
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
