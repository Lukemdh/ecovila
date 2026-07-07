// Operational staff alerts (ADR-088). Money-affecting anomalies — a refund that
// did not complete, a suspected double charge, a paid booking that could not be
// settled — used to be console.error lines nobody reads. Every such branch now
// also emails the address in ECOVILA_ALERT_EMAIL so the owner learns about the
// problem while it is still fixable. Alerts are best-effort by design: a failed
// or unconfigured alert never breaks the flow that raised it, it only logs.
import { optionalEnv } from './env.ts';
import { sendEmail } from './providers.ts';

export type StaffAlertResult = {
  sent: boolean;
  skipped?: boolean;
  error?: string;
};

export function getAlertEmail(): string {
  return optionalEnv('ECOVILA_ALERT_EMAIL').trim();
}

export async function sendStaffAlert(
  subject: string,
  lines: Array<string | null | undefined>,
): Promise<StaffAlertResult> {
  const body = lines.filter(Boolean).join('\n');
  const to = getAlertEmail();

  if (!to) {
    console.error('Staff alert (ECOVILA_ALERT_EMAIL is not set — email skipped)', {
      subject,
      body,
    });
    return { sent: false, skipped: true };
  }

  try {
    await sendEmail({
      to,
      subject: `[EcoVila alertă] ${subject}`,
      text: body,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeAlertHtml(body)}</pre>`,
    });
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Alert email failed.';
    console.error('Staff alert email failed', { subject, message });
    return { sent: false, error: message };
  }
}

function escapeAlertHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
