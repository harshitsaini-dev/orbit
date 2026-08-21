import { users } from '@orbit/db';
import { ALLOCATION_STRATEGIES } from '@orbit/shared-types';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth } from '../middleware/auth.js';
import { toPublicUser } from '../services/session.js';

export const profileRouter: Router = Router();

/**
 * An avatar is app data rather than a user file, so it lives in the database
 * as a data URL. The cap is deliberately small: this is a 96px square, and
 * anything approaching a megabyte means the client failed to downscale it.
 */
export const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const dataUrlPattern = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/;

export function validateAvatar(value: string): { ok: true } | { ok: false; reason: string } {
  const match = dataUrlPattern.exec(value.trim());
  if (!match) return { ok: false, reason: 'Expected a base64 PNG, JPEG or WebP data URL' };

  const [, mime, base64] = match;
  if (!AVATAR_TYPES.includes(mime!)) return { ok: false, reason: 'Unsupported image type' };

  // base64 encodes three bytes as four characters; padding is not data.
  const padding = base64!.endsWith('==') ? 2 : base64!.endsWith('=') ? 1 : 0;
  const bytes = (base64!.length * 3) / 4 - padding;

  if (bytes > AVATAR_MAX_BYTES) {
    return { ok: false, reason: `Image is larger than ${Math.round(AVATAR_MAX_BYTES / 1024)} KB` };
  }
  return { ok: true };
}

profileRouter.get('/api/profile', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

const patchBody = z.object({
  displayName: z.string().trim().max(80).nullable().optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex colour')
    .optional(),
  language: z.string().trim().min(2).max(10).optional(),
  allocationStrategy: z.enum(ALLOCATION_STRATEGIES).optional(),
  /** null clears the avatar. */
  avatar: z.string().nullable().optional(),
});

profileRouter.patch('/api/profile', requireAuth, async (req, res, next) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Invalid profile' },
    });
    return;
  }

  const changes = parsed.data;

  if (typeof changes.avatar === 'string') {
    const check = validateAvatar(changes.avatar);
    if (!check.ok) {
      res.status(400).json({ error: { code: 'invalid_avatar', message: check.reason } });
      return;
    }
  }

  const update: Partial<typeof users.$inferInsert> = {};
  if (changes.displayName !== undefined) {
    // An empty name is no name, rather than a user called "".
    update.displayName = changes.displayName?.trim() ? changes.displayName.trim() : null;
  }
  if (changes.theme !== undefined) update.theme = changes.theme;
  if (changes.accent !== undefined) update.accent = changes.accent.toLowerCase();
  if (changes.language !== undefined) update.language = changes.language;
  if (changes.allocationStrategy !== undefined) update.allocationStrategy = changes.allocationStrategy;
  if (changes.avatar !== undefined) update.avatar = changes.avatar;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Nothing to change' } });
    return;
  }

  try {
    const [row] = await db().update(users).set(update).where(eq(users.id, req.user!.id)).returning();
    if (!row) {
      res.status(404).json({ error: { code: 'not_found', message: 'No such user' } });
      return;
    }
    res.json({ user: toPublicUser(row) });
  } catch (err) {
    next(err);
  }
});
