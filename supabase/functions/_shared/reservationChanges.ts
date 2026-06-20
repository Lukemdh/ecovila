// Guest-initiated "add people" changes to a confirmed reservation (ADR-057).
//
// A guest who already paid online can add adults/children to their booking and
// pay only the price difference for the extra guests. Each request is its own
// row in public.reservation_changes — deliberately NOT on maib_payments, whose
// every reconcile/refund/callback path keys off the latest row per booking
// group and would otherwise be hijacked by a difference payment.
//
// This module owns: server-side capacity + price-difference recomputation (the
// browser quote is advisory only), the idempotent "apply the new party once the
// difference is paid" step, the MIA pull-reconcile parallel, and the guest
// confirmation notification. Card and MIA both confirm against MAIB's own
// records, so a forged callback can never apply a change.
import { HttpError } from './http.ts';
import { getSiteUrl } from './env.ts';
import { buildManageTokenRow, hashManageToken } from './reservationManage.ts';
import { fetchHolidays, fetchPricingTiers, getPricing } from './pricingGuard.ts';
import {
  cancelMaibMiaQr,
  getMaibMiaPaymentByOrderId,
  normalizeMaibMiaPaymentStatus,
  refundMaibPayment,
} from './maib.ts';
import { sendEmail, sendSms } from './providers.ts';
import {
  aggregateRoomLabel,
  bookingChangeSms,
  buildBookingChangeEmail,
  normalizeEmailLang,
  titleCaseName,
} from './notifications.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

const BUSINESS_TIME_ZONE = 'Europe/Chisinau';
// The difference is not an inventory hold (the room is already paid). This only
// bounds the MIA QR / checkout validity, kept at 5 minutes to match the booking
// MIA flow so the plata-mia poll window (~6.5 min) fully covers it — otherwise a
// guest could pay after polling stops and be left on a "pending" QR page (the
// MIA callback still settles server-side, but the page wouldn't redirect).
export const CHANGE_PAYMENT_MINUTES = 5;
// Match the reservations table's stored range (0–18) so no existing child is
// dropped from the capacity/superset checks; the booking UI only adds 1–17.
const KID_AGE_MIN = 0;
const KID_AGE_MAX = 18;

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  is(column: string, value: unknown): QueryBuilder<T>;
  gt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  single(): Promise<SupabaseQueryResult<T>>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RoomTypeConfig = {
  type: string;
  maxAdults: number;
  maxKids: number;
  minimumAdults: number;
};

type ChangePricingApi = {
  ROOM_TYPES: Record<string, RoomTypeConfig>;
  getUnitsNeeded(roomType: string, party: { adults: number; kidsAges: number[] }): number;
  calculateStayPrice(input: {
    roomType: string;
    adults: number;
    kidsAges: number[];
    checkIn: string;
    checkOut: string;
    units: number;
    pricingTiers: unknown[];
    holidays: unknown[];
  }): { total: number };
};

type RoomRelation = { number?: number | string | null; type?: string | null };

export type ChangeReservationRow = {
  id: string;
  booking_group_id: string;
  room_id?: string | null;
  guest_first_name?: string | null;
  guest_last_name?: string | null;
  guest_phone?: string | null;
  guest_email?: string | null;
  guest_language?: string | null;
  check_in: string;
  check_out: string;
  adults: number | string;
  kids_ages?: unknown[] | null;
  total_price: number | string;
  payment_type?: string | null;
  payment_status?: string | null;
  cancelled_at?: string | null;
  rooms?: RoomRelation | RoomRelation[] | null;
};

export type ReservationChangeRow = {
  id: string;
  booking_group_id: string;
  reservation_ids: string[];
  room_type?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  prev_adults: number;
  prev_kids_ages: number[];
  new_adults: number;
  new_kids_ages: number[];
  prev_total: number;
  new_total: number;
  difference_amount: number;
  payment_rail?: string | null;
  pay_id?: string | null;
  provider_payment_id?: string | null;
  status: string;
  checkout_url?: string | null;
  expires_at?: string | null;
  paid_at?: string | null;
  applied_at?: string | null;
};

export type ChangeQuote = {
  roomType: string;
  units: number;
  checkIn: string;
  checkOut: string;
  prevAdults: number;
  prevKidsAges: number[];
  newAdults: number;
  newKidsAges: number[];
  prevTotal: number;
  newTotal: number;
  difference: number;
};

export type ChangePublicStatus = 'paid' | 'pending' | 'failed' | 'expired' | 'not_found';

// ── Manage-token auth (mirrors reservation-manage-details) ───────────────────

export async function validateManageTokenPhone(client: SupabaseClient, token: string) {
  const tokenHash = await hashManageToken(token);
  const { data, error } = await table<{ phone: string; expires_at: string }>(
    client,
    'reservation_manage_tokens',
  )
    .select('phone, expires_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || new Date(data.expires_at).getTime() < Date.now()) {
    throw new HttpError(401, 'Invalid or expired manage token.');
  }

  await table(client, 'reservation_manage_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash);

  return data.phone;
}

// ── Load + eligibility ───────────────────────────────────────────────────────

export async function loadBookingGroupForChange(
  client: SupabaseClient,
  reservationId: string,
  phone: string,
): Promise<ChangeReservationRow[]> {
  const { data: primary, error: primaryError } = await table<{ booking_group_id: string }>(
    client,
    'reservations',
  )
    .select('booking_group_id')
    .eq('id', reservationId)
    .eq('guest_phone', phone)
    .maybeSingle();

  if (primaryError) throw new Error(primaryError.message);
  if (!primary) return [];

  const { data, error } = await table<ChangeReservationRow[]>(client, 'reservations')
    .select(
      'id, booking_group_id, room_id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, adults, kids_ages, total_price, payment_type, payment_status, cancelled_at, rooms(number, type)',
    )
    .eq('booking_group_id', primary.booking_group_id)
    .eq('guest_phone', phone)
    .order('check_in', { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

export function assertEligibleForChange(reservations: ChangeReservationRow[], now = new Date()) {
  if (!reservations.length) {
    throw new HttpError(404, 'Reservation was not found.');
  }

  const today = chisinauToday(now);
  const allOnlinePaid = reservations.every(
    (row) =>
      String(row.payment_type) === 'card' &&
      String(row.payment_status) === 'paid' &&
      !row.cancelled_at,
  );

  if (!allOnlinePaid) {
    throw new HttpError(409, 'Only confirmed online-paid reservations can add guests.');
  }

  const stillUpcoming = reservations.every((row) => String(row.check_out) > today);
  if (!stillUpcoming) {
    throw new HttpError(409, 'This stay has ended and can no longer be changed.');
  }
}

// ── Capacity + price-difference recompute (server is authoritative) ──────────

export async function quoteBookingChange(
  client: SupabaseClient,
  input: {
    reservations: ChangeReservationRow[];
    newAdults: number;
    newKidsAges: number[];
  },
): Promise<ChangeQuote> {
  const pricing = getPricing() as unknown as ChangePricingApi;
  const rows = input.reservations;
  const primary = rows[0];
  const roomType = roomTypeOf(primary);
  const units = rows.length;

  if (!roomType || !pricing.ROOM_TYPES[roomType]) {
    throw new HttpError(409, 'This reservation cannot be changed online.');
  }

  const config = pricing.ROOM_TYPES[roomType];
  const prevAdults = Math.trunc(Number(primary.adults || 0));
  const prevKidsAges = normalizeKidsAges(primary.kids_ages);
  const newAdults = Math.trunc(Number(input.newAdults));
  const rawNewKids = Array.isArray(input.newKidsAges) ? input.newKidsAges : [];

  // Bound the requested party to the booking's physical capacity BEFORE any
  // capacity search or array processing, so a forged oversized value (a direct
  // API call bypassing the stepper UI) can't spin getUnitsNeeded — a linear scan
  // over the adult count — or array work into a CPU denial of service.
  const capacityAdults = units * config.maxAdults;
  const capacityGuests = units * (config.maxAdults + config.maxKids);
  if (
    !Number.isInteger(newAdults) ||
    newAdults < 0 ||
    newAdults > capacityAdults ||
    rawNewKids.length > capacityGuests
  ) {
    throw new HttpError(409, 'The added guests do not fit in the booked accommodation.');
  }

  const newKidsAges = normalizeKidsAges(rawNewKids);

  if (newAdults < prevAdults) {
    throw new HttpError(400, 'Guests can only be added, not removed.');
  }
  if (!isSuperset(prevKidsAges, newKidsAges)) {
    throw new HttpError(400, 'Existing children cannot be edited or removed, only new ones added.');
  }
  if (newAdults === prevAdults && newKidsAges.length === prevKidsAges.length) {
    throw new HttpError(400, 'No new guests were added.');
  }

  // "Fit in the rooms they have chosen": the new party must need no more units
  // than the booking already has. Adults can only grow, so each villa keeps an
  // adult and the units stay valid.
  const neededUnits = pricing.getUnitsNeeded(roomType, {
    adults: newAdults,
    kidsAges: newKidsAges,
  });
  if (neededUnits > units) {
    throw new HttpError(409, 'The added guests do not fit in the booked accommodation.');
  }

  const [pricingTiers, holidays] = await Promise.all([
    fetchPricingTiers(client),
    fetchHolidays(client),
  ]);
  if (!pricingTiers.length) {
    throw new Error('No pricing tiers are configured.');
  }

  // Charge for the added guests only — recompute BOTH parties at current prices
  // and take the delta, so a tariff change since the original booking never
  // leaks into the difference.
  const oldQuote = pricing.calculateStayPrice({
    roomType,
    adults: prevAdults,
    kidsAges: prevKidsAges,
    checkIn: String(primary.check_in),
    checkOut: String(primary.check_out),
    units,
    pricingTiers,
    holidays,
  });
  const newQuote = pricing.calculateStayPrice({
    roomType,
    adults: newAdults,
    kidsAges: newKidsAges,
    checkIn: String(primary.check_in),
    checkOut: String(primary.check_out),
    units,
    pricingTiers,
    holidays,
  });

  const difference = Math.round(newQuote.total) - Math.round(oldQuote.total);
  if (difference < 0) {
    throw new HttpError(409, 'The requested change does not increase the price.');
  }

  const prevTotal = rows.reduce((sum, row) => sum + Math.round(Number(row.total_price || 0)), 0);

  return {
    roomType,
    units,
    checkIn: String(primary.check_in),
    checkOut: String(primary.check_out),
    prevAdults,
    prevKidsAges,
    newAdults,
    newKidsAges,
    prevTotal,
    newTotal: prevTotal + difference,
    difference,
  };
}

// ── Persisting the change row ────────────────────────────────────────────────

export async function insertChangeRow(
  client: SupabaseClient,
  input: {
    bookingGroupId: string;
    reservationIds: string[];
    quote: ChangeQuote;
    paymentRail: 'mia' | 'card' | null;
    status: string;
    expiresAt: string | null;
    paidAt: string | null;
    appliedAt: string | null;
  },
): Promise<ReservationChangeRow> {
  const { quote } = input;
  const { data, error } = await table<ReservationChangeRow>(client, 'reservation_changes')
    .insert({
      booking_group_id: input.bookingGroupId,
      reservation_ids: input.reservationIds,
      room_type: quote.roomType,
      check_in: quote.checkIn,
      check_out: quote.checkOut,
      prev_adults: quote.prevAdults,
      prev_kids_ages: quote.prevKidsAges,
      new_adults: quote.newAdults,
      new_kids_ages: quote.newKidsAges,
      prev_total: quote.prevTotal,
      new_total: quote.newTotal,
      difference_amount: quote.difference,
      payment_rail: input.paymentRail,
      status: input.status,
      expires_at: input.expiresAt,
      paid_at: input.paidAt,
      applied_at: input.appliedAt,
    })
    .select('*')
    .single();

  if (error) {
    // A concurrent double-submit trips the one-open-change-per-booking partial
    // unique index (reservation_changes_one_open_per_group_idx). That is the
    // index doing its job — surface it as a retryable 409 rather than a raw 500
    // so the loser of the race gets a clean "try again", never a second payable
    // session.
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(
        409,
        'A guest change is already in progress for this booking. Please wait a moment and try again.',
      );
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error('Reservation change row could not be created.');
  return data;
}

export async function attachChangePayment(
  client: SupabaseClient,
  changeId: string,
  payment: { payId: string; checkoutUrl: string; expiresAt: string; raw: Record<string, unknown> },
) {
  const { error } = await table(client, 'reservation_changes')
    .update({
      pay_id: payment.payId,
      checkout_url: payment.checkoutUrl,
      expires_at: payment.expiresAt,
      callback_payload: { checkout: payment.raw },
      updated_at: new Date().toISOString(),
    })
    .eq('id', changeId);

  if (error) throw new Error(error.message);
}

// Cancel any earlier still-open change for this booking group before minting a
// new one, so a guest who re-edits never leaves a stale payable QR behind.
export async function supersedeOpenChanges(
  client: SupabaseClient,
  bookingGroupId: string,
) {
  const { data, error } = await table<ReservationChangeRow[]>(client, 'reservation_changes')
    .select('id, pay_id, payment_rail, status')
    .eq('booking_group_id', bookingGroupId)
    .eq('status', 'pending');

  if (error) throw new Error(error.message);

  for (const open of data || []) {
    if (open.payment_rail === 'mia' && open.pay_id) {
      try {
        await cancelMaibMiaQr(open.pay_id, 'superseded');
      } catch (cancelError) {
        console.error('Could not cancel superseded MIA change QR', cancelError);
      }
    }
    await table(client, 'reservation_changes')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', open.id)
      .eq('status', 'pending');
  }
}

// ── Apply the party change (idempotent) ──────────────────────────────────────

export async function applyBookingChange(
  client: SupabaseClient,
  change: ReservationChangeRow,
  now: string,
): Promise<{ applied: boolean }> {
  // Claim the apply exactly once: only the caller that flips applied_at from
  // null performs the writes + notification. Re-entrant callbacks/polls no-op.
  const { data: claimed, error: claimError } = await table<ReservationChangeRow[]>(
    client,
    'reservation_changes',
  )
    .update({
      status: 'paid',
      paid_at: change.paid_at || now,
      applied_at: now,
      updated_at: now,
    })
    .eq('id', change.id)
    .is('applied_at', null)
    .select('id')
    .order('id', { ascending: true });

  if (claimError) throw new Error(claimError.message);
  if (!claimed || !claimed.length) {
    return { applied: false };
  }

  // NB: public.reservations has no updated_at column (see foundation schema), so
  // only the changed party fields are written — matching bookingSettlement.
  const { data: updatedRows, error: updateError } = await table<{ id: string }[]>(
    client,
    'reservations',
  )
    .update({
      adults: change.new_adults,
      kids_ages: change.new_kids_ages,
    })
    .in('id', change.reservation_ids)
    .is('cancelled_at', null)
    .select('id');

  if (updateError) throw new Error(updateError.message);

  if (!updatedRows || !updatedRows.length) {
    // Whole booking was cancelled between paying and applying — the guest was
    // charged for guests that no longer have a room. Flag for a manual refund.
    console.error('Reservation change paid but no live reservation rows to update', {
      changeId: change.id,
      bookingGroupId: change.booking_group_id,
    });
  }

  return { applied: true };
}

// ── Settlement entry points (card callback + MIA reconcile share this) ───────

export async function settleChangePaid(
  client: SupabaseClient,
  change: ReservationChangeRow,
  now: string,
  source: string,
): Promise<{ applied: boolean }> {
  const result = await applyBookingChange(client, change, now);

  if (result.applied) {
    try {
      await notifyBookingChange(client, change, source);
    } catch (error) {
      console.error('Reservation change confirmation notification failed', error);
    }
  }

  return result;
}

export type ChangeRefundResult = {
  changeId: string;
  amount: number;
  refundId: string | null;
};

// Refund every paid "add guests" difference for a booking group as its own MAIB
// transaction (alongside the original booking refund). Idempotent: rows already
// refunded are skipped, so a retried cancellation never double-refunds. The
// caller refunds only when the cancellation itself is refund-eligible.
export async function refundPaidChanges(
  client: SupabaseClient,
  bookingGroupId: string,
  reason: string,
): Promise<ChangeRefundResult[]> {
  const { data, error } = await table<ReservationChangeRow[]>(client, 'reservation_changes')
    .select('id, provider_payment_id, difference_amount, status')
    .eq('booking_group_id', bookingGroupId)
    .eq('status', 'paid')
    .is('refunded_at', null)
    .gt('difference_amount', 0);

  if (error) throw new Error(error.message);

  const results: ChangeRefundResult[] = [];

  for (const change of data || []) {
    const providerPayId = change.provider_payment_id;
    const amount = Number(change.difference_amount || 0);
    if (!providerPayId || !(amount > 0)) {
      // Free applies have no payment to reverse; nothing to refund.
      continue;
    }

    const refund = (await refundMaibPayment(providerPayId, amount, reason)) as
      & Record<string, unknown>
      & { result?: { refundId?: unknown }; refundId?: unknown };
    const refundId = String(refund?.result?.refundId ?? refund?.refundId ?? '').trim() || null;
    const now = new Date().toISOString();

    const { error: updateError } = await table(client, 'reservation_changes')
      .update({ status: 'refunded', refunded_at: now, refund_payload: refund, updated_at: now })
      .eq('id', change.id)
      .is('refunded_at', null);

    if (updateError) throw new Error(updateError.message);

    results.push({ changeId: change.id, amount, refundId });
  }

  return results;
}

export type ChangeReconcileResult = {
  status: ChangePublicStatus;
  qrUrl?: string | null;
  expiresAt?: string | null;
  amount?: number | null;
  currency?: string;
  applied?: boolean;
  amountMismatch?: boolean;
};

// MIA difference: re-read the authoritative status from MAIB (never trust the
// caller), then apply once. Mirrors miaReconcile.reconcileMiaBookingGroup.
export async function reconcileMiaChange(
  client: SupabaseClient,
  changeId: string,
  source: string,
): Promise<ChangeReconcileResult> {
  const change = await findChangeById(client, changeId);
  if (!change || change.payment_rail !== 'mia') {
    return { status: 'not_found' };
  }

  const base = {
    qrUrl: change.checkout_url || null,
    expiresAt: change.expires_at ?? null,
    amount: change.difference_amount,
    currency: 'MDL',
  };

  if (change.status === 'paid' || change.applied_at) {
    return { status: 'paid', applied: false, ...base };
  }
  if (change.status === 'cancelled' || change.status === 'failed') {
    return { status: 'failed', ...base };
  }

  let miaPayment;
  try {
    miaPayment = await getMaibMiaPaymentByOrderId(changeId);
  } catch (error) {
    console.error('MIA change payment lookup failed', {
      changeId,
      message: error instanceof Error ? error.message : 'lookup failed',
    });
    return { status: storedChangeStatus(change), ...base };
  }

  const executed = miaPayment && normalizeMaibMiaPaymentStatus(miaPayment.raw) === 'paid';
  if (!miaPayment || !executed) {
    return { status: storedChangeStatus(change), ...base };
  }

  if (
    miaPayment.amount !== null &&
    Math.round(miaPayment.amount * 100) !== Math.round(change.difference_amount * 100)
  ) {
    console.error('MIA change paid amount mismatch — left pending for manual review', {
      changeId,
      captured: miaPayment.amount,
      expected: change.difference_amount,
    });
    return { status: 'pending', amountMismatch: true, ...base };
  }

  const now = new Date().toISOString();
  await markChangePaymentPaid(client, change.id, miaPayment.payId, { mia_payment: miaPayment.raw });
  const settlement = await settleChangePaid(client, change, now, source);
  return { status: 'paid', applied: settlement.applied, ...base };
}

// ── Card-callback helpers ────────────────────────────────────────────────────

export function findChangeByPayId(client: SupabaseClient, payId: string) {
  return changeBy(client, 'pay_id', payId);
}

export function findChangeById(client: SupabaseClient, id: string) {
  return changeBy(client, 'id', id);
}

export async function markChangeStatus(
  client: SupabaseClient,
  changeId: string,
  status: string,
  payload: Record<string, unknown>,
) {
  const { error } = await table(client, 'reservation_changes')
    .update({
      status,
      callback_payload: payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', changeId);

  if (error) throw new Error(error.message);
}

export async function markChangePaymentPaid(
  client: SupabaseClient,
  changeId: string,
  providerPaymentId: string,
  payload: Record<string, unknown>,
) {
  const { error } = await table(client, 'reservation_changes')
    .update({
      provider_payment_id: providerPaymentId || null,
      callback_payload: payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', changeId);

  if (error) throw new Error(error.message);
}

export function storedChangeStatus(change: ReservationChangeRow): ChangePublicStatus {
  if (change.status === 'paid' || change.status === 'refunded' || change.applied_at) {
    return 'paid';
  }
  if (change.status === 'failed' || change.status === 'cancelled') {
    return 'failed';
  }
  if (change.status === 'expired') {
    return 'expired';
  }
  if (change.expires_at && new Date(change.expires_at).getTime() <= Date.now()) {
    return 'expired';
  }
  return 'pending';
}

// ── Notification ─────────────────────────────────────────────────────────────

async function notifyBookingChange(
  client: SupabaseClient,
  change: ReservationChangeRow,
  source: string,
) {
  const { data, error } = await table<ChangeReservationRow[]>(client, 'reservations')
    .select(
      'id, guest_first_name, guest_last_name, guest_phone, guest_email, guest_language, check_in, check_out, rooms(number, type)',
    )
    .eq('booking_group_id', change.booking_group_id)
    .order('check_in', { ascending: true });

  if (error) throw new Error(error.message);
  const rows = data || [];
  const primary = rows[0];
  if (!primary) return;

  const lang = normalizeEmailLang(primary.guest_language);
  const roomCopy = aggregateRoomLabel(rows, lang);
  const newKids = change.new_kids_ages.length;
  const addedAdults = change.new_adults - change.prev_adults;
  const addedKids = change.new_kids_ages.length - change.prev_kids_ages.length;
  const siteUrl = getSiteUrl();
  const phone = String(primary.guest_phone || '');
  const emailTo = String(primary.guest_email || '');

  const confirmationUrl = await buildManageLink(client, siteUrl, primary.id, phone);

  const sms = bookingChangeSms({
    language: lang,
    newAdults: change.new_adults,
    newKids,
    difference: change.difference_amount,
  });
  const email = buildBookingChangeEmail({
    lang,
    firstName: titleCaseName(primary.guest_first_name || ''),
    roomCopy,
    checkIn: String(primary.check_in),
    checkOut: String(primary.check_out),
    newAdults: change.new_adults,
    newKids,
    addedAdults,
    addedKids,
    difference: change.difference_amount,
    siteUrl,
    confirmationUrl,
  });

  if (phone) {
    try {
      await sendSms({ to: phone, message: sms });
    } catch (smsError) {
      console.error('Reservation change SMS failed', { source, error: String(smsError) });
    }
  }
  if (emailTo) {
    try {
      await sendEmail({ to: emailTo, subject: email.subject, html: email.html, text: email.text });
    } catch (emailError) {
      console.error('Reservation change email failed', { source, error: String(emailError) });
    }
  }
}

// ── Small helpers ────────────────────────────────────────────────────────────

// Mint a fresh manage token so the email CTA opens the (now updated) booking.
// Best-effort: a token failure simply drops the CTA, the email still sends.
async function buildManageLink(
  client: SupabaseClient,
  siteUrl: string,
  reservationId: string,
  phone: string,
): Promise<string | undefined> {
  if (!phone) return undefined;
  try {
    const manageToken = await buildManageTokenRow(phone);
    const { error } = await table(client, 'reservation_manage_tokens').insert(manageToken.row);
    if (error) throw new Error(error.message);
    const params = new URLSearchParams({ id: reservationId, manage: manageToken.token });
    return `${siteUrl}/gestionare.html?${params.toString()}`;
  } catch (error) {
    console.error('Could not mint manage token for change email', error);
    return undefined;
  }
}

async function changeBy(
  client: SupabaseClient,
  column: string,
  value: string,
): Promise<ReservationChangeRow | null> {
  const { data, error } = await table<ReservationChangeRow>(client, 'reservation_changes')
    .select('*')
    .eq(column, value)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ?? null;
}

export function chisinauToday(now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const value = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = value('year');
    const month = value('month');
    const day = value('day');
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch (_error) {
    // No tz data: fall back to UTC.
  }
  return now.toISOString().slice(0, 10);
}

export function minutesFromNowIso(minutes: number, now = new Date()) {
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

function roomTypeOf(row: ChangeReservationRow): string {
  const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
  return String(room?.type || '');
}

function normalizeKidsAges(value: unknown): number[] {
  const ages = Array.isArray(value) ? value : [];
  return ages
    .map((age) => Math.trunc(Number(age)))
    .filter((age) => Number.isInteger(age) && age >= KID_AGE_MIN && age <= KID_AGE_MAX)
    .sort((left, right) => left - right);
}

// Every age in `subset` must appear in `superset` with at least the same
// multiplicity — i.e. the new party keeps all existing children unchanged.
function isSuperset(subset: number[], superset: number[]): boolean {
  const pool = superset.slice();
  for (const age of subset) {
    const index = pool.indexOf(age);
    if (index === -1) return false;
    pool.splice(index, 1);
  }
  return true;
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
