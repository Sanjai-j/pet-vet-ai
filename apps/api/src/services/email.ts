/**
 * Outbound email.
 *
 * Two transports are supported, chosen at runtime:
 *
 *  - `brevo` / `resend`: an HTTPS API on port 443. This is the only transport
 *    that works on Render's free web services, which block outbound traffic to
 *    SMTP ports 25, 465 and 587 (render.com/changelog, Sep 2025). A Gmail
 *    account with an app password speaks SMTP, so it cannot deliver from there.
 *  - `smtp`: plain nodemailer for local development and hosts that allow SMTP.
 *
 * `emailConfigured()` reports whether anything is set up, so callers can tell
 * the owner "email is not configured on this server" instead of claiming a
 * message was sent.
 */
import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface SendResult {
  delivered: boolean;
  reason?: string;
}

export type EmailTransport = 'brevo' | 'resend' | 'smtp' | null;

const PROVIDER_URL: Record<'brevo' | 'resend', string> = {
  brevo: 'https://api.brevo.com/v3/smtp/email',
  resend: 'https://api.resend.com/emails',
};

/** "Pet Vet AI <no-reply@petvet.example>" → { name, email } */
export function parseSender(raw: string): { name: string; email: string } {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1] || 'Pet Vet AI', email: match[2].trim() };
  return { name: 'Pet Vet AI', email: raw.trim() };
}

export function emailTransport(): EmailTransport {
  const provider = config.email.provider;
  if ((provider === 'brevo' || provider === 'resend') && config.email.apiKey) return provider;
  if (config.smtp.host) return 'smtp';
  return null;
}

export function emailConfigured(): boolean {
  return emailTransport() !== null;
}

let smtpTransport: nodemailer.Transporter | null = null;

function smtp(): nodemailer.Transporter {
  if (smtpTransport) return smtpTransport;
  smtpTransport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return smtpTransport;
}

async function sendViaApi(
  provider: 'brevo' | 'resend',
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<SendResult> {
  const sender = parseSender(config.email.from);
  const isBrevo = provider === 'brevo';
  const body = isBrevo
    ? {
        sender: { name: sender.name, email: sender.email },
        to: [{ email: to }],
        subject,
        textContent: text,
        ...(html ? { htmlContent: html } : {}),
      }
    : {
        from: `${sender.name} <${sender.email}>`,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
      };

  try {
    const response = await fetch(PROVIDER_URL[provider], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(isBrevo ? { 'api-key': config.email.apiKey } : { Authorization: `Bearer ${config.email.apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Providers put the useful part (unverified sender, quota, bad key) in
      // the JSON body; keep a slice of it in the log, never the key.
      const detail = await response.text().catch(() => '');
      console.warn(`[email] ${provider} returned ${response.status}: ${detail.slice(0, 300)}`);
      return { delivered: false, reason: `email_api_${response.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.warn(`[email] ${provider} request failed`, (err as Error).message);
    return { delivered: false, reason: 'email_api_unreachable' };
  }
}

/**
 * Send one message. `html` is optional; every email also carries plain text,
 * because a reset link has to be readable in the simplest client.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<SendResult> {
  const transport = emailTransport();
  if (!transport) return { delivered: false, reason: 'email_not_configured' };

  if (transport === 'smtp') {
    try {
      await smtp().sendMail({ from: config.email.from, to, subject, text, ...(html ? { html } : {}) });
      return { delivered: true };
    } catch (err) {
      console.warn('[email] smtp delivery failed', (err as Error).message);
      return { delivered: false, reason: 'smtp_delivery_failed' };
    }
  }

  return sendViaApi(transport, to, subject, text, html);
}
