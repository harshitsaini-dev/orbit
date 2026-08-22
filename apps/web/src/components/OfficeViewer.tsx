import { useEffect, useState } from 'react';
import {
  readDocument,
  readPresentation,
  readSpreadsheet,
  type DocBlock,
  type Sheet,
  type Slide,
} from '../lib/office.js';
import {
  readEpub,
  readOpenPresentation,
  readOpenSpreadsheet,
  readOpenText,
} from '../lib/opendocument.js';

/**
 * Spreadsheets, documents and presentations.
 *
 * These read the file's values and text, not its appearance: no fonts, no
 * colours, no charts, no images. That is a real limit and the viewer says so in
 * a line at the bottom rather than presenting a partial rendering as the whole
 * document — someone deciding whether a chart looks right needs to know they
 * are not seeing it.
 */

export type OfficeKind = 'spreadsheet' | 'document' | 'presentation';

export function OfficeViewer({
  src,
  name,
  kind,
}: {
  src: string;
  name: string;
  kind: OfficeKind;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'failed'; message: string }
    | { status: 'ready'; sheets: Sheet[] }
    | { status: 'ready'; blocks: DocBlock[] }
    | { status: 'ready'; slides: Slide[] }
  >({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });

    void (async () => {
      try {
        const response = await fetch(src, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (controller.signal.aborted) return;

        // Microsoft's and LibreOffice's formats are both ZIPs and both end up
        // in the same shapes, so which reader runs is decided by the name.
        const lower = name.toLowerCase();
        const isOpenDocument = /\.(ods|odt|odp)$/.test(lower);
        const isEpub = lower.endsWith('.epub');

        if (kind === 'spreadsheet') {
          setState({
            status: 'ready',
            sheets: isOpenDocument ? await readOpenSpreadsheet(bytes) : await readSpreadsheet(bytes),
          });
        } else if (kind === 'document') {
          setState({
            status: 'ready',
            blocks: isEpub
              ? await readEpub(bytes)
              : isOpenDocument
                ? await readOpenText(bytes)
                : await readDocument(bytes),
          });
        } else {
          setState({
            status: 'ready',
            slides: isOpenDocument ? await readOpenPresentation(bytes) : await readPresentation(bytes),
          });
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setState({
          status: 'failed',
          // The reader's own message names what was missing, which is more use
          // than "could not open" when a file is the wrong format entirely.
          message: (err as Error).message || 'This file could not be read.',
        });
      }
    })();

    return () => controller.abort();
  }, [src, kind, name]);

  if (state.status === 'loading') {
    return (
      <div className="office-view office-view--message">
        <p>Reading {name}…</p>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="office-view office-view--message">
        <p style={{ color: 'var(--danger)' }}>{state.message}</p>
      </div>
    );
  }

  if ('sheets' in state) return <SpreadsheetView sheets={state.sheets} />;
  if ('blocks' in state) return <DocumentView blocks={state.blocks} />;
  return <PresentationView slides={state.slides} />;
}

function SpreadsheetView({ sheets }: { sheets: Sheet[] }) {
  const [index, setIndex] = useState(0);
  const sheet = sheets[Math.min(index, sheets.length - 1)]!;
  const columns = Math.max(...sheet.rows.map((row) => row.length), 1);

  return (
    <div className="office-view">
      {sheets.length > 1 && (
        <div className="office-view__tabs" role="tablist" aria-label="Sheets">
          {sheets.map((candidate, position) => (
            <button
              key={candidate.name}
              type="button"
              role="tab"
              aria-selected={position === index}
              onClick={() => setIndex(position)}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}

      <div className="office-view__scroll">
        <table className="csv-table">
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
               
              <tr key={rowIndex}>
                <td className="csv-table__gutter">{rowIndex + 1}</td>
                {Array.from({ length: columns }, (_, column) => (
                  <td key={column}>{row[column] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Footnote
        extra={
          sheet.truncatedRows > 0
            ? `${sheet.truncatedRows.toLocaleString()} further rows are not shown.`
            : undefined
        }
      />
    </div>
  );
}

function DocumentView({ blocks }: { blocks: DocBlock[] }) {
  return (
    <div className="office-view">
      <div className="office-view__scroll">
        <article className="office-doc">
          {blocks.map((block, index) => {
             
            const key = index;

            if (block.kind === 'table') {
              return (
                <table key={key} className="csv-table">
                  <tbody>
                    {block.rows?.map((row, rowIndex) => (
                       
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                           
                          <td key={cellIndex}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            }

            if (block.kind === 'heading') {
              const Tag = `h${block.level ?? 2}` as 'h1';
              return <Tag key={key}>{block.text}</Tag>;
            }

            if (block.kind === 'list') {
              return (
                <p key={key} className="office-doc__bullet">
                  {block.text}
                </p>
              );
            }

            // An empty paragraph is spacing the writer put there.
            return block.text ? <p key={key}>{block.text}</p> : <p key={key}>&nbsp;</p>;
          })}
        </article>
      </div>

      <Footnote />
    </div>
  );
}

function PresentationView({ slides }: { slides: Slide[] }) {
  return (
    <div className="office-view">
      <div className="office-view__scroll">
        <div className="office-slides">
          {slides.map((slide) => (
            <section key={slide.number} className="clay-sunken office-slide">
              <span className="office-slide__number">Slide {slide.number}</span>

              {slide.blocks.length === 0 ? (
                <p className="office-slide__empty">No text on this slide.</p>
              ) : (
                slide.blocks.map((block, index) => (
                   
                  <p key={index} className={index === 0 ? 'office-slide__title' : undefined}>
                    {block}
                  </p>
                ))
              )}

              {slide.notes && (
                <p className="office-slide__notes">
                  <strong>Notes:</strong> {slide.notes}
                </p>
              )}
            </section>
          ))}
        </div>
      </div>

      <Footnote />
    </div>
  );
}

/**
 * Says what is missing.
 *
 * Without it someone could look at a spreadsheet whose charts are the point and
 * conclude the file is broken, when Orbit simply is not drawing them.
 */
function Footnote({ extra }: { extra?: string }) {
  return (
    <p className="office-view__note">
      Text and values only — formatting, charts and images are not shown. Download to open the
      original.{extra ? ` ${extra}` : ''}
    </p>
  );
}
