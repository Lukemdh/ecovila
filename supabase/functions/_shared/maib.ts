import { requiredEnv } from './env.ts';

export type MaibCallbackPayload = {
  result?: Record<string, unknown>;
  signature?: string;
};

export async function verifyMaibSignature(
  payload: MaibCallbackPayload,
  signatureKey = requiredEnv('MAIB_SIGNATURE_KEY'),
) {
  if (!payload.result || !payload.signature) {
    return false;
  }

  const expected = await createMaibSignature(payload.result, signatureKey);
  return constantTimeEqual(expected, payload.signature);
}

export async function createMaibSignature(result: Record<string, unknown>, signatureKey: string) {
  const sortedValues = Object.keys(result)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => valueToString(result[key]));
  const signatureBase = [...sortedValues, signatureKey].join(':');
  const bytes = new TextEncoder().encode(signatureBase);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return bytesToBase64(new Uint8Array(digest));
}

export function getMaibOrderId(payload: MaibCallbackPayload) {
  return String(payload.result?.orderId || '').trim();
}

export function isMaibApproved(payload: MaibCallbackPayload) {
  return payload.result?.status === 'OK' && payload.result?.statusCode === '000';
}

function valueToString(value: unknown) {
  if (value == null) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
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
