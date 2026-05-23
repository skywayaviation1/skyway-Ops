// SignaturePad.jsx — drawn signature capture.
//
// Renders an HTML canvas the user can sign on with mouse or touch.
// Returns the signature as a base64 PNG string via the onSign callback,
// or null if the pad is cleared.
//
// Designed to live inside a modal — pad fills its container width,
// fixed-ish height. No external dependency (avoid signature_pad lib;
// the basic implementation is small).

import React, { useRef, useEffect, useState } from 'react';
import { Eraser } from 'lucide-react';

export default function SignaturePad({
  onChange,           // (dataUrl | null) => void — called when signature changes
  height = 120,
  disabled = false,
  label = 'SIGNATURE',
}) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastRef = useRef({ x: 0, y: 0 });
  const [hasInk, setHasInk] = useState(false);

  // Set up canvas — DPI scaling so the signature is crisp on retina,
  // resize observer so it follows container width changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const setupCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = '#e2e8f0';   // slate-200 for ink
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Set up a subtle baseline like a real signature line
      ctx.fillStyle = '#1e293b';     // slate-800
      ctx.fillRect(0, rect.height - 1, rect.width, 1);
    };
    setupCanvas();

    const ro = new ResizeObserver(setupCanvas);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Get pointer position in canvas-local coords, accounting for DPI
  const getPointer = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    if (e.touches && e.touches[0]) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDraw = (e) => {
    if (disabled) return;
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = getPointer(e);
  };

  const draw = (e) => {
    if (disabled || !drawingRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const p = getPointer(e);
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    if (!hasInk) {
      setHasInk(true);
      if (onChange) onChange(canvas.toDataURL('image/png'));
    }
  };

  const endDraw = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (hasInk && onChange) {
      onChange(canvasRef.current.toDataURL('image/png'));
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Redraw baseline
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, rect.height - 1, rect.width, 1);
    setHasInk(false);
    if (onChange) onChange(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[10px] tracking-widest text-slate-400" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          {label}
        </label>
        {hasInk && !disabled && (
          <button
            onClick={clear}
            type="button"
            className="text-[10px] tracking-widest text-slate-500 hover:text-slate-300 flex items-center gap-1"
            style={{ fontFamily: 'JetBrains Mono, monospace' }}
          >
            <Eraser className="w-3 h-3" /> CLEAR
          </button>
        )}
      </div>
      <div
        className={`bg-slate-800/40 border ${hasInk ? 'border-cyan-500/40' : 'border-slate-700 border-dashed'}`}
        style={{ height: `${height}px` }}
      >
        <canvas
          ref={canvasRef}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={endDraw}
          onMouseLeave={endDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={endDraw}
          style={{
            width: '100%',
            height: '100%',
            cursor: disabled ? 'not-allowed' : 'crosshair',
            display: 'block',
            touchAction: 'none',
          }}
        />
      </div>
      {!hasInk && (
        <p className="text-[10px] text-slate-600 mt-1" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
          Sign with mouse or finger above the line. Optional — submitting also captures your authenticated identity.
        </p>
      )}
    </div>
  );
}
