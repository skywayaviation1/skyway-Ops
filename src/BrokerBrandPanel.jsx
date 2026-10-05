// Broker white-label editor.
//
// Ops and admin attach a logo, an optional public name, and an accent to a
// broker email. The public tracking page reads that record. Sales can share
// a link; this screen is the only place the logo is uploaded.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { Button, ScreenHeader, cx } from './ui.jsx';
import {
  BROKER_LOGO_LIMIT_LABEL,
  brokerDocId,
  contentTypeForFile,
  validateLogoMeta,
} from './broker-brand.js';
import './track-brand.css';

async function postBrand(getIdToken, payload) {
  const idToken = await getIdToken();
  if (!idToken) throw new Error('Sign in required.');
  const response = await fetch('/api/broker-brand', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({ idToken, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || 'Could not save broker branding.');
  }
  return data;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function LogoPlate({ src, alt }) {
  return (
    <div className="track-logo-plate">
      {src ? (
        <img src={src} alt={alt || 'Broker logo'} />
      ) : (
        <span className="px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-500" style={{ lineHeight: 1.2 }}>
          Logo
        </span>
      )}
    </div>
  );
}

export default function BrokerBrandPanel({
  email = '',
  getIdToken,
  embedded = false,
  onSaved,
}) {
  const [displayName, setDisplayName] = useState('');
  const [accentColor, setAccentColor] = useState('');
  const [showPoweredBy, setShowPoweredBy] = useState(false);
  const [hasLogo, setHasLogo] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingPreview, setPendingPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);
  const previewRef = useRef('');

  const revokePreview = useCallback((url) => {
    if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
  }, []);

  useEffect(() => () => revokePreview(previewRef.current), [revokePreview]);

  const loadLogo = useCallback(async (brokerEmail, tokenGetter) => {
    const idToken = await tokenGetter();
    if (!idToken) return '';
    const response = await fetch(`/api/broker-logo?email=${encodeURIComponent(brokerEmail)}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) return '';
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const address = String(email || '').trim();
    setError('');
    setInfo('');
    setPendingFile(null);
    revokePreview(previewRef.current);
    previewRef.current = '';
    setPendingPreview('');
    if (!address || !brokerDocId(address)) {
      setDisplayName('');
      setAccentColor('');
      setShowPoweredBy(false);
      setHasLogo(false);
      setLogoUrl('');
      return undefined;
    }
    const timer = setTimeout(() => {
      (async () => {
        setLoading(true);
        try {
          const data = await postBrand(getIdToken, { action: 'get', email: address });
          if (cancelled) return;
          const broker = data.broker || {};
          setDisplayName(broker.displayName || '');
          setAccentColor(broker.accentColor || '');
          setShowPoweredBy(broker.showPoweredBy === true);
          setHasLogo(broker.hasLogo === true);
          if (broker.hasLogo) {
            const url = await loadLogo(address, getIdToken);
            if (cancelled) {
              revokePreview(url);
              return;
            }
            setLogoUrl(url);
          } else {
            setLogoUrl('');
          }
        } catch (err) {
          if (!cancelled) setError(err.message || 'Could not load this broker.');
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [email, getIdToken, loadLogo, revokePreview]);

  const shownLogo = pendingPreview || logoUrl;

  const chooseFile = (file) => {
    setError('');
    setInfo('');
    if (!file) return;
    const contentType = contentTypeForFile(file);
    const check = validateLogoMeta({ contentType, byteLength: file.size });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    revokePreview(previewRef.current);
    const url = URL.createObjectURL(file);
    previewRef.current = url;
    setPendingPreview(url);
    setPendingFile(file);
  };

  const onSave = async () => {
    const address = String(email || '').trim();
    if (!address) {
      setError('Enter the broker email first.');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      let data;
      if (pendingFile) {
        const contentType = contentTypeForFile(pendingFile);
        const dataBase64 = await readFileAsBase64(pendingFile);
        data = await postBrand(getIdToken, {
          action: 'upload',
          email: address,
          contentType,
          fileName: pendingFile.name,
          dataBase64,
          displayName,
          accentColor,
          showPoweredBy,
        });
      } else {
        data = await postBrand(getIdToken, {
          action: 'save',
          email: address,
          displayName,
          accentColor,
          showPoweredBy,
        });
      }
      const broker = data.broker || {};
      setDisplayName(broker.displayName || '');
      setAccentColor(broker.accentColor || '');
      setShowPoweredBy(broker.showPoweredBy === true);
      setHasLogo(broker.hasLogo === true);
      setPendingFile(null);
      revokePreview(previewRef.current);
      previewRef.current = '';
      setPendingPreview('');
      if (broker.hasLogo) {
        const url = await loadLogo(address, getIdToken);
        setLogoUrl(url);
      }
      setInfo(broker.hasLogo
        ? 'Saved. Tracking links for this broker now use their logo.'
        : 'Saved. Add a logo before the public page switches off operator branding.');
      onSaved?.(broker);
    } catch (err) {
      setError(err.message || 'Could not save broker branding.');
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    const address = String(email || '').trim();
    if (!address) return;
    if (pendingFile && !hasLogo) {
      setPendingFile(null);
      revokePreview(previewRef.current);
      previewRef.current = '';
      setPendingPreview('');
      return;
    }
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const data = await postBrand(getIdToken, { action: 'removeLogo', email: address });
      setHasLogo(false);
      setLogoUrl('');
      setPendingFile(null);
      revokePreview(previewRef.current);
      previewRef.current = '';
      setPendingPreview('');
      setInfo('Logo removed. Tracking links for this broker use operator branding again.');
      onSaved?.(data.broker);
    } catch (err) {
      setError(err.message || 'Could not remove the logo.');
    } finally {
      setBusy(false);
    }
  };

  const plateAccent = accentColor || '#9AA0A8';

  return (
    <section className={cx(embedded ? 'rounded-lg border border-edge bg-surface p-3' : 'rounded-xl border border-edge bg-surface p-4 shadow-card')}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-content">White-label tracking</h2>
          <p className="mt-0.5 text-2xs leading-relaxed text-content-muted">
            {email
              ? 'This logo, name, and color appear on every public tracking link for this broker.'
              : 'Enter a broker email to upload their logo.'}
          </p>
        </div>
        {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-content-muted" />}
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </div>
      )}
      {info && (
        <div className="mb-3 rounded-md border border-success-border bg-success-soft px-3 py-2 text-xs text-success" role="status">
          {info}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
        <div>
          <div
            className={cx(
              'rounded-xl border border-dashed p-3 transition-colors',
              dragOver ? 'border-accent bg-accent-soft' : 'border-edge bg-surface-sunken',
            )}
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              chooseFile(event.dataTransfer.files?.[0]);
            }}
          >
            <div className="flex justify-center" style={{ ['--broker-accent']: plateAccent }}>
              <LogoPlate src={shownLogo} alt={displayName || email || 'Broker logo'} />
            </div>
            <p className="mt-2 text-center text-[10px] leading-relaxed text-content-subtle">
              PNG, JPG, or SVG · {BROKER_LOGO_LIMIT_LABEL} max
              <br />
              Shown on a white plate, so wide and square marks both fit.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={!email || busy}
                onClick={() => inputRef.current?.click()}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {shownLogo ? 'Replace' : 'Upload logo'}
              </Button>
              {(shownLogo || hasLogo) && (
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
              className="sr-only"
              aria-label="Broker logo file"
              onChange={(event) => {
                chooseFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              Public name
            </span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Meridian Charter"
              maxLength={80}
              disabled={!email || busy}
              className="w-full rounded-lg border border-edge bg-surface-raised px-3 py-2 text-sm text-content outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-content-subtle">
              Accent color
            </span>
            <span className="flex items-center gap-2">
              <input
                type="color"
                value={accentColor || '#1F6B4A'}
                aria-label="Accent color"
                disabled={!email || busy}
                onChange={(event) => setAccentColor(event.target.value.toUpperCase())}
                className="h-9 w-12 cursor-pointer rounded-md border border-edge bg-surface-raised p-1"
              />
              <input
                value={accentColor}
                onChange={(event) => setAccentColor(event.target.value)}
                placeholder="#1F6B4A"
                maxLength={7}
                disabled={!email || busy}
                className="w-full rounded-lg border border-edge bg-surface-raised px-3 py-2 font-mono text-sm text-content outline-none focus:border-accent"
              />
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs text-content-muted">
            <input
              type="checkbox"
              checked={showPoweredBy}
              disabled={!email || busy}
              onChange={(event) => setShowPoweredBy(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-edge accent-cyan-500"
            />
            <span>
              Show a small “Powered by” line. Off by default. Contact details stay hidden either way.
            </span>
          </label>
            <Button type="button" variant="primary" disabled={!email || busy || loading} onClick={onSave}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save branding
          </Button>
          <p className="text-[10px] leading-relaxed text-content-subtle">
            The public page keeps operator branding until a logo is saved. File limit {BROKER_LOGO_LIMIT_LABEL}.
          </p>
        </div>
      </div>
    </section>
  );
}

export function BrokerDirectory({ getIdToken }) {
  const [brokers, setBrokers] = useState([]);
  const [email, setEmail] = useState('');
  const [draft, setDraft] = useState('');
  const [listError, setListError] = useState('');
  const [opened, setOpened] = useState(false);

  const reload = useCallback(async () => {
    try {
      const data = await postBrand(getIdToken, { action: 'list' });
      setBrokers(Array.isArray(data.brokers) ? data.brokers : []);
      setListError('');
    } catch (err) {
      setListError(err.message || 'Could not load brokers.');
    }
  }, [getIdToken]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (opened || email || !brokers[0]?.email) return;
    setEmail(brokers[0].email);
    setDraft(brokers[0].email);
    setOpened(true);
  }, [brokers, email, opened]);

  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return brokers;
    return brokers.filter((broker) =>
      String(broker.email || '').includes(q)
      || String(broker.displayName || '').toLowerCase().includes(q));
  }, [brokers, draft]);

  const openEmail = (value) => {
    const next = String(value || '').trim();
    if (!next) return;
    setOpened(true);
    setEmail(next);
    setDraft(next);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-shell">
      <ScreenHeader
        title="Brokers"
        subtitle="Logo and colors on the tracking link they share"
      />
      <div className="mx-auto grid w-full max-w-5xl flex-1 gap-4 overflow-y-auto p-4 md:grid-cols-[280px_minmax(0,1fr)] md:p-6">
        <aside className="rounded-xl border border-edge bg-surface p-3 shadow-card">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              openEmail(draft);
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="broker@company.com"
              aria-label="Broker email"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-raised px-3 py-2 text-sm text-content outline-none focus:border-accent"
            />
            <Button type="submit" size="sm">Open</Button>
          </form>
          {listError && <p className="mt-2 text-xs text-danger">{listError}</p>}
          <ul className="mt-3 max-h-[60vh] space-y-1 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-content-muted">
                No broker brands yet. Open an email to create one.
              </li>
            )}
            {filtered.map((broker) => (
              <li key={broker.email}>
                <button
                  type="button"
                  onClick={() => openEmail(broker.email)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left',
                    broker.email === email ? 'bg-accent-soft text-content' : 'hover:bg-surface-raised',
                  )}
                >
                  <Building2 className="h-4 w-4 shrink-0 text-content-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-content">
                      {broker.displayName || broker.email}
                    </span>
                    <span className="block truncate text-[10px] text-content-subtle">
                      {broker.hasLogo ? 'Logo on file' : 'No logo'}
                      {broker.displayName ? ` · ${broker.email}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <BrokerBrandPanel
          email={email}
          getIdToken={getIdToken}
          onSaved={reload}
        />
      </div>
    </div>
  );
}
