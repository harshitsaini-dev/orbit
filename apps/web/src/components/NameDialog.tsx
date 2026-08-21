import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DialogActions, Modal } from './Modal.js';

/**
 * Naming a folder or renaming a file.
 *
 * Renaming preselects the stem rather than the whole name, the way a file
 * manager does — the extension is almost never the part being changed.
 */
export function NameDialog({
  title,
  description,
  initialValue = '',
  confirmLabel,
  busy,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  initialValue?: string;
  confirmLabel: string;
  busy?: boolean;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.focus();

    const dot = initialValue.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initialValue]);

  const trimmed = value.trim();
  // The characters no common filesystem or provider accepts in a name.
  const invalid = /[\\/:*?"<>|]/.test(trimmed);
  const unchanged = trimmed === initialValue.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || invalid || unchanged || busy) return;
    onSubmit(trimmed);
  }

  return (
    <Modal title={title} description={description} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: '0.9rem' }}>
        <input
          ref={inputRef}
          value={value}
          maxLength={255}
          aria-label={title}
          onChange={(event) => setValue(event.target.value)}
          className="clay-sunken"
          style={{
            border: 0,
            padding: '0.75rem 1rem',
            font: 'inherit',
            color: 'var(--text)',
            borderRadius: 'var(--radius-sm)',
          }}
        />

        {invalid && (
          <p role="alert" style={{ color: 'var(--danger)', fontSize: 13, margin: 0 }}>
            {'A name cannot contain \\ / : * ? " < > |'}
          </p>
        )}

        <DialogActions>
          <button
            type="button"
            className="clay-button"
            style={{ padding: '0.45rem 1.1rem', fontSize: 14 }}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="clay-button clay-button--accent"
            style={{ padding: '0.45rem 1.1rem', fontSize: 14 }}
            disabled={!trimmed || invalid || unchanged || busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </DialogActions>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} description={description} onClose={onClose}>
      <DialogActions>
        <button
          type="button"
          className="clay-button"
          style={{ padding: '0.45rem 1.1rem', fontSize: 14 }}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="clay-button"
          style={{
            padding: '0.45rem 1.1rem',
            fontSize: 14,
            background: destructive ? 'var(--danger)' : 'var(--accent)',
            color: '#fff',
          }}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </DialogActions>
    </Modal>
  );
}
