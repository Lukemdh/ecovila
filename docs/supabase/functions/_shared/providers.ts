import { optionalEnv, requiredEnv } from './env.ts';

export type SmsPayload = {
  to: string;
  message: string;
};

export type EmailPayload = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
};

export type ProviderOptions = {
  fetcher?: typeof fetch;
};

export function sendSms(payload: SmsPayload, options: ProviderOptions = {}) {
  const fetcher = options.fetcher || fetch;
  const endpoint = optionalEnv('SMSMD_API_URL') || 'https://api.sms.md/v1/send';
  const apiToken = requiredEnv('SMSMD_API_TOKEN');
  const from = requiredEnv('SMSMD_FROM');
  const url = new URL(endpoint);
  url.searchParams.set('token', apiToken);
  url.searchParams.set('from', from);
  url.searchParams.set('to', payload.to);
  url.searchParams.set('message', payload.message);

  return sendProviderRequest(fetcher, url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
}

export function sendEmail(payload: EmailPayload, options: ProviderOptions = {}) {
  const fetcher = options.fetcher || fetch;
  const endpoint = optionalEnv('RESEND_API_URL') || 'https://api.resend.com/emails';
  const apiKey = requiredEnv('RESEND_API_KEY');
  const fromEmail = requiredEnv('RESEND_FROM_EMAIL');
  const from = fromEmail.includes('<') ? fromEmail : `EcoVila <${fromEmail}>`;

  return sendProviderRequest(fetcher, endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });
}

async function sendProviderRequest(fetcher: typeof fetch, endpoint: string, init: RequestInit) {
  const response = await fetcher(endpoint, init);
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Provider request failed with ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function readResponseBody(response: Response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return { body: text };
  }
}
