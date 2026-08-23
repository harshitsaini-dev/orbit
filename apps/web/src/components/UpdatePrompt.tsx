import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * Says when the page is running an old copy of itself.
 *
 * A service worker serves the app from its own cache, so a tab that was open
 * before a deploy keeps running the build it loaded with - indefinitely, and
 * with nothing on screen to say so. The update installs quietly in the
 * background and takes effect on the *next* load, which for an app somebody
 * leaves open is not soon.
 *
 * The failure mode that matters is not a missing feature. It is being told a
 * fix is live, looking at the same bug, and concluding the deploy did not
 * happen - which has happened here more than once.
 *
 * So: notice, say so, and offer the reload. Never reload on its own; a page
 * that refreshes itself mid-upload is worse than one that is a version behind.
 */
export function UpdatePrompt() {
  const [ready, setReady] = useState(false);
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const updateSW = registerSW({
      onNeedRefresh() {
        setReady(true);
      },
      onRegisteredSW(_url, registration) {
        if (!registration) return;

        /*
         * A tab left open all day would otherwise only check on load.
         *
         * Hourly is often enough to catch a deploy while somebody is still
         * looking, and rare enough to be invisible: it is a conditional
         * request for one small file.
         */
        setInterval(() => void registration.update(), 60 * 60 * 1000);
      },
    });

    setUpdate(() => () => updateSW(true));
  }, []);

  if (!ready) return null;

  return (
    <div className="update-prompt" role="status">
      <span>A new version of Orbit is ready.</span>
      <button
        type="button"
        className="clay-button clay-button--accent"
        onClick={() => void update?.()}
      >
        Reload
      </button>
      <button type="button" className="clay-button" onClick={() => setReady(false)}>
        Later
      </button>
    </div>
  );
}
