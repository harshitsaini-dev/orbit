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

/**
 * The sign-in code, as an email.
 *
 * Written as tables with inline styles, which is not how anyone would write a
 * page but is how email survives: Gmail strips `<style>` blocks, Outlook
 * renders through Word, and neither supports flexbox, grid or SVG. So the mark
 * is drawn with a bordered element rather than an image - there is no public
 * URL to host one at before the first deploy, and an image that fails to load
 * turns a sign-in mail into a broken box.
 *
 * The one thing this mail must do is show six digits clearly, so they are the
 * largest thing in it and spaced far enough apart to read aloud.
 */
export async function sendOtpEmail(to: string, code: string, ttlMinutes: number): Promise<void> {
  if (!env.RESEND_API_KEY) {
    outbox.push({ to: to.trim().toLowerCase(), code, sentAt: new Date().toISOString() });
    if (outbox.length > 500) outbox.shift();
  }

  const expiry = `${ttlMinutes} ${ttlMinutes === 1 ? 'minute' : 'minutes'}`;

  await send({
    to,
    subject: `${code} is your Orbit sign-in code`,
    text: [
      `Your Orbit sign-in code is ${code}.`,
      `It expires in ${expiry} and can be used once.`,
      `If you did not request this, you can ignore this email - nobody can sign in without the code.`,
      `Orbit - one workspace for every cloud drive you own.`,
    ].join('\n\n'),
    html: `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#eef1f6">
    <!-- What a mail client shows beside the subject in the inbox list. Hidden
         in the message itself, which is why it is repeated below. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">
      ${code} - expires in ${expiry}, and can only be used once.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:20px;overflow:hidden">
            <tr>
              <td style="padding:28px 32px 0">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding-right:9px">
                      <div style="width:22px;height:22px;border-radius:50%;border:2px solid #6c8cff;background:#dbe3ff"></div>
                    </td>
                    <td style="font:700 19px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:-0.03em;color:#1c2030">
                      Orbit
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:22px 32px 0;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1c2030">
                <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;letter-spacing:-0.02em">Sign in to Orbit</h1>
                <p style="margin:0;font-size:14.5px;line-height:1.6;color:#5b6479">
                  Enter this code to finish signing in.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 32px 0">
                <div style="font:700 34px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:10px;text-align:center;padding:20px 12px;border-radius:16px;background:#eef1f6;color:#1c2030">${code}</div>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 32px 28px;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:13.5px;line-height:1.65;color:#5b6479">
                It expires in ${expiry} and can be used once.
                <br />
                If you did not request this, you can ignore this email - nobody can sign in without the code.
              </td>
            </tr>
          </table>

          <p style="max-width:460px;margin:16px auto 0;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;line-height:1.6;color:#8a92a6;text-align:center">
            Orbit - one workspace for every cloud drive you own.
            <br />
            This message was sent because somebody asked to sign in with this address.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  });
}
