// Sign-in emails go through Resend (resend.com). The API key lives only in the
// RESEND_API_KEY environment variable on Render. Without a key, outside production,
// the link is printed to the server log instead so the hub can be tried locally.
import { config } from '../config.js';

export async function sendSignInEmail(to: string, name: string, link: string): Promise<'sent' | 'logged'> {
  const first = name.split(' ')[0];
  const text = `Hi ${first},\n\nTap this link to sign in to the Aalbor Hub. It works once, for 20 minutes.\n\n${link}\n\nIf you didn't ask for this, ignore this email.\n`;
  const htmlBody = `<p>Hi ${first},</p><p>Tap the button to sign in to the Aalbor Hub. It works once, for 20 minutes.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#14171C;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Sign in to the Aalbor Hub</a></p>
<p style="color:#555B66;font-size:13px">If you didn't ask for this, ignore this email.</p>`;

  if (!config.resendApiKey) {
    if (config.production) throw new Error('Sign-in email is not set up: RESEND_API_KEY is missing on Render.');
    console.log(`[sign-in link for ${to}] ${link}`);
    return 'logged';
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject: 'Your Aalbor Hub sign-in link', text, html: htmlBody }),
  });
  if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${await res.text()}`);
  return 'sent';
}

/** One email per batch of suggestions (none for a batch of info-only rows). */
export async function sendSuggestionsEmail(to: string, n: { urgent: number; normal: number; info: number }, source: string, link: string): Promise<'sent' | 'logged'> {
  const total = n.urgent + n.normal + n.info;
  const parts = [n.urgent ? `${n.urgent} urgent` : '', n.normal ? `${n.normal} normal` : '', n.info ? `${n.info} for info` : ''].filter(Boolean).join(', ');
  const subject = `Hub: ${total} new ${total === 1 ? 'suggestion' : 'suggestions'} from ${source}${n.urgent ? ` (${n.urgent} urgent)` : ''}`;
  const text = `${source} has compared the hub with Buildertrend and has ${total} ${total === 1 ? 'suggestion' : 'suggestions'}: ${parts}.\n\nNothing changes until an Editor accepts. Review them here:\n${link}\n`;
  const htmlBody = `<p>${source} has compared the hub with Buildertrend and has ${total} ${total === 1 ? 'suggestion' : 'suggestions'}: <b>${parts}</b>.</p>
<p>Nothing changes until an Editor accepts.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#14171C;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Review suggestions</a></p>`;
  if (!config.resendApiKey) {
    if (config.production) throw new Error('Suggestions email is not set up: RESEND_API_KEY is missing on Render.');
    console.log(`[suggestions email to ${to}] ${subject} ${link}`);
    return 'logged';
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text, html: htmlBody }),
  });
  if (!res.ok) throw new Error(`Resend refused the email (${res.status}): ${await res.text()}`);
  return 'sent';
}
