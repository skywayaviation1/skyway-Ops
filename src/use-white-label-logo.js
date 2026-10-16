import { useEffect, useState } from 'react';

/** Load a board logo through the token endpoint. Image tags skip fetch stubs. */
export function useWhiteLabelLogo(token, enabled = true) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!enabled || !token) {
      setUrl(null);
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    (async () => {
      try {
        const response = await fetch(`/api/white-label-logo?token=${encodeURIComponent(token)}`);
        if (!response.ok) return;
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setUrl(objectUrl);
      } catch {
        if (!cancelled) setUrl(null);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, enabled]);

  return url;
}
