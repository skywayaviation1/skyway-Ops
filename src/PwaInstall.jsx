import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Copy, Download, PlusSquare, Share, Smartphone, X } from 'lucide-react';
import { Button, notify } from './ui.jsx';
import { isIosDevice, isStandaloneApp } from './auth-environment.js';

function isSafari(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|FBAN|FBAV|Instagram/.test(ua);
}

export function installEnvironment(win = globalThis.window, nav = globalThis.navigator) {
  const standalone = isStandaloneApp(win, nav);
  const ios = isIosDevice(nav);
  return {
    standalone,
    ios,
    safari: ios && isSafari(nav),
    canShare: typeof nav?.share === 'function',
  };
}

/** Captures Chromium's one-shot native install event and iOS manual state. */
export function usePwaInstall() {
  const [environment, setEnvironment] = useState(() => installEnvironment());
  const [deferredPrompt, setDeferredPrompt] = useState(
    () => globalThis.window?.__SKYWAY_INSTALL_PROMPT__ || null,
  );

  useEffect(() => {
    const refresh = () => setEnvironment(installEnvironment());
    const onPrompt = (event) => {
      event?.preventDefault?.();
      setDeferredPrompt(globalThis.window?.__SKYWAY_INSTALL_PROMPT__ || event || null);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      refresh();
      try { localStorage.setItem('skyway_pwa_installed', '1'); } catch {}
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('skyway:install-prompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('skyway:app-installed', onInstalled);
    const display = window.matchMedia?.('(display-mode: standalone)');
    display?.addEventListener?.('change', refresh);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('skyway:install-prompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('skyway:app-installed', onInstalled);
      display?.removeEventListener?.('change', refresh);
    };
  }, []);

  const promptNative = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') {
      setDeferredPrompt(null);
      window.__SKYWAY_INSTALL_PROMPT__ = null;
    }
    return choice?.outcome === 'accepted';
  };

  return {
    ...environment,
    nativePromptAvailable: Boolean(deferredPrompt),
    promptNative,
  };
}

export default function PwaInstall({ compact = false, className = '' }) {
  const install = usePwaInstall();
  const [open, setOpen] = useState(false);
  const visible = !install.standalone && (install.ios || install.nativePromptAvailable);

  if (!visible) return null;

  const start = async () => {
    if (install.nativePromptAvailable && !install.ios) {
      const accepted = await install.promptNative();
      if (accepted) notify.success('Skyway installed.');
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={compact ? 'sm' : 'md'}
        icon={Download}
        onClick={start}
        className={className}
      >
        {install.ios ? 'Install on iPhone' : 'Install app'}
      </Button>
      {open && <InstallGuide install={install} onClose={() => setOpen(false)} />}
    </>
  );
}

function InstallGuide({ install, onClose }) {
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const steps = useMemo(() => ([
    {
      icon: Share,
      title: 'Tap Share',
      body: 'In Safari, tap the Share button in the toolbar.',
    },
    {
      icon: PlusSquare,
      title: 'Add to Home Screen',
      body: 'Scroll the share sheet and choose Add to Home Screen.',
    },
    {
      icon: CheckCircle2,
      title: 'Open Skyway',
      body: 'Tap Add, then launch Skyway from its new Home Screen icon.',
    },
  ]), []);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.disabled && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      notify.error('Could not copy the link.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-skyway-title"
        className="w-full max-w-md rounded-t-2xl border border-edge-strong bg-surface shadow-overlay sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-edge p-4 sw-safe-top">
          <div className="flex items-center gap-3">
            <img src="/apple-touch-icon.png" alt="" className="h-12 w-12 rounded-[11px] border border-edge" />
            <div>
              <h2 id="install-skyway-title" className="text-base font-semibold text-content">Install Skyway</h2>
              <p className="mt-0.5 text-2xs text-content-muted">Full screen · push alerts · fast launch</p>
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg p-2 text-content-subtle hover:bg-surface-raised hover:text-content" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {!install.safari ? (
            <div className="rounded-xl border border-warning-border bg-warning-soft p-4">
              <div className="flex items-start gap-3">
                <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div>
                  <p className="text-sm font-semibold text-content">Open this page in Safari</p>
                  <p className="mt-1 text-2xs leading-relaxed text-content-muted">
                    iPhone only offers Add to Home Screen from Safari. Copy this link,
                    open Safari, paste it, then follow the three steps below.
                  </p>
                  <Button variant="outline" size="sm" icon={copied ? CheckCircle2 : Copy} onClick={copyLink} className="mt-3">
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-2xs leading-relaxed text-content-muted">
              Apple does not show a normal download prompt for web apps. Install it directly from Safari:
            </p>
          )}

          <ol className="mt-4 space-y-3">
            {steps.map(({ icon: Icon, title, body }, index) => (
              <li key={title} className="flex items-start gap-3 rounded-xl border border-edge bg-surface-sunken p-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent-border bg-accent-soft text-accent">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-content">{index + 1}. {title}</p>
                  <p className="mt-1 text-2xs leading-relaxed text-content-muted">{body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-4 rounded-xl border border-success-border bg-success-soft p-3 text-2xs leading-relaxed text-content-muted">
            <strong className="text-success">After installation:</strong> open Skyway from
            the Home Screen and sign in with your @flyskyway.com Microsoft account. You can
            then enable lock-screen message and operations alerts.
          </div>
        </div>
      </div>
    </div>
  );
}

