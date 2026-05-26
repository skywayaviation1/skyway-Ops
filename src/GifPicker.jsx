// GifPicker.jsx — modal that lets users search KLIPY GIFs and pick one
// to send to the current chat.
//
// Loaded lazily (only when a user actually opens the picker) so first
// chat render isn't paying for it. Calls /api/gif-search which proxies
// to KLIPY server-side, so the API key never reaches the browser.
//
// Tap a GIF → calls onPick({ url, previewUrl, name, width, height }) and
// the parent (CommsScreen) handles posting it as a message attachment
// with kind: 'gif'. BubbleChat renders gifs inline the same way images.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Loader2, AlertTriangle } from 'lucide-react';
import { auth } from './firebase.js';

// Small debounce for the search input — KLIPY allows free use but
// hitting them on every keystroke is rude and slow.
function useDebounced(value, ms = 350) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return out;
}

async function fetchWithAuth(url) {
  const user = auth.currentUser;
  const headers = {};
  if (user) {
    try {
      const token = await user.getIdToken();
      headers['Authorization'] = `Bearer ${token}`;
    } catch (_) {}
  }
  const r = await fetch(url, { headers });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default function GifPicker({ open, onClose, onPick }) {
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 350);
  const [gifs, setGifs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [errCode, setErrCode] = useState('');
  const inputRef = useRef(null);

  // Reset when opened. Auto-focus the search box so the user can type
  // immediately without tapping.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setErr('');
    setErrCode('');
    setTimeout(() => { try { inputRef.current?.focus(); } catch (_) {} }, 50);
  }, [open]);

  // Load: trending if empty query, search otherwise.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErr('');
    setErrCode('');
    (async () => {
      const url = debouncedQ.trim()
        ? `/api/gif-search?action=search&q=${encodeURIComponent(debouncedQ.trim())}&limit=24`
        : `/api/gif-search?action=trending&limit=24`;
      const { ok, data } = await fetchWithAuth(url);
      if (cancelled) return;
      if (!ok || !data?.ok) {
        setGifs([]);
        setErr(data?.error || 'Could not load GIFs');
        setErrCode(data?.code || '');
      } else {
        setGifs(Array.isArray(data.gifs) ? data.gifs : []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, debouncedQ]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl sm:my-8 flex flex-col min-h-screen sm:min-h-0 sm:max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 shrink-0">
          <div>
            <h3 className="text-lg tracking-wider text-slate-100" style={{ fontFamily: 'Bebas Neue, sans-serif' }}>
              SEND A GIF
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">Powered by KLIPY</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-slate-800 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search KLIPY..."
              className="w-full bg-slate-800 border border-slate-700 pl-9 pr-3 py-2 text-sm text-slate-100"
              style={{ fontFamily: 'DM Sans, sans-serif' }}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {err ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center text-sm">
              <AlertTriangle className="w-8 h-8 text-amber-400 mb-3" />
              <p className="text-amber-200 max-w-md">{err}</p>
              {errCode === 'klipy-not-configured' && (
                <p className="text-xs text-slate-500 mt-3">
                  Once a KLIPY API key is added to Vercel and the app redeploys, GIFs will work.
                </p>
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
            </div>
          ) : gifs.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-slate-500 text-sm">
              No GIFs found{q.trim() ? ` for "${q.trim()}"` : ''}.
            </div>
          ) : (
            // Masonry-ish: 2 cols on small phones, 3 on regular phones, 4 desktop.
            // Each GIF preserves its aspect ratio so the grid feels alive instead
            // of cropping everything into uniform squares.
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {gifs.map((g) => (
                <button
                  key={g.id}
                  onClick={() => onPick(g)}
                  className="block border border-transparent hover:border-cyan-400 bg-slate-800 overflow-hidden focus:outline-none focus:border-cyan-400"
                  title={g.name}
                  aria-label={`Send ${g.name}`}
                >
                  <img
                    src={g.previewUrl}
                    alt={g.name}
                    loading="lazy"
                    className="block w-full h-auto"
                    style={{ aspectRatio: g.width && g.height ? `${g.width}/${g.height}` : 'auto' }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-3 py-2 shrink-0 flex items-center justify-between">
          <p className="text-[10px] text-slate-500 tracking-widest" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            VIA KLIPY · CONTENT-FILTERED
          </p>
          <button
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-200 tracking-widest"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            CLOSE
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
