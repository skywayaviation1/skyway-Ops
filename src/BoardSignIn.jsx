// Full-screen sign-in for the office TV. Same Microsoft auth as the app,
// with type large enough to read from across the room.

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import TvDesignFrame from './TvDesignFrame.jsx';
import { Wordmark } from './ui.jsx';

function MicrosoftMark({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#f25022" d="M1 1h10v10H1z" />
      <path fill="#7fba00" d="M13 1h10v10H13z" />
      <path fill="#00a4ef" d="M1 13h10v10H1z" />
      <path fill="#ffb900" d="M13 13h10v10H13z" />
    </svg>
  );
}

export default function BoardNeedsSignIn({ authError = null }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleMicrosoftLogin = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { signInWithMicrosoft } = await import('./firebase-auth.js');
      await signInWithMicrosoft();
      setSubmitting(false);
    } catch (err) {
      setSubmitting(false);
      setError(err?.message || 'Microsoft sign-in did not start.');
    }
  };

  const detail = error || authError?.message || '';

  return (
    <TvDesignFrame marker="data-board-signin">
      <main className="flex h-full w-full flex-col items-center justify-center bg-slate-950 px-16 text-center text-slate-100">
        <Wordmark className="h-24 w-auto" surface="dark" />
        <h1 className="mt-12 max-w-5xl font-mono text-6xl font-bold leading-tight tracking-wide text-slate-50">
          This display needs a one-time Microsoft sign-in.
        </h1>
        <p className="mt-8 max-w-3xl font-mono text-2xl leading-relaxed text-slate-400">
          Sign in once with an approved company account. The flight board stays up after that.
        </p>
        {detail && (
          <p className="mt-6 max-w-3xl font-mono text-xl text-red-300">{detail}</p>
        )}
        <button
          type="button"
          onClick={handleMicrosoftLogin}
          disabled={submitting}
          className="mt-12 flex h-20 items-center justify-center gap-4 rounded-lg border border-slate-400 bg-white px-10 font-mono text-2xl font-semibold text-slate-900 disabled:opacity-60"
        >
          {submitting
            ? <Loader2 className="h-8 w-8 animate-spin" />
            : <MicrosoftMark className="h-8 w-8" />}
          {submitting ? 'Opening Microsoft…' : 'Continue with Microsoft'}
        </button>
      </main>
    </TvDesignFrame>
  );
}
