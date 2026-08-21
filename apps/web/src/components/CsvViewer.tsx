import { useMemo, useState } from 'react';

/**
 * A spreadsheet export, shown as a table rather than as text.
 *
 * A CSV read as source is a wall of commas; the point of the file is its
 * columns. Parsing is done here rather than by splitting on commas, because a
 * field may be quoted and contain a comma or a newline of its own - the case
 * that makes the naive version silently misalign every row after it.
 */

/** Past this a table stops being something anyone reads and starts being a load. */
const MAX_ROWS = 2000;

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      // Consume CRLF as one break rather than producing an empty row between.
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function CsvViewer({ text, name }: { text: string; name: string }) {
  const [asText, setAsText] = useState(false);

  const rows = useMemo(
    () => parseDelimited(text, name.toLowerCase().endsWith('.tsv') ? '\t' : ','),
    [text, name],
  );

  if (asText) {
    return (
      <div className="code-view">
        <div className="code-view__bar">
          <span className="code-view__lang">Raw</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="clay-button" onClick={() => setAsText(false)}>
            Show as table
          </button>
        </div>
        <div className="code-view__scroll">
          <pre style={{ margin: 0, padding: '0.75rem 1rem' }}>{text}</pre>
        </div>
      </div>
    );
  }

  const [header, ...body] = rows;
  const shown = body.slice(0, MAX_ROWS);
  const columns = Math.max(...rows.map((r) => r.length), 0);

  return (
    <div className="code-view">
      <div className="code-view__bar">
        <span className="code-view__lang">{name.toLowerCase().endsWith('.tsv') ? 'TSV' : 'CSV'}</span>
        <span className="code-view__meta">
          {body.length.toLocaleString()} {body.length === 1 ? 'row' : 'rows'} · {columns}{' '}
          {columns === 1 ? 'column' : 'columns'}
          {body.length > MAX_ROWS && ` · showing first ${MAX_ROWS.toLocaleString()}`}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="clay-button" onClick={() => setAsText(true)}>
          Show raw
        </button>
      </div>

      <div className="code-view__scroll">
        <table className="csv-table">
          {header && (
            <thead>
              <tr>
                <th scope="col" className="csv-table__gutter" />
                {header.map((cell, index) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <th key={index} scope="col">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}

          <tbody>
            {shown.map((cells, rowIndex) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={rowIndex}>
                {/* Row numbers match the file, header included, so a number here
                    is the number an editor would show for the same line. */}
                <td className="csv-table__gutter">{rowIndex + 2}</td>
                {Array.from({ length: header?.length ?? columns }, (_, column) => (
                  <td key={column}>{cells[column] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
