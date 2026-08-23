import { useCallback, useEffect, useState } from 'react';
import { WEBHOOK_EVENTS } from '@orbit/shared-types';
import { ApiError, api } from '../lib/api.js';
import { Checkbox } from './Checkbox.js';
import { DialogActions, Modal } from './Modal.js';
import { ConfirmDialog } from './NameDialog.js';

/**
 * Somewhere to be told when something happened.
 *
 * The other half of the developer platform. A token lets a program ask Orbit
 * questions; a webhook lets Orbit answer one nobody has asked yet, which is the
 * difference between a script that polls every minute and one that runs when
 * there is something to do.
 *
 * The screen is built around the two questions people actually have about a
 * webhook - "did it ever fire" and "what did my server say" - so the delivery
 * history is one click from the list rather than something to be inferred from
 * logs at the other end.
 */

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  event: string;
  status: number | null;
  error: string | null;
  attempts: number;
  durationMs: number;
  sentAt: string;
}

function when(iso: string | null): string {
  if (!iso) return 'never';

  const minutes = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function Webhooks() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ secret: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showing, setShowing] = useState<Webhook | null>(null);

  const load = useCallback(async () => {
    try {
      const { webhooks } = await api<{ webhooks: Webhook[] }>('/api/webhooks');
      setHooks(webhooks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load webhooks');
      setHooks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function test(hook: Webhook): Promise<void> {
    setBusyId(hook.id);
    setError(null);

    try {
      const { delivery } = await api<{ delivery: Delivery }>(
        `/api/webhooks/${hook.id}/test`,
        { method: 'POST' },
      );

      // What the receiver said, not whether Orbit managed to ask. A 500 from
      // the far end is a successful test that found a real problem.
      setError(
        delivery.status && delivery.status < 300
          ? null
          : `The receiver answered ${delivery.status ?? delivery.error ?? 'nothing'}`,
      );

      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a test');
    } finally {
      setBusyId(null);
    }
  }

  async function toggle(hook: Webhook): Promise<void> {
    setBusyId(hook.id);

    try {
      await api(`/api/webhooks/${hook.id}`, { method: 'PATCH', body: { active: !hook.active } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change it');
    } finally {
      setBusyId(null);
    }
  }

  async function rotate(hook: Webhook): Promise<void> {
    setBusyId(hook.id);

    try {
      const { secret } = await api<{ secret: string }>(`/api/webhooks/${hook.id}/rotate`, {
        method: 'POST',
      });

      setIssued({ secret, name: hook.name });
      setCopied(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rotate the secret');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(hook: Webhook): Promise<void> {
    try {
      await api(`/api/webhooks/${hook.id}`, { method: 'DELETE' });
      setRemoving(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove it');
    }
  }

  return (
    <section className="clay" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Webhooks</h2>
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
            A POST to an address of yours when something happens, so a program does not have to
            keep asking whether anything has.
          </p>
        </div>

        <span style={{ flex: 1 }} />

        <button
          type="button"
          className="clay-button clay-button--accent"
          onClick={() => setCreating(true)}
        >
          Add a webhook
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)', margin: '0.8rem 0 0', fontSize: 13.5 }}>
          {error}
        </p>
      )}

      {hooks?.length === 0 && (
        <p style={{ color: 'var(--text-muted)', margin: '1rem 0 0', fontSize: 13.5 }}>
          None yet. Every delivery is signed, so the receiving end can tell one from anybody who
          guessed the address.
        </p>
      )}

      {hooks && hooks.length > 0 && (
        <ul className="webhook-list">
          {hooks.map((hook) => (
            <li key={hook.id} className="webhook">
              <div className="webhook__head">
                <span className="webhook__name">
                  <strong>{hook.name}</strong>
                  <span>{hook.url}</span>
                </span>

                <span
                  className="webhook__state"
                  data-state={hook.active ? 'on' : 'off'}
                  title={
                    hook.active
                      ? 'Deliveries are being sent'
                      : 'Switched off — either by you, or after ten failures in a row'
                  }
                >
                  {hook.active ? 'Active' : 'Off'}
                </span>
              </div>

              <p className="webhook__events">
                {hook.events.join(' · ')}
              </p>

              <p className="webhook__meta">
                Last delivery {when(hook.lastDeliveredAt)}
                {hook.lastStatus !== null && ` · answered ${hook.lastStatus}`}
                {hook.failureCount > 0 && ` · ${hook.failureCount} failed in a row`}
                {hook.lastError && ` · ${hook.lastError}`}
              </p>

              <div className="webhook__actions">
                <button
                  type="button"
                  className="clay-button"
                  disabled={busyId === hook.id}
                  onClick={() => void test(hook)}
                >
                  {busyId === hook.id ? 'Sending…' : 'Send a test'}
                </button>

                <button type="button" className="clay-button" onClick={() => setShowing(hook)}>
                  Deliveries
                </button>

                <button
                  type="button"
                  className="clay-button"
                  disabled={busyId === hook.id}
                  onClick={() => void toggle(hook)}
                >
                  {hook.active ? 'Turn off' : 'Turn on'}
                </button>

                <button
                  type="button"
                  className="clay-button"
                  disabled={busyId === hook.id}
                  title="The old secret stops working immediately"
                  onClick={() => void rotate(hook)}
                >
                  New secret
                </button>

                <button
                  type="button"
                  className="clay-button"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => setRemoving(hook)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateWebhook
          onClose={() => setCreating(false)}
          onCreated={(secret, name) => {
            setCreating(false);
            setIssued({ secret, name });
            setCopied(false);
            void load();
          }}
        />
      )}

      {issued && (
        <Modal title="Copy it now" onClose={() => setIssued(null)}>
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            This is the only time the secret for <strong>{issued.name}</strong> is shown. Your
            receiver needs it to check the signature on every delivery; if it is lost, make a new
            one here.
          </p>

          <code className="token-issued">{issued.secret}</code>

          <DialogActions>
            <button
              type="button"
              className="clay-button clay-button--accent"
              onClick={() => {
                void navigator.clipboard.writeText(issued.secret).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy secret'}
            </button>
            <button type="button" className="clay-button" onClick={() => setIssued(null)}>
              Done
            </button>
          </DialogActions>
        </Modal>
      )}

      {showing && <Deliveries hook={showing} onClose={() => setShowing(null)} />}

      {removing && (
        <ConfirmDialog
          title="Remove this webhook?"
          description={`Nothing will be sent to ${removing.url} again. This cannot be undone.`}
          confirmLabel="Remove"
          destructive
          onConfirm={() => void remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function CreateWebhook({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (secret: string, name: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const { secret } = await api<{ secret: string }>('/api/webhooks', {
        method: 'POST',
        body: { name: name.trim(), url: url.trim(), events },
      });

      onCreated(secret, name.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add it');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a webhook"
      description="Orbit will POST a signed JSON body to this address when one of the chosen things happens."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gap: '0.9rem' }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Name</span>
          <input
            className="clay-sunken webhook__field"
            placeholder="What is at the other end"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Address</span>
          <input
            className="clay-sunken webhook__field"
            placeholder="https://example.com/orbit"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Has to be reachable from the internet. Private and loopback addresses are refused.
          </span>
        </label>

        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>What to send</span>

          {WEBHOOK_EVENTS.map((event) => (
            <Checkbox
              key={event.name}
              checked={events.includes(event.name)}
              onChange={(on) =>
                setEvents((current) =>
                  on ? [...current, event.name] : current.filter((e) => e !== event.name),
                )
              }
              label={
                <span style={{ display: 'grid', gap: 2 }}>
                  <code style={{ fontSize: 12.5 }}>{event.name}</code>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {event.description}
                  </span>
                </span>
              }
            />
          ))}
        </div>

        {error && (
          <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 13.5 }}>
            {error}
          </p>
        )}

        <DialogActions>
          <button type="button" className="clay-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="clay-button clay-button--accent"
            disabled={busy || !name.trim() || !url.trim() || events.length === 0}
            onClick={() => void submit()}
          >
            {busy ? 'Adding…' : 'Add it'}
          </button>
        </DialogActions>
      </div>
    </Modal>
  );
}

/** What was sent and what came back, which is the first thing anybody asks. */
function Deliveries({ hook, onClose }: { hook: { id: string; name: string }; onClose: () => void }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);

  useEffect(() => {
    api<{ deliveries: Delivery[] }>(`/api/webhooks/${hook.id}/deliveries`)
      .then(({ deliveries }) => setRows(deliveries))
      .catch(() => setRows([]));
  }, [hook.id]);

  return (
    <Modal title={`Deliveries to ${hook.name}`} onClose={onClose}>
      <div style={{ display: 'grid', gap: '0.6rem' }}>
        {rows === null && <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading…</p>}

        {rows?.length === 0 && (
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 13.5 }}>
            Nothing sent yet. Send a test to see one land.
          </p>
        )}

        {rows && rows.length > 0 && (
          <ul className="delivery-list">
            {rows.map((row) => (
              <li key={row.id}>
                <code>{row.event}</code>
                <span
                  className="delivery__status"
                  data-ok={row.status !== null && row.status < 300 ? '' : undefined}
                >
                  {row.status ?? row.error ?? 'no answer'}
                </span>
                <span className="delivery__meta">
                  {when(row.sentAt)} · {row.durationMs}ms
                  {row.attempts > 1 && ` · ${row.attempts} attempts`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
