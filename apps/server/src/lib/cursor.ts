/**
 * A cursor over several providers at once.
 *
 * A merged view has no single position to remember: each account is at its own
 * page, and the only honest cursor is all of them together. Encoded as one
 * opaque string so a caller cannot be tempted to take it apart.
 *
 * Shared rather than copied. Search had this and the workspace views did not,
 * which is how the views ended up truncating at a hundred files instead of
 * paginating - and a second copy is how the two would have drifted.
 */

export type Cursor = Record<string, string>;

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Cursor;
  } catch {
    // A malformed cursor restarts the search rather than failing it.
    return null;
  }
}

export function encodeCursor(cursor: Cursor): string | undefined {
  const entries = Object.entries(cursor).filter(([, token]) => Boolean(token));
  if (entries.length === 0) return undefined;
  return Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8').toString('base64url');
}
