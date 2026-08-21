import { useState } from 'react';
import type { CatalogueEntry } from '@orbit/shared-types';
import { Modal } from './Modal.js';
import { ApiError, api } from '../lib/api.js';

/**
 * The form for a store that authenticates with keys.
 *
 * The fields come from the catalogue rather than being written per provider, so
 * adding a service is a catalogue entry and not a form. The endpoint is
 * assembled from those fields on the server: a user pastes an account id or a
 * region, never a URL they could mistype into something that silently signs
 * wrong.
 */
export function ConnectDialog({
  entry,
  onClose,
  onConnected,
}: {
  entry: CatalogueEntry;
  onClose: () => void;
  onConnected: () => void;
}) {
  // The default region is prefilled rather than left blank: it is right far
  // more often than not, and a wrong region signs a request that fails without
  // saying the region was the problem.
  const [values, setValues] = useState<Record<string, string>>(() =>
    entry.defaultRegion ? { region: entry.defaultRegion } : ({} as Record<string, string>),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = entry.fields ?? [];

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api('/api/accounts/connect', {
        method: 'POST',
        body: { catalogueKey: entry.key, values },
      });
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={`Connect ${entry.label}`}
      description={`${entry.blurb} Orbit stores these keys encrypted and uses them only to reach this bucket.`}
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: '0.9rem' }}>

        {fields.map((field) => (
          <label key={field.name} style={{ display: 'grid', gap: 5 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {field.label}
              {field.optional && (
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (optional)</span>
              )}
            </span>

            <input
              className="clay-sunken"
              style={{
                border: 0,
                padding: '0.65rem 0.9rem',
                font: 'inherit',
                color: 'var(--text)',
                borderRadius: 'var(--radius-sm)',
              }}
              type={field.secret ? 'password' : 'text'}
              // A secret pasted into a field the browser has offered to
              // remember ends up in a password manager under the wrong name.
              autoComplete={field.secret ? 'new-password' : 'off'}
              spellCheck={false}
              placeholder={field.placeholder ?? ''}
              value={values[field.name] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value }))
              }
            />

            {field.help && (
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{field.help}</span>
            )}
          </label>
        ))}

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 13.5 }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: '0.2rem' }}>
          <button type="button" className="clay-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="clay-button clay-button--accent" disabled={busy}>
            {busy ? 'Checking…' : 'Connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
