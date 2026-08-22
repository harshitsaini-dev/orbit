import type { Response } from 'express';

/**
 * Maps the provider errors that mean something specific onto a status the UI
 * can act on, and says whether it handled one.
 *
 * Shared rather than copied. It began as a local function in the files route
 * and the trash route needs exactly the same two cases; a second copy is how
 * two routes end up disagreeing about what a dead grant looks like.
 */
export function sendProviderError(err: unknown, res: Response): boolean {
  if (err instanceof Error && err.message === 'needs_reauth') {
    res.status(409).json({
      error: { code: 'needs_reauth', message: 'This account needs to be reconnected' },
    });
    return true;
  }

  if (err instanceof Error && err.name === 'NotImplementedError') {
    res.status(501).json({
      error: { code: 'unsupported', message: 'This provider does not support that action' },
    });
    return true;
  }

  return false;
}
