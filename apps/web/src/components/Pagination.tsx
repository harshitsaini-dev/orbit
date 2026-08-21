/**
 * Page navigation for a list too long to render at once.
 *
 * The page numbers are windowed rather than listed in full: a folder of forty
 * thousand files is forty pages, and a row of forty buttons is not navigation.
 */
export function pageNumbersFor(current: number, total: number, window = 2): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = new Set<number>([1, total]);
  for (let page = current - window; page <= current + window; page += 1) {
    if (page > 1 && page < total) pages.add(page);
  }

  const ordered = [...pages].sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];

  for (const [index, page] of ordered.entries()) {
    const previous = ordered[index - 1];
    // A gap of exactly one is worse than the number it hides.
    if (previous !== undefined && page - previous > 1) {
      out.push(page - previous === 2 ? page - 1 : 'gap');
    }
    out.push(page);
  }

  return out;
}

export function Pagination({
  page,
  pageCount,
  totalItems,
  pageSize,
  onChange,
}: {
  page: number;
  pageCount: number;
  totalItems: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);

  return (
    <nav
      aria-label="Pages"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        padding: '0.75rem 0.5rem 0.25rem',
      }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }} aria-live="polite">
        {first.toLocaleString()}–{last.toLocaleString()} of {totalItems.toLocaleString()}
      </span>

      <div className="scroll-x" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <button
          type="button"
          className="clay-button"
          style={PAGE_BUTTON}
          disabled={page === 1}
          onClick={() => onChange(page - 1)}
        >
          Previous
        </button>

        {pageNumbersFor(page, pageCount).map((entry, index) =>
          entry === 'gap' ? (
            <span
              key={`gap-${index}`}
              aria-hidden="true"
              style={{ color: 'var(--text-muted)', padding: '0 2px' }}
            >
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              className="clay-button"
              aria-label={`Page ${entry}`}
              aria-current={entry === page ? 'page' : undefined}
              onClick={() => onChange(entry)}
              style={{
                ...PAGE_BUTTON,
                minWidth: 36,
                color: entry === page ? 'var(--accent)' : undefined,
                boxShadow: entry === page ? 'var(--shadow-clay-inset)' : 'var(--shadow-clay)',
              }}
            >
              {entry}
            </button>
          ),
        )}

        <button
          type="button"
          className="clay-button"
          style={PAGE_BUTTON}
          disabled={page === pageCount}
          onClick={() => onChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

const PAGE_BUTTON = {
  padding: '0.35rem 0.8rem',
  fontSize: 13,
  whiteSpace: 'nowrap',
} as const;
