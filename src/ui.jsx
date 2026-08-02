/* =============================================================================
   SKYWAY UI PRIMITIVES
   =============================================================================
   Shared building blocks so screens stop re-deriving their own spacing,
   borders, empty states and button styling. Everything here is token-based
   (see tailwind.config.js + index.css), so it renders correctly in both the
   dark and light themes without a parallel override sheet.

   Conventions these enforce:
     • Semantic tones: success / warning / danger / info / accent / neutral.
       A warning is never cyan.
     • 11px floor on type. Mono is for codes, times and tail numbers only.
     • Sentence case labels; ALL CAPS is reserved for status chips.
   ============================================================================= */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

/* ─── TONES ────────────────────────────────────────────────────────────────
   One table, used by every status surface. `dot` is the solid swatch,
   `soft` is the filled-chip treatment, `text` is standalone colored text.
   ─────────────────────────────────────────────────────────────────────────── */
export const TONES = {
  neutral: {
    dot: 'bg-content-subtle',
    text: 'text-content-muted',
    soft: 'bg-surface-raised text-content-muted border-edge',
    solid: 'bg-content-subtle text-content-inverse',
  },
  accent: {
    dot: 'bg-accent',
    text: 'text-accent',
    soft: 'bg-accent-soft text-accent border-accent-border',
    solid: 'bg-accent text-accent-contrast',
  },
  success: {
    dot: 'bg-success',
    text: 'text-success',
    soft: 'bg-success-soft text-success border-success-border',
    solid: 'bg-success text-content-inverse',
  },
  warning: {
    dot: 'bg-warning',
    text: 'text-warning',
    soft: 'bg-warning-soft text-warning border-warning-border',
    solid: 'bg-warning text-content-inverse',
  },
  danger: {
    dot: 'bg-danger',
    text: 'text-danger',
    soft: 'bg-danger-soft text-danger border-danger-border',
    solid: 'bg-danger text-content-inverse',
  },
  info: {
    dot: 'bg-info',
    text: 'text-info',
    soft: 'bg-info-soft text-info border-info-border',
    solid: 'bg-info text-content-inverse',
  },
};

/* Maps the legacy color-name tones scattered through App.jsx onto the
   semantic set, so old call sites keep working while they migrate.
   Note `amber` now resolves to a real amber — it used to render cyan. */
const LEGACY_TONE_ALIASES = {
  amber: 'warning',
  yellow: 'warning',
  green: 'success',
  emerald: 'success',
  red: 'danger',
  rose: 'danger',
  cyan: 'accent',
  sky: 'info',
  blue: 'info',
  violet: 'info',
  purple: 'info',
  slate: 'neutral',
  gray: 'neutral',
};

export function resolveTone(tone) {
  if (!tone) return 'neutral';
  if (TONES[tone]) return tone;
  return LEGACY_TONE_ALIASES[tone] || 'neutral';
}

/* ─── BUTTON ──────────────────────────────────────────────────────────────── */
const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-contrast hover:opacity-90 border border-transparent',
  secondary: 'bg-surface-raised text-content border border-edge hover:border-edge-strong',
  ghost: 'bg-transparent text-content-muted border border-transparent hover:text-content hover:bg-surface-raised',
  outline: 'bg-transparent text-content border border-edge hover:border-accent-border hover:text-accent',
  danger: 'bg-danger text-content-inverse hover:opacity-90 border border-transparent',
  'danger-outline': 'bg-transparent text-danger border border-danger-border hover:bg-danger-soft',
  success: 'bg-success text-content-inverse hover:opacity-90 border border-transparent',
};

const BUTTON_SIZES = {
  sm: 'h-8 px-3 text-2xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading = false,
  disabled = false,
  block = false,
  className = '',
  type = 'button',
  ...rest
}) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      disabled={isDisabled}
      className={cx(
        'inline-flex items-center justify-center rounded font-semibold tracking-normal',
        'transition-colors select-none whitespace-nowrap',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.secondary,
        BUTTON_SIZES[size] || BUTTON_SIZES.md,
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading
        ? <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        : Icon ? <Icon className="w-4 h-4 shrink-0" /> : null}
      {children}
      {IconRight && !loading && <IconRight className="w-4 h-4 shrink-0" />}
    </button>
  );
}

/* Square icon-only button. Always pass a title — it is the accessible name. */
export function IconButton({ icon: Icon, title, variant = 'ghost', size = 'md', className = '', ...rest }) {
  const box = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cx(
        'inline-flex items-center justify-center rounded transition-colors shrink-0',
        BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.ghost,
        box,
        className,
      )}
      {...rest}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

/* ─── STATUS ──────────────────────────────────────────────────────────────── */

/**
 * The canonical status pill. Sentence case for descriptive states
 * ("Airborne", "Needs review"); pass `mono` for codes like VFR or N444AM.
 */
export function StatusChip({ children, tone = 'neutral', icon: Icon, mono = false, size = 'md', className = '' }) {
  const t = TONES[resolveTone(tone)];
  const sizing = size === 'sm' ? 'h-5 px-1.5 text-2xs gap-1' : 'h-6 px-2 text-2xs gap-1.5';
  return (
    <span
      className={cx(
        'inline-flex items-center rounded border font-semibold whitespace-nowrap',
        mono && 'font-mono tracking-wide',
        sizing, t.soft, className,
      )}
    >
      {Icon && <Icon className="w-3 h-3 shrink-0" />}
      {children}
    </span>
  );
}

export function StatusDot({ tone = 'neutral', pulse = false, className = '' }) {
  const t = TONES[resolveTone(tone)];
  return (
    <span className={cx('relative inline-flex h-2 w-2 shrink-0', className)}>
      {pulse && <span className={cx('absolute inset-0 rounded-full opacity-60 animate-ping', t.dot)} />}
      <span className={cx('relative rounded-full h-2 w-2', t.dot)} />
    </span>
  );
}

/* ─── SURFACES ────────────────────────────────────────────────────────────── */
export function Card({ children, className = '', padded = true, as: Tag = 'div', ...rest }) {
  return (
    <Tag
      className={cx(
        'rounded-md border border-edge bg-surface shadow-card',
        padded && 'p-4',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ title, subtitle, action, icon: Icon, className = '' }) {
  return (
    <div className={cx('flex items-start justify-between gap-3 mb-3', className)}>
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-content truncate">
          {Icon && <Icon className="w-4 h-4 text-content-muted shrink-0" />}
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-2xs text-content-muted">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Screen-level heading. Use once per screen, above the content grid. */
export function PageHeader({ title, subtitle, actions, className = '' }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 flex-wrap mb-5', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-content leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-content-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
    </div>
  );
}

/** Small label above a group of rows. Replaces the 9px all-caps mono headers. */
export function SectionLabel({ children, count, className = '' }) {
  return (
    <div className={cx('flex items-center gap-2 text-2xs font-semibold text-content-muted', className)}>
      <span>{children}</span>
      {count != null && <span className="font-mono text-content-subtle">{count}</span>}
    </div>
  );
}

/** Dashboard KPI tile. `value` stays display-font; the label is sentence case. */
export function MetricTile({ label, value, hint, tone = 'neutral', icon: Icon, className = '' }) {
  const t = TONES[resolveTone(tone)];
  return (
    <div className={cx('rounded-md border border-edge bg-surface px-4 py-3 shadow-card', className)}>
      <div className="flex items-center gap-1.5 text-2xs font-medium text-content-muted">
        {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
        <span className="truncate">{label}</span>
      </div>
      <div className={cx('mt-1 font-display text-3xl leading-none', tone === 'neutral' ? 'text-content' : t.text)}>
        {value}
      </div>
      {hint && <div className="mt-1 text-2xs text-content-subtle truncate">{hint}</div>}
    </div>
  );
}

/** Consistent zero-state. Always give the user the next action if there is one. */
export function EmptyState({ icon: Icon, title, description, action, className = '' }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center px-6 py-12', className)}>
      {Icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-edge bg-surface-raised">
          <Icon className="w-5 h-5 text-content-subtle" />
        </div>
      )}
      <p className="text-sm font-semibold text-content">{title}</p>
      {description && <p className="mt-1 max-w-sm text-2xs leading-relaxed text-content-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label, className = '' }) {
  return (
    <div className={cx('flex items-center justify-center gap-2 py-12 text-sm text-content-muted', className)}>
      <Loader2 className="w-4 h-4 animate-spin" />
      {label && <span>{label}</span>}
    </div>
  );
}

/* ─── TOASTS ──────────────────────────────────────────────────────────────────
   Replaces window.alert(). Alerts block the main thread, ignore the theme, and
   on iOS standalone PWAs render with the site origin in the title bar — all
   three read as unfinished software.

   Usage:
     const toast = useToast();
     toast.success('Duty started');
     toast.error('Could not reach the server', { description: err.message });
   ─────────────────────────────────────────────────────────────────────────── */
const ToastContext = createContext(null);

const TOAST_ICONS = {
  success: CheckCircle2,
  danger: XCircle,
  warning: AlertTriangle,
  info: Info,
  neutral: Info,
};

let toastSeq = 0;

/* Module-level bridge so non-component code — event handlers deep inside
   large screens, async callbacks, catch blocks — can raise a toast without
   threading a hook through. ToastProvider registers itself on mount; before
   that (or on the public token-only routes) it degrades to console. */
let activeToastSink = null;

function emit(tone, message, opts) {
  if (activeToastSink) return activeToastSink(tone, message, opts);
  const line = `[toast:${tone}] ${message}`;
  if (tone === 'danger') console.error(line);
  else if (tone === 'warning') console.warn(line);
  else console.info(line);
  return null;
}

/**
 * Drop-in replacement for window.alert(). Native alerts block the main
 * thread, ignore the app theme, and on an installed iOS PWA render with the
 * raw origin in the title bar.
 */
export const notify = {
  success: (message, opts) => emit('success', message, opts),
  error: (message, opts) => emit('danger', message, opts),
  warning: (message, opts) => emit('warning', message, opts),
  info: (message, opts) => emit('info', message, opts),
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((tone, message, opts = {}) => {
    const id = `toast-${++toastSeq}`;
    const duration = opts.duration ?? (tone === 'danger' ? 7000 : 4000);
    setToasts((list) => [
      // Cap the stack so a retry loop can't paper over the whole screen.
      ...list.slice(-2),
      { id, tone, message, description: opts.description, action: opts.action },
    ]);
    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
    }
    return id;
  }, [dismiss]);

  useEffect(() => {
    activeToastSink = push;
    return () => { if (activeToastSink === push) activeToastSink = null; };
  }, [push]);

  useEffect(() => {
    const map = timers.current;
    return () => { map.forEach(clearTimeout); map.clear(); };
  }, []);

  const api = useMemo(() => ({
    show: push,
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('danger', m, o),
    warning: (m, o) => push('warning', m, o),
    info: (m, o) => push('info', m, o),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] sm:items-end sm:px-6"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => {
        const tone = resolveTone(t.tone);
        const Icon = TOAST_ICONS[tone] || Info;
        return (
          <div
            key={t.id}
            role="status"
            aria-live="polite"
            className={cx(
              'pointer-events-auto w-full max-w-sm animate-toast-in rounded-md border bg-surface',
              'px-3.5 py-3 shadow-overlay flex items-start gap-2.5',
              TONES[tone].soft.replace(/bg-\S+/, 'bg-surface'),
            )}
          >
            <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', TONES[tone].text)} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-content">{t.message}</p>
              {t.description && (
                <p className="mt-0.5 break-words text-2xs leading-relaxed text-content-muted">{t.description}</p>
              )}
              {t.action && (
                <button
                  type="button"
                  onClick={() => { t.action.onClick?.(); onDismiss(t.id); }}
                  className={cx('mt-2 text-2xs font-semibold underline underline-offset-2', TONES[tone].text)}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              className="-m-1 shrink-0 rounded p-1 text-content-subtle transition-colors hover:text-content"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Safe outside a provider: falls back to console so a component rendered in
 * an isolated public route (aog-tech, trip-track) never crashes on a toast.
 */
export function useToast() {
  const ctx = useContext(ToastContext);
  return useMemo(() => ctx || {
    show: (_t, m) => console.warn('[toast]', m),
    success: (m) => console.info('[toast:success]', m),
    error: (m) => console.error('[toast:error]', m),
    warning: (m) => console.warn('[toast:warning]', m),
    info: (m) => console.info('[toast:info]', m),
    dismiss: () => {},
  }, [ctx]);
}
