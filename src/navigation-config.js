import { useEffect, useState } from 'react';
import { postJson } from './api-json.js';

export function isJakeCambria(user) {
  return String(user?.email || '').trim().toLowerCase() === 'jake@flyskyway.com';
}

export function isSuperAdmin(user) {
  return user?.superAdmin === true || isJakeCambria(user);
}

export function useRemoteNavigation(currentUser) {
  const [navigation, setNavigation] = useState(null);
  useEffect(() => {
    if (!currentUser?.uid) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const { auth } = await import('./firebase.js');
        const data = await postJson('/api/super-admin', {
          idToken: await auth.currentUser?.getIdToken(),
          action: 'get',
        });
        if (!cancelled) setNavigation(data.navigation || null);
      } catch {
        if (!cancelled) setNavigation(null);
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser?.uid]);
  return navigation;
}

