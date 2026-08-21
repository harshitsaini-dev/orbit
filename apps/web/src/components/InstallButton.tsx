import { useEffect, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Installs Orbit as an app.
 *
 * The browser decides when this is possible — it fires `beforeinstallprompt`
 * only once the app meets its criteria and the user has not already installed
 * it — so the button appears when it will work and stays hidden when it would
 * do nothing. A button that does nothing is worse than no button.
 */
export function InstallButton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // An already-installed app runs in standalone display mode.
    if (window.matchMedia('(display-mode: standalone)').matches) {
      setInstalled(true);
      return;
    }

    function onPrompt(event: Event) {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setPrompt(null);
    }

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || !prompt) return null;

  return (
    <button
      type="button"
      className={className ?? 'clay-button icon-button'}
      style={style}
      onClick={() => {
        void prompt.prompt().then(async () => {
          const choice = await prompt.userChoice;
          // The event is single-use; keeping it would offer a prompt that the
          // browser refuses to show a second time.
          if (choice.outcome === 'accepted') setInstalled(true);
          setPrompt(null);
        });
      }}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
        <path d="M12 3.6v10.6" />
        <path d="M7.8 10 12 14.2 16.2 10" />
        <path d="M4.8 17.4v1.6a1.4 1.4 0 0 0 1.4 1.4h11.6a1.4 1.4 0 0 0 1.4-1.4v-1.6" />
      </svg>
      Install app
    </button>
  );
}
