import React, { useEffect, useState } from 'react';
import { RefreshCw, WifiOff } from 'lucide-react';
import { getLiveLink, subscribeLiveLink } from './live-link.js';

/**
 * Thin strip under the top bar. Hidden while Firestore is delivering server
 * snapshots. Shown when the device is offline or listeners are stuck on
 * cache / error, so a pending milestone list is not mistaken for the truth.
 */
export default function LiveLinkBanner() {
  const [link, setLink] = useState(getLiveLink);

  useEffect(() => subscribeLiveLink(setLink), []);

  if (link.phase === 'live') return null;

  const offline = link.phase === 'offline';
  const Icon = offline ? WifiOff : RefreshCw;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-center justify-center gap-2 border-b border-warning-border bg-warning-soft px-3 py-1.5 text-center"
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 text-warning ${offline ? '' : 'animate-spin'}`} />
      <span className="font-mono text-[10px] font-semibold tracking-wide text-warning">
        {offline
          ? 'Offline — live updates are paused'
          : 'Reconnecting — this screen may be out of date'}
      </span>
    </div>
  );
}
