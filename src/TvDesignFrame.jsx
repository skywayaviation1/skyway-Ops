// 1920×1080 board scaled by min(100vw / 1920, 100vh / 1080), so a 4K
// panel is the same layout at double size. Chrome drops viewport units
// inside scale(), so the ratio is applied as a number from tvBoardScale.

import React, { useEffect, useState } from 'react';
import { tvBoardScale } from './flight-board-tv.js';

export default function TvDesignFrame({ children, marker = 'data-tv-board' }) {
  const [scale, setScale] = useState(() => (
    typeof window === 'undefined' ? 1 : tvBoardScale(window.innerWidth, window.innerHeight)
  ));

  useEffect(() => {
    const apply = () => setScale(tvBoardScale(window.innerWidth, window.innerHeight));
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  const attr = marker === 'data-board-signin' ? { 'data-board-signin': '' } : { 'data-tv-board': '' };
  return (
    <div className="h-screen w-screen overflow-hidden bg-slate-950">
      <div
        {...attr}
        style={{
          width: 1920,
          height: 1080,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {children}
      </div>
    </div>
  );
}
