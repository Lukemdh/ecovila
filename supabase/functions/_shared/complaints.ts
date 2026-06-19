import { requiredEnv } from './env.ts';
import { createManageToken } from './reservationManage.ts';

export const COMPLAINT_CATEGORIES = ['casuta', 'facilitati', 'personal', 'altceva'] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_SESSION_TTL_MINUTES = 30;
export const COMPLAINT_DESCRIPTION_MAX = 2000;

export function isComplaintCategory(value: unknown): value is ComplaintCategory {
  return COMPLAINT_CATEGORIES.includes(String(value || '') as ComplaintCategory);
}

export function assertValidComplaintCategory(value: unknown): ComplaintCategory {
  if (!isComplaintCategory(value)) {
    throw new Error('Invalid complaint category.');
  }
  return value;
}

/**
 * Trims the guest's text and enforces the 1..2000 char bound the table also
 * checks. Collapses nothing else — the description is shown verbatim to staff.
 */
export function normalizeComplaintDescription(value: unknown): string {
  const text = String(value ?? '').trim();
  if (text.length < 1 || text.length > COMPLAINT_DESCRIPTION_MAX) {
    throw new Error('Complaint description must be between 1 and 2000 characters.');
  }
  return text;
}

export function normalizeComplaintLanguage(value: unknown): 'ro' | 'ru' | 'en' {
  const language = String(value || '').trim().toLowerCase();
  return language === 'ru' || language === 'en' ? language : 'ro';
}

export function createComplaintSessionToken(): string {
  return createManageToken();
}

/**
 * Hash of the SMS login code. The `complaint_login_code` prefix means a code
 * minted here can NEVER satisfy reservation-lookup-verify (which hashes with a
 * different prefix), so reusing the reservation_lookup_codes storage table does
 * not let a complaint code be redeemed for a reservation manage token.
 */
export function hashComplaintCode(
  loginId: string,
  code: string,
  secret = requiredEnv('ECOVILA_CRON_SECRET'),
): Promise<string> {
  return sha256Hex(
    ['complaint_login_code', loginId, normalizeComplaintCode(code), secret].join(':'),
  );
}

export function hashComplaintSessionToken(
  token: string,
  secret = requiredEnv('ECOVILA_CRON_SECRET'),
): Promise<string> {
  return sha256Hex(['complaint_session_token', token, secret].join(':'));
}

export function normalizeComplaintCode(value: unknown): string {
  return String(value || '').replace(/\D/g, '').slice(0, 4);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
