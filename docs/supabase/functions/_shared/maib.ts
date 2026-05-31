import { optionalEnv, requiredEnv } from './env.ts';

export const MAIB_PAYMENT_SESSION_MINUTES = 15;
export const MAIB_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export type MaibCheckoutPayloadInput = {
  amount: number;
  bookingGroupId: string;
  description: string;
  guestEmail: string;
  guestName: string;
  guestPhone: string;
  language?: string;
  createdAt?: string;
  callbackUrl: string;
  successUrl: string;
  failUrl: string;
  ip?: string;
  userAgent?: string;
};

export type MaibCheckoutResult = {
  payId: string;
  payUrl: string;
  raw: Record<string, unknown>;
};

export type MaibCallbackStatus = 'paid' | 'pending' | 'failed' | 'cancelled';

type MaibFetchOptions = {
  fetcher?: typeof fetch;
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
};

type SignatureVerificationOptions = {
  now?: number;
  toleranceMs?: number;
};

const SUPPORTED_LANGUAGES = new Set(['ro', 'ru', 'en']);

export function getMaibBaseUrl() {
  return requiredEnv('MAIB_BASE_URL').replace(/\/+$/, '');
}

export async function createMaibCheckout(
  input: MaibCheckoutPayloadInput,
  options: MaibFetchOptions = {},
): Promise<MaibCheckoutResult> {
  const fetcher = options.fetcher || fetch;
  const baseUrl = (options.baseUrl || getMaibBaseUrl()).replace(/\/+$/, '');
  const token = await getMaibAccessToken({ ...options, fetcher, baseUrl });
  const payload = buildMaibCheckoutPayload(input);
  const response = await fetcher(`${baseUrl}/v2/checkouts`, {
    method: 'POST',
    headers: {
      Authorization: `${token.tokenType} ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.ok === false) {
    throw new Error(formatMaibError(body, 'Maib checkout session could not be created.'));
  }

  const payId = String(body?.result?.checkoutId || '').trim();
  const payUrl = String(body?.result?.checkoutUrl || '').trim();

  if (!payId || !payUrl) {
    throw new Error('Maib checkout response did not include checkoutId and checkoutUrl.');
  }

  return { payId, payUrl, raw: body };
}

export async function refundMaibPayment(
  payId: string,
  amount: number,
  reason: string,
  options: MaibFetchOptions = {},
) {
  const fetcher = options.fetcher || fetch;
  const baseUrl = (options.baseUrl || getMaibBaseUrl()).replace(/\/+$/, '');
  const token = await getMaibAccessToken({ ...options, fetcher, baseUrl });
  const response = await fetcher(`${baseUrl}/v2/payments/${encodeURIComponent(payId)}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `${token.tokenType} ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount, reason }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.ok === false) {
    throw new Error(formatMaibError(body, 'Maib refund could not be created.'));
  }

  return body;
}

export async function getMaibAccessToken(options: MaibFetchOptions = {}) {
  const fetcher = options.fetcher || fetch;
  const baseUrl = (options.baseUrl || getMaibBaseUrl()).replace(/\/+$/, '');
  const clientId = options.clientId || requiredEnv('MAIB_CLIENT_ID');
  const clientSecret = options.clientSecret || requiredEnv('MAIB_CLIENT_SECRET');
  const response = await fetcher(`${baseUrl}/v2/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.ok === false) {
    throw new Error(formatMaibError(body, 'Maib authentication failed.'));
  }

  const accessToken = String(body?.result?.accessToken || '').trim();
  const tokenType = String(body?.result?.tokenType || 'Bearer').trim() || 'Bearer';

  if (!accessToken) {
    throw new Error('Maib authentication response did not include an access token.');
  }

  return { accessToken, tokenType };
}

export function buildMaibCheckoutPayload(input: MaibCheckoutPayloadInput) {
  const amount = normalizeAmount(input.amount);
  const description = trim(input.description).slice(0, 125) ||
    `EcoVila booking ${input.bookingGroupId}`;

  return {
    amount,
    currency: 'MDL',
    orderInfo: {
      id: trim(input.bookingGroupId),
      description,
      date: input.createdAt || new Date().toISOString(),
      orderAmount: amount,
      orderCurrency: 'MDL',
      deliveryAmount: null,
      deliveryCurrency: null,
      items: [
        {
          externalId: 'ecovila-booking',
          title: description,
          amount,
          currency: 'MDL',
          quantity: 1,
          displayOrder: 1,
        },
      ],
    },
    payerInfo: compactObject({
      name: trim(input.guestName),
      email: trim(input.guestEmail).toLowerCase(),
      phone: trim(input.guestPhone),
      ip: trim(input.ip),
      userAgent: trim(input.userAgent),
    }),
    language: normalizeLanguage(input.language),
    callbackUrl: input.callbackUrl,
    successUrl: input.successUrl,
    failUrl: input.failUrl,
  };
}

export async function createMaibCallbackSignature(
  rawBody: string,
  timestamp: string,
  signatureKey = requiredEnv('MAIB_SIGNATURE_KEY'),
) {
  const message = `${rawBody}.${timestamp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signatureKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToBase64(new Uint8Array(signature));
}

export async function verifyMaibCallbackSignature(
  rawBody: string,
  headers: Headers,
  signatureKey = requiredEnv('MAIB_SIGNATURE_KEY'),
  options: SignatureVerificationOptions = {},
) {
  const signatureHeader = headers.get('X-Signature') || headers.get('x-signature') || '';
  const timestamp = headers.get('X-Signature-Timestamp') ||
    headers.get('x-signature-timestamp') ||
    '';

  if (!signatureHeader.startsWith('sha256=') || !timestamp) {
    return false;
  }

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    return false;
  }

  const now = options.now ?? Date.now();
  const toleranceMs = options.toleranceMs ?? MAIB_SIGNATURE_TOLERANCE_MS;
  if (Math.abs(now - timestampNumber) > toleranceMs) {
    return false;
  }

  const expected = await createMaibCallbackSignature(rawBody, timestamp, signatureKey);
  const received = signatureHeader.slice('sha256='.length);

  return constantTimeEqual(expected, received);
}

export function parseMaibCallback(rawBody: string) {
  try {
    return JSON.parse(rawBody);
  } catch (_error) {
    throw new Error('Expected a valid Maib callback JSON body.');
  }
}

export function getMaibCallbackOrderId(payload: Record<string, unknown>) {
  return trim(payload.orderId);
}

export function getMaibCallbackPayId(payload: Record<string, unknown>) {
  return trim(payload.checkoutId) || trim(payload.paymentId);
}

export function getMaibProviderPaymentId(payload: Record<string, unknown>) {
  return trim(payload.paymentId);
}

export function normalizeMaibCallbackStatus(payload: Record<string, unknown>): MaibCallbackStatus {
  const paymentStatus = trim(payload.paymentStatus);
  const processingStatus = trim(payload.processingStatus);
  const processingStatusCode = trim(payload.processingStatusCode);
  const normalizedPaymentStatus = paymentStatus.toLowerCase();
  const normalizedProcessingStatus = processingStatus.toLowerCase();

  if (
    normalizedPaymentStatus === 'executed' &&
    (!processingStatus || normalizedProcessingStatus === 'ok') &&
    (!processingStatusCode || isZeroStatusCode(processingStatusCode))
  ) {
    return 'paid';
  }

  if (normalizedPaymentStatus === 'cancelled' || normalizedPaymentStatus === 'canceled') {
    return 'cancelled';
  }

  if (normalizedPaymentStatus === 'failed') {
    return 'failed';
  }

  return 'pending';
}

export function isMaibCallbackApproved(payload: Record<string, unknown>) {
  return normalizeMaibCallbackStatus(payload) === 'paid';
}

export function getMaibCallbackStatus(payload: Record<string, unknown>) {
  return normalizeMaibCallbackStatus(payload);
}

export function isMaibCallbackTerminalStatus(status: MaibCallbackStatus) {
  return status === 'paid' || status === 'failed' || status === 'cancelled';
}

function isZeroStatusCode(value: string) {
  return /^0+$/.test(value);
}

export function getMaibCallbackUrl() {
  const configured = optionalEnv('MAIB_CALLBACK_URL');
  if (configured) {
    return configured;
  }

  return `${requiredEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/maib-callback`;
}

function formatMaibError(body: any, fallback: string) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const message = errors
    .map((error: any) => error?.errorMessage || error?.message || error?.errorCode)
    .filter(Boolean)
    .join('; ');

  return message || fallback;
}

function normalizeAmount(value: unknown) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Maib amount must be greater than zero.');
  }

  return Math.round(amount * 100) / 100;
}

function normalizeLanguage(value: unknown) {
  const language = trim(value).toLowerCase();
  return SUPPORTED_LANGUAGES.has(language) ? language : 'ro';
}

function trim(value: unknown) {
  return String(value ?? '').trim();
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([_key, item]) => item !== ''),
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return result === 0;
}
