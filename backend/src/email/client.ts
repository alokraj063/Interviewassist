import { Resend } from "resend";
import { env } from "../env.js";

let _client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!_client) _client = new Resend(env.RESEND_API_KEY);
  return _client;
}

export interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Send a transactional email. If RESEND_API_KEY is unset (dev default),
 * log the full email to stdout instead — so dev flows don't silently fail.
 */
export async function sendEmail(args: SendArgs, log?: { info: (...xs: unknown[]) => void }): Promise<void> {
  const client = getClient();
  if (!client) {
    const line = `---- DEV EMAIL ----\nto: ${args.to}\nsubject: ${args.subject}\n\n${args.text}\n-------------------`;
    (log ?? console).info(line);
    return;
  }
  const res = await client.emails.send({
    from: env.RESEND_FROM,
    to: args.to,
    subject: args.subject,
    html: args.html,
    text: args.text,
  });
  if (res.error) throw new Error(`resend_error: ${res.error.name}: ${res.error.message}`);
}
