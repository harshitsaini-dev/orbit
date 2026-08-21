import { Router } from 'express';
import { z } from 'zod';
import { devAuthEndpointsEnabled, env } from '../lib/env.js';
import { requireAuth } from '../middleware/auth.js';
import { lastCodeFor, sendOtpEmail } from '../services/email.js';
import { issueOtp, OTP_TTL_MS, verifyOtp } from '../services/otp.js';
import {
  clearSessionCookie,
  createSession,
  revokeSession,
  setSessionCookie,
} from '../services/session.js';
import { findOrCreateByEmail } from '../services/users.js';

export const authRouter: Router = Router();

const requestSchema = z.object({ email: z.string().email().max(254) });
const verifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
});

/**
 * Step 1. Always answers the same way whether or not the address is known, and
 * whether or not a code was actually sent - anything else leaks which addresses
 * have accounts.
 */
authRouter.post('/auth/request-otp', async (req, res, next) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'A valid email is required' } });
    return;
  }

  if (env.AUTH_MODE === 'local') {
    res.status(400).json({
      error: { code: 'not_applicable', message: 'This instance runs in local mode and does not use codes' },
    });
    return;
  }

  const generic = { message: 'If that address can sign in, a code is on its way.' };

  try {
    const issued = await issueOtp(parsed.data.email);
    if (issued.ok) {
      await sendOtpEmail(parsed.data.email, issued.code, OTP_TTL_MS / 60_000);
    }
    res.json(generic);
  } catch (err) {
    next(err);
  }
});

/**
 * Step 2. Every failure returns the same 401 body for the same reason - a
 * caller must not be able to tell "no such code" from "wrong code".
 */
authRouter.post('/auth/verify-otp', async (req, res, next) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Email and a 6-digit code are required' } });
    return;
  }

  if (env.AUTH_MODE === 'local') {
    res.status(400).json({
      error: { code: 'not_applicable', message: 'This instance runs in local mode and does not use codes' },
    });
    return;
  }

  try {
    const result = await verifyOtp(parsed.data.email, parsed.data.code);
    if (!result.ok) {
      res.status(401).json({ error: { code: 'invalid_code', message: 'That code is not valid' } });
      return;
    }

    const user = await findOrCreateByEmail(parsed.data.email);
    const { token, expiresAt } = await createSession(user.id, {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
    setSessionCookie(res, token, expiresAt);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/logout', async (req, res, next) => {
  try {
    if (req.sessionId) await revokeSession(req.sessionId);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user, mode: env.AUTH_MODE });
});

/** Lets the frontend decide whether to show the sign-in screen at all. */
authRouter.get('/auth/mode', (_req, res) => {
  res.json({ mode: env.AUTH_MODE });
});

/**
 * Reads back the last code the console transport "sent". Requires an explicit
 * opt-in AND a non-production NODE_ENV, so it cannot exist on a real
 * deployment. Used by the E2E suite in place of a mailbox.
 */
authRouter.get('/auth/dev/last-code', (req, res) => {
  if (!devAuthEndpointsEnabled()) {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
    return;
  }

  const email = typeof req.query.email === 'string' ? req.query.email : '';
  const entry = lastCodeFor(email);
  if (!entry) {
    res.status(404).json({ error: { code: 'no_code', message: 'No code has been sent to that address' } });
    return;
  }

  res.json({ code: entry.code, sentAt: entry.sentAt });
});
