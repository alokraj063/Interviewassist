import { env } from "../env.js";
import { sendEmail } from "./client.js";

type Log = { info: (...xs: unknown[]) => void };

const ESC_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;background:#f5f5f7;margin:0;padding:24px;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:32px;">
    <tr><td style="color:#111;font-size:15px;line-height:1.55">
      ${body}
      <hr style="border:none;border-top:1px solid #eaeaea;margin:28px 0">
      <p style="color:#888;font-size:12px;margin:0">RecruitAssist · If you didn't expect this email, you can safely ignore it.</p>
    </td></tr>
  </table>
</body></html>`;
}

function btn(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">${esc(label)}</a></p>`;
}

function codeBlock(code: string): string {
  return `<p style="margin:24px 0;text-align:center">
    <span style="display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:28px;font-weight:600;letter-spacing:8px;background:#f5f5f7;border:1px solid #e5e5ea;border-radius:8px;padding:14px 22px;color:#111">
      ${esc(code)}
    </span>
  </p>`;
}

export async function sendVerificationEmail(
  opts: { to: string; name?: string | null; code: string },
  log?: Log,
): Promise<void> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const html = layout(
    "Verify your email",
    `<p>${greeting}</p>
     <p>Enter this code in RecruitAssist to verify your email:</p>
     ${codeBlock(opts.code)}
     <p style="color:#555;font-size:13px">This code expires in 24 hours. If you didn't sign up, you can ignore this email.</p>`,
  );
  const text = `${greeting}\n\nVerification code: ${opts.code}\n\nEnter this code in RecruitAssist to verify your email. Code expires in 24 hours.`;
  await sendEmail({ to: opts.to, subject: `${opts.code} is your RecruitAssist verification code`, html, text }, log);
}

export async function sendPasswordResetEmail(
  opts: { to: string; name?: string | null; code: string },
  log?: Log,
): Promise<void> {
  const greeting = opts.name ? `Hi ${esc(opts.name)},` : "Hi,";
  const html = layout(
    "Reset your password",
    `<p>${greeting}</p>
     <p>Use this code in RecruitAssist to reset your password:</p>
     ${codeBlock(opts.code)}
     <p style="color:#555;font-size:13px">This code expires in 1 hour. If you didn't request a reset, you can ignore this email.</p>`,
  );
  const text = `${greeting}\n\nPassword reset code: ${opts.code}\n\nUse this code in RecruitAssist to reset your password. Code expires in 1 hour.`;
  await sendEmail({ to: opts.to, subject: `${opts.code} is your RecruitAssist password reset code`, html, text }, log);
}

export async function sendInvitationEmail(
  opts: { to: string; inviterName: string; orgName: string; role: string; token: string },
  log?: Log,
): Promise<void> {
  const link = `${env.APP_BASE_URL}/accept-invite?token=${encodeURIComponent(opts.token)}`;
  const html = layout(
    `You've been invited to ${opts.orgName}`,
    `<p>${esc(opts.inviterName)} has invited you to join <strong>${esc(opts.orgName)}</strong> on RecruitAssist as a <strong>${esc(opts.role)}</strong>.</p>
     ${btn(link, "Accept invitation")}
     <p style="color:#555;font-size:13px">Or paste this link into your browser:<br><a href="${esc(link)}">${esc(link)}</a></p>
     <p style="color:#555;font-size:13px">This invitation expires in 7 days.</p>`,
  );
  const text = `${opts.inviterName} has invited you to join ${opts.orgName} on RecruitAssist as a ${opts.role}.\n\nAccept: ${link}\n\nThis invitation expires in 7 days.`;
  await sendEmail({ to: opts.to, subject: `You're invited to ${opts.orgName}`, html, text }, log);
}
