import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { OrbitHero } from '../components/OrbitHero.js';

const RESEND_COOLDOWN_SECONDS = 60;

export function Login() {
  const { user, mode, loading, requestCode, verifyCode } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (step === 'code') codeInputRef.current?.focus();
  }, [step]);

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  if (mode === 'local') return <Navigate to="/" replace />;

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestCode(email);
      setStep('code');
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyCode(email, code);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign you in. Try again.');
      setCode('');
      codeInputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError(null);
    try {
      await requestCode(email);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setError('Could not resend the code. Try again shortly.');
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 'clamp(1rem, 5vw, 3rem)',
      }}
    >
      <div className="clay" style={{ width: '100%', maxWidth: 420, padding: 'clamp(1.5rem, 5vw, 2.5rem)' }}>
        <div style={{ height: 160, margin: '-1rem 0 0' }}>
          <OrbitHero />
        </div>

        <h1 style={{ fontSize: '1.6rem', marginTop: '0.5rem' }}>
          {step === 'email' ? 'Sign in to Orbit' : 'Check your email'}
        </h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.4rem' }}>
          {step === 'email'
            ? 'We will email you a one-time code. No password needed.'
            : `We sent a 6-digit code to ${email}.`}
        </p>

        {step === 'email' ? (
          <form onSubmit={submitEmail} style={{ marginTop: '1.5rem', display: 'grid', gap: '0.9rem' }}>
            <label htmlFor="email" style={{ fontSize: 14, fontWeight: 600 }}>
              Email address
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="clay-sunken"
              style={{
                border: 0,
                padding: '0.85rem 1.1rem',
                font: 'inherit',
                color: 'var(--text)',
                borderRadius: 'var(--radius-sm)',
              }}
            />
            {error && <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>{error}</p>}
            <button type="submit" className="clay-button clay-button--accent" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode} style={{ marginTop: '1.5rem', display: 'grid', gap: '0.9rem' }}>
            <label htmlFor="code" style={{ fontSize: 14, fontWeight: 600 }}>
              6-digit code
            </label>
            <input
              id="code"
              ref={codeInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="clay-sunken"
              style={{
                border: 0,
                padding: '0.85rem 1.1rem',
                font: 'inherit',
                fontSize: 24,
                letterSpacing: '0.5em',
                textAlign: 'center',
                color: 'var(--text)',
                borderRadius: 'var(--radius-sm)',
              }}
            />
            {error && <p role="alert" style={{ color: 'var(--danger)', margin: 0, fontSize: 14 }}>{error}</p>}
            <button type="submit" className="clay-button clay-button--accent" disabled={busy || code.length < 6}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <button
                type="button"
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setError(null);
                }}
                style={{ background: 'none', border: 0, color: 'var(--text-muted)', cursor: 'pointer', padding: 0 }}
              >
                Use a different email
              </button>
              <button
                type="button"
                onClick={resend}
                disabled={cooldown > 0}
                style={{
                  background: 'none',
                  border: 0,
                  color: cooldown > 0 ? 'var(--text-muted)' : 'var(--accent)',
                  cursor: cooldown > 0 ? 'default' : 'pointer',
                  padding: 0,
                }}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
