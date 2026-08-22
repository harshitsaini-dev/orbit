import { Resend } from 'resend';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface OutboxEntry {
  to: string;
  code: string;
  sentAt: string;
}

/**
 * Populated only by the console transport (i.e. when no Resend key is set), so
 * tests and local development can read back the code that was "sent". Never
 * touched on a real send.
 */
const outbox: OutboxEntry[] = [];

export function lastCodeFor(email: string): OutboxEntry | undefined {
  const address = email.trim().toLowerCase();
  return [...outbox].reverse().find((entry) => entry.to === address);
}

export function clearOutbox(): void {
  outbox.length = 0;
}

/**
 * Resend in hosted mode; a console transport otherwise, so local development
 * never needs an API key and the code path stays identical.
 */
async function send(mail: Mail): Promise<void> {
  if (!env.RESEND_API_KEY) {
    /*
     * The one place a code is deliberately written down, and the only
     * transport with no mailbox to send it to. Production cannot reach here:
     * hosted mode refuses to start without RESEND_API_KEY.
     */
    log.warn(`[email:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: env.RESEND_FROM,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });

  if (error) throw new Error(`Failed to send email: ${error.message}`);
}

export async function sendOtpEmail(to: string, code: string, ttlMinutes: number): Promise<void> {
  if (!env.RESEND_API_KEY) {
    outbox.push({ to: to.trim().toLowerCase(), code, sentAt: new Date().toISOString() });
    if (outbox.length > 500) outbox.shift();
  }

  await send({
    to,
    subject: `${code} is your Orbit sign-in code`,
    text: [
      `Your Orbit sign-in code is ${code}.`,
      `It expires in ${ttlMinutes} minutes and can be used once.`,
      `If you did not request this, you can ignore this email.`,
    ].join('\n\n'),
    html: `
      <div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1c2030">
        <h1 style="font-size:20px;margin:0 0 8px">Sign in to Orbit</h1>
        <p style="margin:0 0 24px;color:#5b6479">Use this code to finish signing in.</p>
        <div style="font-size:34px;font-weight:700;letter-spacing:10px;text-align:center;padding:20px;border-radius:22px;background:#eef1f6;color:#1c2030">${code}</div>
        <p style="margin:24px 0 0;color:#5b6479;font-size:14px">
          It expires in ${ttlMinutes} minutes and can be used once.
          If you did not request this, you can ignore this email.
        </p>
      </div>
    `,
  });
}
