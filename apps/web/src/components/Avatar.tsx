import type { PublicUser } from '@orbit/shared-types';

/** The letter shown when there is no picture. */
export function initialsOf(user: Pick<PublicUser, 'displayName' | 'email'>): string {
  const source = user.displayName?.trim() || user.email;
  const words = source.split(/[\s._-]+/).filter(Boolean);

  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0]?.slice(0, 2) ?? '?').toUpperCase();
}

export function Avatar({
  user,
  size = 36,
}: {
  user: Pick<PublicUser, 'displayName' | 'email' | 'avatar'>;
  size?: number;
}) {
  if (user.avatar) {
    return (
      <img
        src={user.avatar}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          display: 'block',
          flexShrink: 0,
          boxShadow: 'var(--shadow-clay)',
        }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        letterSpacing: '0.02em',
        boxShadow: 'var(--shadow-clay)',
      }}
    >
      {initialsOf(user)}
    </span>
  );
}
