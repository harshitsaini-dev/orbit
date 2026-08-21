import { useCallback, useEffect, useRef, useState } from 'react';
import { FileIcon } from './FileIcon.js';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * Orbit's own player for audio and video.
 *
 * The native controls are a different shape and colour in every browser, cannot
 * be themed, and on video they sit inside the frame — so a portrait clip loses
 * its bottom to a control bar drawn by someone else. These are drawn here, in
 * the same language as the rest of the app, and sit outside the frame.
 *
 * Seeking works because the content route honours Range; without that, dragging
 * the scrubber on a large file would stall while the whole thing downloaded.
 */
export function MediaPlayer({
  src,
  kind,
  name,
  mimeType,
}: {
  src: string;
  kind: 'video' | 'audio';
  name: string;
  mimeType: string;
}) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);

  const isVideo = kind === 'video';

  const toggle = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => setFailed(true));
    else media.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(media.duration)) return;
    media.currentTime = Math.min(Math.max(media.currentTime + delta, 0), media.duration);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // A key pressed in a field is for the field, not the player.
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      switch (event.key) {
        case ' ':
        case 'k':
          event.preventDefault();
          toggle();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          seekBy(-5);
          break;
        case 'ArrowRight':
          event.preventDefault();
          seekBy(5);
          break;
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const media = mediaRef.current;
          if (!media) break;
          const next = Math.min(Math.max(media.volume + (event.key === 'ArrowUp' ? 0.1 : -0.1), 0), 1);
          media.volume = next;
          setVolume(next);
          setMuted(next === 0);
          break;
        }
        case 'm':
          if (mediaRef.current) {
            const next = !mediaRef.current.muted;
            mediaRef.current.muted = next;
            setMuted(next);
          }
          break;
        case 'f':
          if (isVideo) toggleFullscreen();
          break;
        default:
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isVideo, seekBy, toggle, toggleFullscreen]);

  /** Controls fade out of the way while a video plays, and come back on movement. */
  const nudgeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!isVideo) return;

    hideTimer.current = window.setTimeout(() => {
      if (!mediaRef.current?.paused) setControlsVisible(false);
    }, 2600);
  }, [isVideo]);

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  function onSeek(event: React.ChangeEvent<HTMLInputElement>): void {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = Number(event.target.value);
    setTime(media.currentTime);
  }

  const mediaProps = {
    ref: mediaRef as never,
    src,
    onClick: isVideo ? toggle : undefined,
    onPlay: () => {
      setPlaying(true);
      nudgeControls();
    },
    onPause: () => {
      setPlaying(false);
      setControlsVisible(true);
    },
    onTimeUpdate: () => setTime(mediaRef.current?.currentTime ?? 0),
    onDurationChange: () => setDuration(mediaRef.current?.duration ?? 0),
    onLoadedMetadata: () => setDuration(mediaRef.current?.duration ?? 0),
    onWaiting: () => setWaiting(true),
    onPlaying: () => setWaiting(false),
    onError: () => setFailed(true),
    onProgress: () => {
      const media = mediaRef.current;
      if (!media || media.buffered.length === 0) return;
      setBuffered(media.buffered.end(media.buffered.length - 1));
    },
    onEnded: () => {
      setPlaying(false);
      setControlsVisible(true);
    },
  };

  if (failed) {
    return (
      <div className="clay" style={{ padding: '1.5rem', display: 'grid', gap: 10, placeItems: 'center', textAlign: 'center' }}>
        <FileIcon name={name} mimeType={mimeType} isFolder={false} size={48} />
        <strong>This file cannot be played here</strong>
        <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0, maxWidth: '40ch' }}>
          The browser has no decoder for {mimeType || 'this format'}. Downloading it and opening it
          in a player will work.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      className={fullscreen ? 'media-shell media-shell--fullscreen' : 'media-shell'}
      onPointerMove={nudgeControls}
      onPointerLeave={() => {
        if (isVideo && playing) setControlsVisible(false);
      }}
    >
      <div className="media-shell__stage">
        {isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video {...mediaProps} playsInline className="media-shell__video" />
        ) : (
          <div className="clay" style={{ padding: '2rem 2.5rem', display: 'grid', gap: 14, placeItems: 'center' }}>
            <FileIcon name={name} mimeType={mimeType} isFolder={false} size={64} />
            <strong style={{ maxWidth: '32ch', textAlign: 'center', overflowWrap: 'anywhere' }}>{name}</strong>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio {...mediaProps} />
          </div>
        )}

        {waiting && (
          <span className="media-shell__spinner" role="status" aria-label="Buffering">
            <span />
          </span>
        )}
      </div>

      <div className="media-shell__controls" data-hidden={isVideo && !controlsVisible ? '' : undefined}>
        <div className="scrim-bar media-shell__bar">
          <button
            type="button"
            className="clay-button"
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            style={ICON_BUTTON}
          >
            {playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>

          <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 42, textAlign: 'right' }}>
            {formatTime(time)}
          </span>

          <span className="media-shell__scrub">
            {/* The buffered band sits behind the range input, so the track shows
                how much is actually ready to play. */}
            <span
              className="media-shell__buffered"
              style={{ width: duration > 0 ? `${Math.min(100, (buffered / duration) * 100)}%` : 0 }}
            />
            <input
              type="range"
              min={0}
              max={duration || 0}
              step="any"
              value={time}
              onChange={onSeek}
              aria-label="Seek"
              style={{ ['--played' as string]: duration > 0 ? `${(time / duration) * 100}%` : '0%' }}
            />
          </span>

          <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 42 }}>
            {formatTime(duration)}
          </span>

          <button
            type="button"
            className="clay-button"
            onClick={() => {
              const media = mediaRef.current;
              if (!media) return;
              media.muted = !media.muted;
              setMuted(media.muted);
            }}
            aria-label={muted ? 'Unmute' : 'Mute'}
            style={ICON_BUTTON}
          >
            {muted || volume === 0 ? <MutedGlyph /> : <VolumeGlyph />}
          </button>

          <input
            className="media-shell__volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(event) => {
              const media = mediaRef.current;
              if (!media) return;
              const next = Number(event.target.value);
              media.volume = next;
              media.muted = next === 0;
              setVolume(next);
              setMuted(next === 0);
            }}
            aria-label="Volume"
            style={{ ['--played' as string]: `${(muted ? 0 : volume) * 100}%` }}
          />

          <button
            type="button"
            className="clay-button"
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
              if (mediaRef.current) mediaRef.current.playbackRate = next;
              setSpeed(next);
            }}
            aria-label={`Playback speed ${speed}x`}
            style={{ ...ICON_BUTTON, width: 'auto', padding: '0.3rem 0.6rem', fontSize: 12 }}
          >
            {speed}×
          </button>

          {isVideo && (
            <button
              type="button"
              className="clay-button"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
              style={ICON_BUTTON}
            >
              {fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const ICON_BUTTON = {
  padding: '0.3rem',
  width: 32,
  display: 'grid',
  placeItems: 'center',
} as const;

const glyph = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  'aria-hidden': true,
  style: { display: 'block' },
} as const;

const PlayGlyph = () => (
  <svg {...glyph} fill="currentColor">
    <path d="M7.5 5.2v13.6l11-6.8z" />
  </svg>
);

const PauseGlyph = () => (
  <svg {...glyph} fill="currentColor">
    <rect x="6.4" y="5.2" width="3.9" height="13.6" rx="1.3" />
    <rect x="13.7" y="5.2" width="3.9" height="13.6" rx="1.3" />
  </svg>
);

const VolumeGlyph = () => (
  <svg {...glyph} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.6 9.4h3l4-3.2v11.6l-4-3.2h-3z" />
    <path d="M15.2 9.4a3.6 3.6 0 0 1 0 5.2" />
    <path d="M17.8 7a7 7 0 0 1 0 10" />
  </svg>
);

const MutedGlyph = () => (
  <svg {...glyph} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.6 9.4h3l4-3.2v11.6l-4-3.2h-3z" />
    <path d="M15.4 10.2l4.2 4.2M19.6 10.2l-4.2 4.2" />
  </svg>
);

const FullscreenGlyph = () => (
  <svg {...glyph} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.6 9V5.6a1 1 0 0 1 1-1H9" />
    <path d="M15 4.6h3.4a1 1 0 0 1 1 1V9" />
    <path d="M19.4 15v3.4a1 1 0 0 1-1 1H15" />
    <path d="M9 19.4H5.6a1 1 0 0 1-1-1V15" />
  </svg>
);

const ExitFullscreenGlyph = () => (
  <svg {...glyph} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4.6V8a1 1 0 0 1-1 1H4.6" />
    <path d="M15 4.6V8a1 1 0 0 0 1 1h3.4" />
    <path d="M15 19.4V16a1 1 0 0 1 1-1h3.4" />
    <path d="M9 19.4V16a1 1 0 0 0-1-1H4.6" />
  </svg>
);
