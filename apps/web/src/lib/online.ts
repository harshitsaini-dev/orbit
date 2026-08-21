import { useEffect, useState } from 'react';

/**
 * Whether the browser believes it has a network.
 *
 * `navigator.onLine` only knows about the link, not about whether anything at
 * the other end answers, so it says nothing about a captive portal or a server
 * that is down. It is trustworthy in one direction — false really does mean
 * nothing will get through — which is the direction that matters here.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // The events can fire between the first render and this effect running.
    setOnline(navigator.onLine);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
