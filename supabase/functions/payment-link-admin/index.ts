import { handleCors } from '../_shared/cors.ts';
import { getSiteUrl } from '../_shared/env.ts';
import {
  assertMethod,
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
  requireStaffRole,
} from '../_shared/http.ts';
import type {
  PaymentLinkAttemptRow,
  PaymentLinkRail,
  PaymentLinkRow,
} from '../_shared/paymentLinks.ts';
import {
  cancelProviderAttempt,
  findPaymentLinkAttemptForCallback,
  reconcilePaymentLinkAttempt,
  shouldReconcilePaymentLinkAttempt,
} from '../_shared/paymentLinks.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_LINK_COLUMNS =
  'id, amount, currency, payment_rail, label, purpose, reservation_id, booking_group_id, room_type, status, expires_at, paid_at, paid_amount, revoked_at, settled_attempt_id, refunded_at, refunded_amount, refund_note, manual_review, created_at, updated_at';
const ATTEMPT_COLUMNS =
  'id, payment_link_id, amount, currency, payment_rail, pay_id, provider_payment_id, status, checkout_url, provider_payload, expires_at, processed_at, manual_review, created_at, updated_at';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  lt(column: string, value: unknown): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  single(): Promise<SupabaseQueryResult<T>>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RpcClient = SupabaseClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupabaseQueryResult<unknown>>;
};

type RevokeResult = { pay_id?: string | null; payment_rail?: PaymentLinkRail | null };

export async function handler(request: Request) {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    await requireStaffRole(request, ['diana']);
    const body = await readJson(request);
    const action = String(body?.action || '').trim();
    const client = createServiceClient();

    if (action === 'create') {
      return jsonResponse(await createLink(client, body), {}, request);
    }
    if (action === 'list') {
      return jsonResponse(await listLinks(client, body), {}, request);
    }
    if (action === 'revoke') {
      return jsonResponse(await revokeLink(client, body), {}, request);
    }
    if (action === 'markRefunded') {
      return jsonResponse(await markRefunded(client, body), {}, request);
    }

    throw new HttpError(400, 'Unknown payment-link action.');
  } catch (error) {
    return errorResponse(toHttpError(error), request);
  }
}

if (import.meta.main) Deno.serve(handler);

async function createLink(client: SupabaseClient, body: Record<string, unknown>) {
  const amount = requiredAmount(body.amount, 'amount');
  const paymentRail = requiredRail(body.paymentRail);
  const expiresInHours = normalizeExpiry(body.expiresInHours);
  const label = normalizeLabel(body.label);
  const now = new Date();
  const expiresAt = expiresInHours === null
    ? null
    : new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await table<PaymentLinkRow>(client, 'payment_links')
    .insert({
      amount,
      currency: 'MDL',
      payment_rail: paymentRail,
      label,
      expires_at: expiresAt,
    })
    .select(PAYMENT_LINK_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Payment link could not be created.');
  }

  return { ok: true, link: toPublicLink(data, null, now) };
}

export async function listLinks(client: SupabaseClient, body: Record<string, unknown>) {
  const limit = normalizeLimit(body.limit);
  const before = normalizeBefore(body.before);
  let query = table<PaymentLinkRow[]>(client, 'payment_links')
    .select(PAYMENT_LINK_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit + 1);

  if (before) {
    query = query.lt('created_at', before);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const fetched = data || [];
  const rows = fetched.slice(0, limit);
  const attempts = await latestAttempts(client, rows.map((row) => row.id));
  const now = new Date();
  const pendingOverrides = new Set<string>();

  await Promise.all(rows.map(async (row, index) => {
    const attempt = attempts.get(row.id) || null;
    if (!attempt || !shouldReconcilePaymentLinkAttempt(attempt, now)) return;

    const reconciliation = await reconcilePaymentLinkAttempt(
      client,
      attempt,
      'payment-link-admin-list',
    );
    if (reconciliation.lookupFailed || reconciliation.status === 'pending') {
      pendingOverrides.add(row.id);
    }
    if (reconciliation.status === 'paid' || reconciliation.status === 'review') {
      const refreshed = await loadLink(client, row.id);
      rows[index] = refreshed.link;
      if (refreshed.attempt) attempts.set(row.id, refreshed.attempt);
      else attempts.delete(row.id);
    } else if (reconciliation.attempt) {
      attempts.set(row.id, reconciliation.attempt);
    }
  }));

  return {
    ok: true,
    links: rows.map((row) =>
      toPublicLink(
        row,
        attempts.get(row.id) || null,
        now,
        pendingOverrides.has(row.id) ? 'pending' : undefined,
      )
    ),
    nextBefore: fetched.length > limit ? rows.at(-1)?.created_at ?? null : null,
  };
}

export async function revokeLink(client: SupabaseClient, body: Record<string, unknown>) {
  const id = requiredUuid(body.id, 'id');
  const now = new Date().toISOString();
  const { data, error } = await (client as RpcClient).rpc('revoke_payment_link', {
    p_link_id: id,
    p_now: now,
  });
  if (error) throw error;

  const cancelled = Array.isArray(data) ? data[0] as RevokeResult | undefined : undefined;
  let forcePending = false;
  if (cancelled?.pay_id && cancelled.payment_rail) {
    await cancelProviderAttempt(cancelled.pay_id, cancelled.payment_rail, 'revoked');
    const attempt = await findPaymentLinkAttemptForCallback(client, {
      payId: cancelled.pay_id,
    });
    if (attempt) {
      const reconciliation = await reconcilePaymentLinkAttempt(
        client,
        attempt,
        'payment-link-admin-revoke',
      );
      forcePending = Boolean(reconciliation.lookupFailed || reconciliation.status === 'pending');
    }
  }

  const { link, attempt } = await loadLink(client, id);
  return {
    ok: true,
    link: toPublicLink(link, attempt, new Date(), forcePending ? 'pending' : undefined),
  };
}

export async function markRefunded(client: SupabaseClient, body: Record<string, unknown>) {
  const id = requiredUuid(body.id, 'id');
  const amount = requiredAmount(body.amount, 'amount');
  const note = body.note === undefined || body.note === null
    ? null
    : String(body.note).trim() || null;
  const { error } = await (client as RpcClient).rpc('mark_payment_link_refunded', {
    p_link_id: id,
    p_amount: amount,
    p_note: note,
    p_now: new Date().toISOString(),
  });
  if (error) throw error;

  const { link, attempt } = await loadLink(client, id);
  return { ok: true, link: toPublicLink(link, attempt, new Date()) };
}

async function loadLink(client: SupabaseClient, id: string) {
  const { data: link, error } = await table<PaymentLinkRow>(client, 'payment_links')
    .select(PAYMENT_LINK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!link) throw new HttpError(404, 'Payment link not found.');

  const attempts = await latestAttempts(client, [id]);
  return { link, attempt: attempts.get(id) || null };
}

async function latestAttempts(client: SupabaseClient, linkIds: string[]) {
  const result = new Map<string, PaymentLinkAttemptRow>();
  if (!linkIds.length) return result;

  const { data, error } = await table<PaymentLinkAttemptRow[]>(client, 'payment_link_attempts')
    .select(ATTEMPT_COLUMNS)
    .in('payment_link_id', linkIds)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  for (const attempt of data || []) {
    if (!result.has(attempt.payment_link_id)) {
      result.set(attempt.payment_link_id, attempt);
    }
  }
  return result;
}

function toPublicLink(
  row: PaymentLinkRow,
  lastAttempt: PaymentLinkAttemptRow | null,
  now: Date,
  effectiveStatusOverride?: string,
) {
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    paymentRail: row.payment_rail,
    label: row.label ?? null,
    purpose: row.purpose,
    reservationId: row.reservation_id,
    bookingGroupId: row.booking_group_id,
    roomType: row.room_type,
    status: row.status,
    effectiveStatus: effectiveStatusOverride || effectiveStatus(row, lastAttempt, now),
    expiresAt: row.expires_at ?? null,
    paidAt: row.paid_at ?? null,
    paidAmount: numberOrNull(row.paid_amount),
    revokedAt: row.revoked_at ?? null,
    refundedAt: row.refunded_at ?? null,
    refundedAmount: numberOrNull(row.refunded_amount),
    refundNote: row.refund_note ?? null,
    manualReview: Boolean(row.manual_review),
    createdAt: row.created_at,
    payUrl: `${getSiteUrl()}/plata.html?p=${row.id}`,
    lastAttempt: lastAttempt
      ? {
        id: lastAttempt.id,
        status: lastAttempt.status,
        payId: lastAttempt.pay_id ?? null,
        providerPaymentId: lastAttempt.provider_payment_id ?? null,
        createdAt: lastAttempt.created_at,
      }
      : null,
  };
}

export function effectiveStatus(
  link: PaymentLinkRow,
  attempt: PaymentLinkAttemptRow | null,
  now: Date,
) {
  if (link.manual_review || attempt?.manual_review) return 'review';
  if (link.status === 'paid') return 'paid';
  if (attempt && isLiveAttempt(attempt, now)) return 'pending';
  if (link.status === 'revoked') return 'revoked';
  if (link.expires_at && new Date(link.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function isLiveAttempt(attempt: PaymentLinkAttemptRow, now: Date) {
  if (attempt.status === 'creating') {
    return new Date(attempt.created_at).getTime() > now.getTime() - 2 * 60 * 1000;
  }
  return attempt.status === 'pending';
}

function requiredAmount(value: unknown, field: string) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
    throw new HttpError(400, `${field} must be an integer between 1 and 1000000.`);
  }
  return amount;
}

function requiredRail(value: unknown): PaymentLinkRail {
  const rail = String(value || '').trim().toLowerCase();
  if (rail !== 'mia' && rail !== 'card') {
    throw new HttpError(400, 'paymentRail must be mia or card.');
  }
  return rail;
}

function normalizeExpiry(value: unknown): null | 1 | 3 | 8 {
  if (value === undefined || value === null || value === '') return null;
  const hours = Number(value);
  if (hours !== 1 && hours !== 3 && hours !== 8) {
    throw new HttpError(400, 'expiresInHours must be null, 1, 3, or 8.');
  }
  return hours;
}

function normalizeLabel(value: unknown) {
  if (value === undefined || value === null) return null;
  const label = String(value).trim();
  if (!label) return null;
  if (Array.from(label).length > 120) {
    throw new HttpError(400, 'label must be at most 120 characters.');
  }
  return label;
}

function normalizeLimit(value: unknown) {
  if (value === undefined || value === null || value === '') return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'limit must be an integer between 1 and 100.');
  }
  return limit;
}

function normalizeBefore(value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  const before = String(value).trim();
  const time = new Date(before).getTime();
  if (!before || !Number.isFinite(time)) {
    throw new HttpError(400, 'before must be a valid timestamp.');
  }
  return new Date(time).toISOString();
}

function requiredUuid(value: unknown, field: string) {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) {
    throw new HttpError(400, `${field} must be a valid UUID.`);
  }
  return id;
}

function numberOrNull(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toHttpError(error: unknown) {
  if (error instanceof HttpError) return error;
  if (isQueryError(error)) {
    if (error.code === 'P0002') {
      return new HttpError(404, error.message || 'Payment link not found.');
    }
    if (error.code === 'P0001') {
      return new HttpError(409, error.message || 'Payment link conflict.');
    }
  }
  return error;
}

function isQueryError(error: unknown): error is { code?: string; message?: string } {
  return Boolean(error && typeof error === 'object');
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
