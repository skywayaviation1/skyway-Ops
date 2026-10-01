import { useEffect, useRef } from 'react';

const INTERACTIVE = 'button, a, [role="button"], input[type="submit"], input[type="button"]';

function labelFor(element) {
  return String(
    element?.dataset?.auditLabel
    || element?.getAttribute?.('aria-label')
    || element?.getAttribute?.('title')
    || element?.textContent
    || '',
  ).replace(/\s+/g, ' ').trim().slice(0, 160);
}

export default function AppAuditTracker({ currentUser, currentSection }) {
  const lastRef = useRef({ key: '', at: 0 });

  useEffect(() => {
    if (!currentUser?.uid) return undefined;
    const log = async (action, summary) => {
      const key = `${action}:${summary}:${currentSection}`;
      const now = Date.now();
      if (lastRef.current.key === key && now - lastRef.current.at < 750) return;
      lastRef.current = { key, at: now };
      try {
        const { auth } = await import('./firebase.js');
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) return;
        await fetch('/api/audit-events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            idToken,
            action: 'ingest',
            event: { action, summary, section: currentSection },
          }),
        });
      } catch {
        // Auditing must never block an operational action.
      }
    };

    const onClick = (event) => {
      const target = event.target?.closest?.(INTERACTIVE);
      if (!target) return;
      const label = labelFor(target);
      if (label) log('ui.click', label);
    };
    const onSubmit = (event) => {
      const label = labelFor(event.target?.querySelector?.('button[type="submit"]'))
        || event.target?.getAttribute?.('aria-label')
        || 'Submitted form';
      log('ui.submit', label);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit, true);
    };
  }, [currentSection, currentUser?.uid]);

  return null;
}

