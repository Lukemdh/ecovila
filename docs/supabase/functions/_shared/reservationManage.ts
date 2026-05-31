import { requiredEnv } from './env.ts';

export const LOOKUP_CODE_TTL_MINUTES = 10;
export const MANAGE_TOKEN_TTL_MINUTES = 30;
export const LOOKUP_MAX_ATTEMPTS = 5;
export const REFUND_GRACE_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RefundEligibilityInput = {
  checkIn: string;
  createdAt: string;
  now?: Date;
};

export type ReservationGroupSummary = {
  primaryReservationId: string;
  bookingGroupId: string;
  checkIn: string;
  checkOut: string;
  roomLabels: string[];
  totalPrice: number;
  paymentType: string;
  paymentStatus: string;
  refundable: boolean;
  refundReason: string;
};

export function normalizePhone(value: unknown) {
  return String(value || '').trim().replace(/[\s().-]/g, '');
}

export function assertValidPhone(value: unknown) {
  const phone = normalizePhone(value);
  if (!/^\+\d{8,15}$/.test(phone)) {
    throw new Error('Invalid phone number.');
  }
  return phone;
}

export function normalizeLookupCode(value: unknown) {
  return String(value || '').replace(/\D/g, '').slice(0, 4);
}

export function createLookupCode() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 10000).padStart(4, '0');
}

export function createManageToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashLookupCode(
  lookupId: string,
  code: string,
  secret = requiredEnv('ECOVILA_CRON_SECRET'),
) {
  return sha256Hex(['reservation_lookup_code', lookupId, normalizeLookupCode(code), secret].join(':'));
}

export async function hashManageToken(
  token: string,
  secret = requiredEnv('ECOVILA_CRON_SECRET'),
) {
  return sha256Hex(['reservation_manage_token', token, secret].join(':'));
}

export function minutesFromNow(minutes: number, now = new Date()) {
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

export function isRefundEligible(input: RefundEligibilityInput) {
  const now = input.now || new Date();
  const todayValue = dateValue(now.toISOString().slice(0, 10));
  const checkInValue = dateValue(input.checkIn);
  const createdAtValue = new Date(input.createdAt).getTime();

  if (!Number.isFinite(todayValue) || !Number.isFinite(checkInValue)) {
    return false;
  }

  const daysUntilCheckIn = (checkInValue - todayValue) / DAY_MS;
  const insideArrivalWindow = daysUntilCheckIn >= 0 && daysUntilCheckIn <= 7;
  const ageMs = now.getTime() - createdAtValue;
  const insideCreationGrace = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < REFUND_GRACE_MS;

  return insideArrivalWindow || insideCreationGrace;
}

export function refundEligibilityReason(input: RefundEligibilityInput) {
  if (!isRefundEligible(input)) {
    return 'outside_refund_window';
  }

  const now = input.now || new Date();
  const todayValue = dateValue(now.toISOString().slice(0, 10));
  const checkInValue = dateValue(input.checkIn);
  const daysUntilCheckIn = (checkInValue - todayValue) / DAY_MS;

  if (daysUntilCheckIn >= 0 && daysUntilCheckIn <= 7) {
    return 'arrival_window';
  }

  return 'creation_grace';
}

export function groupReservations(rows: any[], now = new Date()): ReservationGroupSummary[] {
  const groups = new Map<string, any[]>();

  rows.forEach((row) => {
    const key = String(row.booking_group_id || row.id);
    groups.set(key, (groups.get(key) || []).concat(row));
  });

  return [...groups.entries()].map(([bookingGroupId, reservations]) => {
    const sorted = reservations.slice().sort((left, right) =>
      String(left.check_in).localeCompare(String(right.check_in)) ||
      String(left.created_at).localeCompare(String(right.created_at))
    );
    const primary = sorted[0];
    const totalPrice = sorted.reduce((sum, row) => sum + Number(row.total_price || 0), 0);
    const checkIn = sorted.reduce((min, row) =>
      !min || String(row.check_in) < min ? String(row.check_in) : min, '');
    const checkOut = sorted.reduce((max, row) =>
      !max || String(row.check_out) > max ? String(row.check_out) : max, '');
    const createdAt = sorted.reduce((min, row) =>
      !min || String(row.created_at) < min ? String(row.created_at) : min, '');

    return {
      primaryReservationId: String(primary.id),
      bookingGroupId,
      checkIn,
      checkOut,
      roomLabels: sorted.map(roomLabel),
      totalPrice,
      paymentType: String(primary.payment_type || ''),
      paymentStatus: String(primary.payment_status || ''),
      refundable: isRefundEligible({ checkIn, createdAt, now }),
      refundReason: refundEligibilityReason({ checkIn, createdAt, now }),
    };
  });
}

export function composeLookupCodeSms(code: string) {
  return `EcoVila: codul pentru rezervarea dvs. este ${code}. Codul este valabil 10 minute.`;
}

export function getClientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('cf-connecting-ip') ||
    '';
}

export function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function roomLabel(row: any) {
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
  const number = room?.number || row.room_number;
  const type = room?.type || row.room_type || 'hotel';
  const typeLabel = type === 'small' ? 'Căsuță Mică' : type === 'large' ? 'Căsuță Mare' : 'Hotel';
  return number ? `${typeLabel} #${number}` : typeLabel;
}

function dateValue(dateString: string) {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) {
    return Number.NaN;
  }
  return Date.UTC(year, month - 1, day);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
