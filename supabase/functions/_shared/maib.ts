import { optionalEnv, requiredEnv } from './env.ts';

// The card payment hold lasts five minutes from the guest's first payment
// attempt. Retries within the window reuse this same deadline (see
// maib-create-payment) so closing the gateway or a failed charge never extends
// the hold; the per-minute expiry cron releases the room once it elapses.
export const MAIB_PAYMENT_SESSION_MINUTES = 5;
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

type MaibErrorItem = {
  errorMessage?: string;
  message?: string;
  errorCode?: string | number;
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

// ── MIA QR (instant payments) ──────────────────────────────────────────────
// docs.maibmerchants.md/mia-qr-api. The MIA QR API shares the host and OAuth
// token of the card Checkout API, so no extra credentials are needed. For a
// +373 guest we mint a single dynamic, fixed-amount QR per booking; the guest
// pays by scanning it or tapping the deeplink. Payment is confirmed by an
// authenticated GET against /v2/mia/payments (status "Executed"), so the
// callback signature key is never required — a forged callback cannot settle a
// booking because we always re-read the source of truth.

export type MaibMiaQrInput = {
  amount: number;
  orderId: string;
  description: string;
  callbackUrl: string;
  expiresAt: string;
};

export type MaibMiaQrResult = {
  qrId: string;
  url: string;
  orderId: string;
  expiresAt: string;
  raw: Record<string, unknown>;
};

export type MaibMiaPayment = {
  payId: string;
  qrId: string;
  orderId: string;
  status: string;
  amount: number | null;
  currency: string;
  raw: Record<string, unknown>;
};

export function buildMaibMiaQrPayload(input: MaibMiaQrInput) {
  const amount = normalizeAmount(input.amount);
  const description = trim(input.description).slice(0, 250) ||
    `EcoVila booking ${trim(input.orderId)}`;

  return {
    type: 'Dynamic',
    amountType: 'Fixed',
    amount,
    currency: 'MDL',
    orderId: trim(input.orderId),
    description,
    callbackUrl: input.callbackUrl,
    expiresAt: input.expiresAt,
  };
}

export async function createMaibMiaQr(
  input: MaibMiaQrInput,
  options: MaibFetchOptions = {},
): Promise<MaibMiaQrResult> {
  const fetcher = options.fetcher || fetch;
  const baseUrl = (options.baseUrl || getMaibBaseUrl()).replace(/\/+$/, '');
  const token = await getMaibAccessToken({ ...options, fetcher, baseUrl });
  const payload = buildMaibMiaQrPayload(input);
  const response = await fetcher(`${baseUrl}/v2/mia/qr`, {
    method: 'POST',
    headers: {
      Authorization: `${token.tokenType} ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.ok === false) {
    throw new Error(formatMaibError(body, 'Maib MIA QR could not be created.'));
  }

  const result = isRecord(body?.result) ? body.result : {};
  const qrId = trim(result.qrId);
  const url = trim(result.url);

  if (!qrId || !url) {
    throw new Error('Maib MIA QR response did not include qrId and url.');
  }

  return {
    qrId,
    url,
    orderId: trim(result.orderId) || trim(input.orderId),
    expiresAt: trim(result.expiresAt) || input.expiresAt,
    raw: body,
  };
}

export async function getMaibMiaPaymentByOrderId(
  orderId: string,
  options: MaibFetchOptions = {},
): Promise<MaibMiaPayment | null> {
  const fetcher = options.fetcher || fetch;
  const baseUrl = (options.baseUrl || getMaibBaseUrl()).replace(/\/+$/, '');
  const token = await getMaibAccessToken({ ...options, fetcher, baseUrl });
  const response = await fetcher(
    `${baseUrl}/v2/mia/payments?orderId=${encodeURIComponent(trim(orderId))}`,
    {
      method: 'GET',
      headers: { Authorization: `${token.tokenType} ${token.accessToken}` },
    },
  );
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.ok === false) {
    throw new Error(formatMaibError(body, 'Maib MIA payments could not be read.'));
  }

  const result = isRecord(body?.result) ? body.result : {};
  const rawItems: unknown[] = Array.isArray(result.items) ? result.items as unknown[] : [];
  const items = rawItems.filter(isRecord);
  if (!items.length) {
    return null;
  }

  // Prefer a settled payment when several attempts exist for one order.
  const executed = items.find((item) => isMaibMiaPaymentExecuted(item));
  return toMiaPayment(executed || items[0]);
}

export async function cancelMaibMiaQr(
  qrId: string,
  reason: string,
  options: MaibFetchOptions = {},
) {
  const fetcher = options.fetcher || fetch;
  const baseUrl = (options.baseUrl || getMaibBaseUrl()).replace(/\/+$/, '');
  const token = await getMaibAccessToken({ ...options, fetcher, baseUrl });
  const response = await fetcher(
    `${baseUrl}/v2/mia/qr/${encodeURIComponent(trim(qrId))}/cancel`,
    {
      method: 'POST',
      headers: {
        Authorization: `${token.tokenType} ${token.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: trim(reason) || 'cancelled' }),
    },
  );
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body?.ok === false) {
    throw new Error(formatMaibError(body, 'Maib MIA QR could not be cancelled.'));
  }

  return body;
}

export function normalizeMaibMiaPaymentStatus(
  payment: Record<string, unknown>,
): MaibCallbackStatus {
  const status = trim(payment.status).toLowerCase();

  if (status === 'executed') {
    return 'paid';
  }
  if (status === 'cancelled' || status === 'canceled') {
    return 'cancelled';
  }
  if (status === 'declined' || status === 'failed' || status === 'rejected') {
    return 'failed';
  }

  return 'pending';
}

export function isMaibMiaPaymentExecuted(payment: Record<string, unknown>) {
  return normalizeMaibMiaPaymentStatus(payment) === 'paid';
}

export function getMaibMiaCallbackOrderId(payload: Record<string, unknown>) {
  const result = isRecord(payload.result) ? payload.result : {};
  return trim(payload.orderId) || trim(result.orderId);
}

export function getMaibMiaCallbackQrId(payload: Record<string, unknown>) {
  const result = isRecord(payload.result) ? payload.result : {};
  return trim(payload.qrId) || trim(result.qrId);
}

export function getMaibMiaCallbackUrl() {
  const configured = optionalEnv('MAIB_MIA_CALLBACK_URL');
  if (configured) {
    return configured;
  }

  return `${requiredEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1/maib-mia-callback`;
}

function toMiaPayment(item: Record<string, unknown>): MaibMiaPayment {
  const rawAmount = Number(item.amount);

  return {
    payId: trim(item.payId),
    qrId: trim(item.qrId),
    orderId: trim(item.orderId),
    status: trim(item.status),
    amount: Number.isFinite(rawAmount) ? rawAmount : null,
    currency: trim(item.currency) || 'MDL',
    raw: item,
  };
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

export function getMaibCallbackAmount(payload: Record<string, unknown>) {
  const result = isRecord(payload.result) ? payload.result : {};
  const candidates = [payload.amount, payload.orderAmount, result.amount, result.orderAmount];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || trim(candidate) === '') {
      continue;
    }

    const amount = Number(candidate);
    if (Number.isFinite(amount)) {
      return amount;
    }
  }

  return null;
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

function formatMaibError(body: unknown, fallback: string) {
  const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const message = errors
    .map((error) => maibErrorMessage(error))
    .filter(Boolean)
    .join('; ');

  return message || fallback;
}

function maibErrorMessage(error: unknown) {
  if (!isRecord(error)) {
    return '';
  }

  const item = error as MaibErrorItem;
  return String(item.errorMessage || item.message || item.errorCode || '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
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
