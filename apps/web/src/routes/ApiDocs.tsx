import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  API_ERROR_CODES,
  API_ERROR_SHAPE,
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  TOKEN_PREFIX,
  V1_ENDPOINTS,
  type ApiEndpoint,
} from '@orbit/shared-types';

/**
 * The API documentation, rendered from the same description of `/v1` that a
 * server test checks against the router.
 *
 * That is the whole design of this page. Hand-written API documentation is
 * wrong within a release - not through carelessness, but because the code
 * changes and prose has no way to notice. Here an endpoint added without an
 * entry fails a test, and an entry describing something that no longer exists
 * fails too, so what is on this page is what the server actually answers.
 */

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8787';

/** The sections in the order they are read, for the contents rail. */
const SECTIONS = [
  { id: 'start', label: 'Getting started' },
  { id: 'auth', label: 'Authentication' },
  { id: 'scopes', label: 'Scopes' },
  { id: 'limits', label: 'Rate limits' },
  { id: 'errors', label: 'Errors' },
  { id: 'endpoints', label: 'Endpoints' },
];

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="doc-code">
      <div className="doc-code__bar">
        <span>{label ?? 'example'}</span>
        <button
          type="button"
          className="clay-button"
          onClick={() => {
            navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** The curl a reader can paste, built from the endpoint's own parameters. */
function curlFor(endpoint: ApiEndpoint): string {
  const query = endpoint.params
    .filter((param) => param.in === 'query')
    .map((param) => `${param.name}=${param.example ?? `<${param.name}>`}`)
    .join('&');

  let path = endpoint.path;
  for (const param of endpoint.params) {
    if (param.in === 'path') path = path.replace(`:${param.name}`, `<${param.name}>`);
  }

  const url = `${API_BASE}${path}${query ? `?${query}` : ''}`;
  const body = endpoint.params.filter((param) => param.in === 'body');

  const lines = [`curl -H "Authorization: Bearer ${TOKEN_PREFIX}…" \\`];
  if (endpoint.method !== 'GET') lines.push(`  -X ${endpoint.method} \\`);

  if (body.length > 0) {
    const json = body
      .map((param) => {
        const value = param.example ?? `<${param.name}>`;
        const quoted = value.startsWith('[') || value.startsWith('{') || /^\d+$/.test(value);
        return `"${param.name}": ${quoted ? value : `"${value}"`}`;
      })
      .join(', ');

    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '{ ${json} }' \\`);
  }

  lines.push(`  "${url}"`);
  return lines.join('\n');
}

function Endpoint({ endpoint }: { endpoint: ApiEndpoint }) {
  const params = endpoint.params;

  return (
    <article className="clay doc-endpoint">
      <header>
        <span className={`doc-method doc-method--${endpoint.method.toLowerCase()}`}>
          {endpoint.method}
        </span>
        <code>{endpoint.path}</code>
        {endpoint.scope ? (
          <span className="doc-scope">{endpoint.scope}</span>
        ) : (
          <span className="doc-scope doc-scope--any">any scope</span>
        )}
      </header>

      <p className="doc-summary">{endpoint.summary}</p>
      {endpoint.detail && <p className="doc-detail">{endpoint.detail}</p>}

      {params.length > 0 && (
        <div className="doc-params">
          <table>
            <thead>
              <tr>
                <th>Parameter</th>
                <th>In</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {params.map((param) => (
                <tr key={`${param.in}:${param.name}`}>
                  <td>
                    <code>{param.name}</code>
                    {param.required && <span className="doc-required">required</span>}
                  </td>
                  <td>{param.in}</td>
                  <td>{param.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CodeBlock code={curlFor(endpoint)} label="request" />
      <CodeBlock code={endpoint.response} label="response" />
    </article>
  );
}

export function ApiDocs() {
  return (
    <div className="doc-page">
      <nav className="clay doc-contents" aria-label="Contents">
        <strong>On this page</strong>
        <ul>
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{section.label}</a>
            </li>
          ))}
        </ul>

        <strong style={{ marginTop: '0.8rem' }}>Endpoints</strong>
        <ul>
          {V1_ENDPOINTS.map((endpoint) => (
            <li key={`${endpoint.method} ${endpoint.path}`}>
              <a href={`#${endpoint.method}-${endpoint.path.replace(/[^\w]+/g, '-')}`}>
                <span className="doc-contents__method">{endpoint.method}</span>
                {endpoint.path.replace('/v1', '')}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="doc-body">
        <section className="clay">
          <h1>Orbit API</h1>
          <p>
            One API over every drive you have connected. The same call lists a Google Drive folder,
            a Dropbox folder and an S3 bucket, and the bytes come back through Orbit — so a program
            you write never holds a Google or Dropbox credential, only an Orbit token you can
            revoke.
          </p>
          <p className="doc-detail">
            Base URL <code>{API_BASE}</code>. Everything below lives under <code>/v1</code>, and
            stays there: a breaking change would ship as <code>/v2</code> rather than as a change
            underneath a working client.
          </p>
        </section>

        <section className="clay" id="start">
          <h2>Getting started</h2>
          <ol className="doc-steps">
            <li>
              Create a token in the <Link to="/developer">Developer tab</Link>, granting the least
              that works. It is shown once.
            </li>
            <li>Send it as a bearer credential on every request.</li>
            <li>
              Call <code>/v1/accounts</code> to find the <code>accountId</code> of the drive you
              want, then everything else takes that id.
            </li>
          </ol>

          <CodeBlock
            label="first call"
            code={`curl -H "Authorization: Bearer ${TOKEN_PREFIX}…" \\
  "${API_BASE}/v1/accounts"`}
          />
        </section>

        <section className="clay" id="auth">
          <h2>Authentication</h2>
          <p>
            A personal access token, sent as <code>Authorization: Bearer</code>. Nothing else is
            accepted — there is no API key in a query string, because a URL ends up in logs,
            history and referrers.
          </p>
          <p className="doc-detail">
            A signed-in browser session also works, which is what makes the examples on this page
            runnable while you are reading it. What does not work is Orbit&apos;s local development
            mode: it gives every request an implicit user, and a client written against that would
            work on your laptop and fail against a real deployment.
          </p>
          <CodeBlock label="header" code={`Authorization: Bearer ${TOKEN_PREFIX}<43 characters>`} />
        </section>

        <section className="clay" id="scopes">
          <h2>Scopes</h2>
          <p>
            A token carries the scopes it was granted. A request outside them answers{' '}
            <code>403 insufficient_scope</code>, not <code>401</code> — the credential is real, and
            sending it again will not change the answer.
          </p>

          <div className="doc-params">
            <table>
              <thead>
                <tr>
                  <th>Scope</th>
                  <th>Grants</th>
                </tr>
              </thead>
              <tbody>
                {API_SCOPES.map((scope) => (
                  <tr key={scope}>
                    <td>
                      <code>{scope}</code>
                    </td>
                    <td>{SCOPE_DESCRIPTIONS[scope]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="doc-detail">
            There is deliberately no scope that hands over a provider&apos;s own credentials. Orbit
            proxies every byte, so a token reaches your files without ever exposing the Google or
            Dropbox token behind them — which is what makes opening this API up safe at all.
          </p>
        </section>

        <section className="clay" id="limits">
          <h2>Rate limits</h2>
          <p>
            Counted per token rather than per address. An IP limit punishes everyone behind one
            connection and does nothing against a client spread across several.
          </p>
          <p className="doc-detail">
            Every response carries <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code>{' '}
            and <code>RateLimit-Reset</code>, and a <code>429</code> carries{' '}
            <code>Retry-After</code>. A client should never have to guess.
          </p>
        </section>

        <section className="clay" id="errors">
          <h2>Errors</h2>
          <p>One shape, always. The status carries the meaning; the body explains it.</p>
          <CodeBlock label="error" code={API_ERROR_SHAPE} />

          <p className="doc-detail">
            <code>requestId</code> is on every response, in the body and in the{' '}
            <code>X-Request-Id</code> header. Quoting it is what turns &quot;something went
            wrong&quot; into one line of server log.
          </p>

          <div className="doc-params">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Code</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {API_ERROR_CODES.map((entry) => (
                  <tr key={entry.code}>
                    <td>{entry.status}</td>
                    <td>
                      <code>{entry.code}</code>
                    </td>
                    <td>{entry.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="endpoints" className="doc-endpoints">
          <h2>Endpoints</h2>

          {V1_ENDPOINTS.map((endpoint) => (
            <div
              key={`${endpoint.method} ${endpoint.path}`}
              id={`${endpoint.method}-${endpoint.path.replace(/[^\w]+/g, '-')}`}
            >
              <Endpoint endpoint={endpoint} />
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
