import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark.js';

/**
 * The privacy policy and the terms, as pages rather than as a PDF nobody opens.
 *
 * They exist for two reasons at once. Google will not let an OAuth app leave
 * Testing without a privacy policy at a reachable address on the same domain,
 * and an app stuck in Testing has every refresh token expired after seven days
 * - so the live connection stops working weekly. And separately: an app that
 * asks for a person's whole Drive owes them a plain account of what it does
 * with it.
 *
 * Written to be true of this codebase rather than to be safe. Every claim below
 * corresponds to something in the source, and if one of them stops being true
 * the text has to change with it - which is the only way a policy is worth
 * anything.
 */

const CONTACT = 'harshitsaini.dev@gmail.com';
const REPO = 'https://github.com/harshitsaini-dev/orbit';

const UPDATED = '23 August 2026';

function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  // A policy opened from a consent screen arrives at whatever scroll position
  // the previous page had, which reads as a document starting halfway down.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="legal">
      <header className="legal__head">
        <Link to="/" className="legal__brand">
          <BrandMark size={26} />
          <span>Orbit</span>
        </Link>
        <Link to="/" className="clay-button" style={{ padding: '0.4rem 0.9rem', fontSize: 13 }}>
          Back
        </Link>
      </header>

      <main className="clay legal__sheet">
        <h1>{title}</h1>
        <p className="legal__updated">Last updated {updated}</p>
        {children}
      </main>
    </div>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy" updated={UPDATED}>
      <p className="legal__lead">
        Orbit connects the cloud drives you already have and shows them in one place. It is not
        another drive. The short version: your files stay at your provider, Orbit never keeps a
        copy of them, and the access it holds is yours to revoke at any time.
      </p>

      <h2>What Orbit stores</h2>
      <ul>
        <li>
          <strong>Your email address.</strong> It is how you sign in — a six-digit code is sent to
          it and nothing else identifies you.
        </li>
        <li>
          <strong>Access tokens for the drives you connect.</strong> Encrypted at rest with
          AES-256-GCM under a key held in the server’s environment, never in the database and
          never in the source.
        </li>
        <li>
          <strong>A metadata index of your files</strong> — names, sizes, types, folder paths,
          modification dates and checksums. This is what makes search, the duplicate finder and
          instant browsing possible without a request to the provider for every keystroke.
        </li>
        <li>
          <strong>Links you create,</strong> with their settings and how many times they have
          been opened.
        </li>
        <li>
          <strong>An audit trail</strong> of actions on a drive shared with other people, so
          “who deleted this” has an answer. It records who, what, when, and the IP the request
          came from.
        </li>
      </ul>

      <h2>What Orbit never stores</h2>
      <p>
        <strong>The contents of your files.</strong> Not temporarily, not “just in case”, not to
        make a preview faster. When you open or download something, Orbit fetches it from your
        provider and streams it through to you as it arrives; nothing is written to Orbit’s own
        disk on the way past. This is a property of the code, not a promise about intent — there
        is no storage attached to the server for it to be written to.
      </p>
      <p>
        The provider’s own URL for a file never reaches your browser either. That is deliberate:
        those URLs often work for anyone who has them.
      </p>
      <p>
        Sign-in codes, session tokens and provider tokens are never written to logs. API tokens
        are stored only as a SHA-256 hash — a lost one cannot be recovered, only replaced.
      </p>

      <h2>What a public link records</h2>
      <p>
        A link you share counts how many times it is opened and downloaded, the day it happened,
        and a coarse device class read from the browser’s user agent — phone, tablet, desktop or
        bot. No IP address, no location, no name, nothing that identifies a visitor. Those
        records are deleted automatically after 90 days.
      </p>

      <h2>Who else is involved</h2>
      <p>
        Orbit runs on services that see the data described above in the course of hosting it:
        Render (the API), Turso (the database, in Mumbai), Vercel (the site), Resend (the sign-in
        emails), and Cloudflare (DNS). Your cloud providers — Google, Microsoft, Dropbox and the
        rest — see the requests Orbit makes on your behalf, as they would from any client you
        connect.
      </p>
      <p>Nothing is sold, and there is no advertising or tracking of any kind in Orbit.</p>

      <h2>Google Drive specifically</h2>
      <p>
        Orbit’s use of information received from Google APIs follows the{' '}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer noopener"
        >
          Google API Services User Data Policy
        </a>
        , including its Limited Use requirements. Drive data is used to show you your own files
        inside Orbit and for nothing else — it is not used for advertising, not sold, not shared,
        and not used to train any model.
      </p>

      <h2>Removing your data</h2>
      <ul>
        <li>
          <strong>Disconnect a drive</strong> under Quota. Its tokens and its metadata index are
          deleted, and Orbit’s access to that account ends immediately.
        </li>
        <li>
          <strong>Revoke Orbit’s access from the provider’s side</strong> at any time — for
          Google, at{' '}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer noopener"
          >
            myaccount.google.com/permissions
          </a>
          . Nothing on Orbit’s side can override that.
        </li>
        <li>
          <strong>Delete everything</strong> by writing to <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          The account, its drives, the index and the links are removed.
        </li>
      </ul>

      <h2>Honestly stated limits</h2>
      <p>
        Orbit is a personal project run by one person on free hosting tiers. It is not audited,
        it carries no uptime guarantee, and it should not hold the only copy of anything — though
        by design it never holds any copy at all. The source is public at{' '}
        <a href={REPO} target="_blank" rel="noreferrer noopener">
          github.com/harshitsaini-dev/orbit
        </a>
        , so every claim on this page can be checked rather than taken on trust.
      </p>

      <h2>Changes, and how to ask</h2>
      <p>
        If this policy changes, the date at the top changes with it. Questions, corrections and
        deletion requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <p className="legal__foot">
        <Link to="/terms">Terms of use</Link>
      </p>
    </LegalPage>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms of use" updated={UPDATED}>
      <p className="legal__lead">
        Orbit is offered free, as-is, by one person. These terms are short because the
        relationship is simple: you connect your own storage, Orbit shows it to you, and either
        side may walk away at any moment.
      </p>

      <h2>What you may do</h2>
      <p>
        Connect drives you own or have been given access to, and use Orbit to browse, search,
        upload, download, move and share what is in them. The source is public under its licence;
        running your own copy is encouraged.
      </p>

      <h2>What you may not do</h2>
      <ul>
        <li>Connect an account you do not have permission to use.</li>
        <li>
          Use Orbit to distribute material you have no right to distribute, or anything unlawful.
          Public links are the part of Orbit that reaches other people, and they are your
          responsibility.
        </li>
        <li>
          Attack the service — automated traffic beyond ordinary use, attempts to reach another
          person’s data, or anything meant to degrade it for others.
        </li>
      </ul>

      <h2>What is not promised</h2>
      <p>
        No uptime, no durability, no support. Orbit runs on free tiers and may be unavailable,
        may lose the metadata index, and may stop entirely. What it cannot do is lose your files:
        they are never in Orbit’s custody in the first place — they stay with your provider,
        under whatever guarantees that provider gives you.
      </p>
      <p>
        Orbit is provided without warranty of any kind, and its author is not liable for loss
        arising from its use, to the extent the law allows.
      </p>

      <h2>Ending it</h2>
      <p>
        Disconnect your drives and stop using Orbit, and nothing of yours remains that mattered —
        or write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a> to have the account removed
        outright. Access may be withdrawn from anyone who breaks the section above.
      </p>

      <p className="legal__foot">
        <Link to="/privacy">Privacy</Link>
      </p>
    </LegalPage>
  );
}
