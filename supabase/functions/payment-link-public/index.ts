import { handleCors } from '../_shared/cors.ts';
import { getSiteUrl } from '../_shared/env.ts';
import { assertMethod, errorResponse, HttpError, jsonResponse, readJson } from '../_shared/http.ts';
import {
  createMaibCheckout,
  createMaibMiaQr,
  getMaibCallbackUrl,
  getMaibMiaCallbackUrl,
} from '../_shared/maib.ts';
import {
  cancelProviderAttempt,
  findPaymentLinkAttempt,
  findPaymentLinkAttemptForCallback,
  type PaymentLinkAttemptRow,
  type PaymentLinkRail,
  type PaymentLinkRow,
  reconcilePaymentLinkAttempt,
  shouldReconcilePaymentLinkAttempt,
} from '../_shared/paymentLinks.ts';
import { assertRateLimits, RATE_LIMITS, rateLimitIp } from '../_shared/rateLimit.ts';
import { createServiceClient } from '../_shared/supabaseAdmin.ts';
import type { SupabaseClient, SupabaseQueryResult } from '../_shared/supabaseAdmin.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_LINK_COLUMNS =
  'id, amount, currency, payment_rail, label, status, expires_at, paid_at, paid_amount, revoked_at, settled_attempt_id, refunded_at, refunded_amount, refund_note, manual_review, created_at, updated_at';
const ATTEMPT_COLUMNS =
  'id, payment_link_id, amount, currency, payment_rail, pay_id, provider_payment_id, status, checkout_url, provider_payload, expires_at, processed_at, manual_review, created_at, updated_at';
const MIA_SESSION_MINUTES = 15;
// Payment links do not hold inventory. Give card entry and 3-D Secure enough
// time while sessionExpiry still clamps the checkout to the link deadline.
export const CARD_SESSION_MINUTES = 30;
const CREATING_WAIT_ATTEMPTS = 20;
const CREATING_WAIT_MS = 250;

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  update(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  in(column: string, value: unknown[]): QueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

type RpcClient = SupabaseClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupabaseQueryResult<unknown>>;
};

type ClaimRow = {
  attempt_id: string;
  payment_link_id: string;
  amount: number | string;
  currency: string;
  payment_rail: PaymentLinkRail;
  pay_id?: string | null;
  provider_payment_id?: string | null;
  status: PaymentLinkAttemptRow['status'];
  checkout_url?: string | null;
  provider_payload?: Record<string, unknown> | null;
  expires_at?: string | null;
  processed_at?: string | null;
  manual_review: boolean;
  created_at: string;
  updated_at: string;
  superseded_pay_id?: string | null;
  superseded_payment_rail?: PaymentLinkRail | null;
};

export async function handler(request: Request) {
  const cors = handleCors(request);
  if (cors) return cors;

  try {
    assertMethod(request, ['POST']);
    const body = await readJson(request);
    const action = String(body?.action || '').trim();
    const client = createServiceClient();

    if (action === 'status') {
      return jsonResponse(await handleStatus(client, request, body), {}, request);
    }
    if (action === 'start') {
      return jsonResponse(await handleStart(client, request, body), {}, request);
    }

    throw new HttpError(400, 'Unknown payment-link action.');
  } catch (error) {
    return errorResponse(toHttpError(error), request);
  }
}

if (import.meta.main) Deno.serve(handler);

export async function handleStatus(
  client: SupabaseClient,
  request: Request,
  body: Record<string, unknown>,
) {
  const linkId = optionalUuid(body.linkId, 'linkId');
  const attemptId = optionalUuid(body.attemptId, 'attemptId');
  if (!linkId && !attemptId) {
    throw new HttpError(400, 'linkId or attemptId is required.');
  }

  const rateKey = linkId || attemptId;
  await assertRateLimits(client, [
    { rule: RATE_LIMITS.paymentLinkStatusIp, key: rateLimitIp(request) },
    { rule: RATE_LIMITS.paymentLinkStatusLink, key: rateKey },
  ]);

  let state = await loadPublicState(client, { linkId, attemptId });
  if (!state) return notFoundResponse();

  const attemptToReconcile = state.attempt;
  let forcePending = false;
  if (
    attemptToReconcile &&
    shouldReconcilePaymentLinkAttempt(attemptToReconcile, new Date())
  ) {
    const reconciliation = await reconcilePaymentLinkAttempt(
      client,
      attemptToReconcile,
      'payment-link-public-status',
    );
    forcePending = Boolean(reconciliation.lookupFailed || reconciliation.status === 'pending');
    state = await loadPublicState(client, {
      linkId: state.link.id,
      attemptId: attemptId || '',
    });
    if (!state) return notFoundResponse();
  }

  const resolvedStatus = publicStatus(state.link, state.attempt, new Date());
  const statusOverride = forcePending && !['paid', 'review'].includes(resolvedStatus)
    ? 'pending'
    : undefined;
  return statusResponse(state.link, state.attempt, statusOverride);
}

export async function handleStart(
  client: SupabaseClient,
  request: Request,
  body: Record<string, unknown>,
) {
  const linkId = requiredUuid(body.linkId, 'linkId');
  await assertRateLimits(client, [
    { rule: RATE_LIMITS.paymentLinkStartIp, key: rateLimitIp(request) },
    { rule: RATE_LIMITS.paymentLinkStartLink, key: linkId },
  ]);

  let state = await loadPublicState(client, { linkId, attemptId: '' });
  if (!state) throw new HttpError(404, 'Payment link not found.');

  const initialStatus = publicStatus(state.link, state.attempt, new Date());
  if (['paid', 'review', 'revoked', 'expired'].includes(initialStatus)) {
    let forcePending = false;
    if (
      state.attempt &&
      shouldReconcilePaymentLinkAttempt(state.attempt, new Date())
    ) {
      const reconciliation = await reconcilePaymentLinkAttempt(
        client,
        state.attempt,
        'payment-link-public-start',
      );
      forcePending = Boolean(reconciliation.lookupFailed || reconciliation.status === 'pending');
      state = await loadPublicState(client, { linkId, attemptId: state.attempt.id });
      if (!state) throw new HttpError(404, 'Payment link not found.');
    }
    return statusResponse(state.link, state.attempt, forcePending ? 'pending' : undefined);
  }

  const reusable = await resolveReusableAttempt(client, state.link, state.attempt);
  if (reusable) return startResponse(reusable);

  let claim: ClaimRow;
  try {
    claim = await claimAttempt(client, state.link);
  } catch (error) {
    if (isLiveAttemptConflict(error)) {
      const winner = await waitForReusableAttempt(client, state.link.id);
      if (winner) return startResponse(winner);
    }
    throw error;
  }

  if (claim.superseded_pay_id && claim.superseded_payment_rail) {
    await cancelProviderAttempt(
      claim.superseded_pay_id,
      claim.superseded_payment_rail,
      'superseded',
    );
    const superseded = await findPaymentLinkAttemptForCallback(client, {
      payId: claim.superseded_pay_id,
    });
    if (superseded) {
      await reconcilePaymentLinkAttempt(client, superseded, 'payment-link-public-superseded');
      state = await loadPublicState(client, { linkId, attemptId: '' });
      if (!state) throw new HttpError(404, 'Payment link not found.');
      const supersededStatus = publicStatus(state.link, state.attempt, new Date());
      if (['paid', 'review', 'revoked', 'expired'].includes(supersededStatus)) {
        return statusResponse(state.link, state.attempt);
      }
    }
  }

  const attempt = claimToAttempt(claim);
  let session: MintedSession;
  try {
    session = await mintSession(request, state.link, attempt);
  } catch (error) {
    await markAttemptFailed(client, attempt.id, error);
    throw error;
  }

  try {
    await persistSession(client, attempt.id, session);
  } catch (error) {
    await cancelProviderAttempt(session.payId, attempt.payment_rail, 'persistence_failed');
    await markAttemptFailed(client, attempt.id, error);
    throw error;
  }

  state = await loadPublicState(client, { linkId, attemptId: attempt.id });
  if (!state) {
    await cancelProviderAttempt(session.payId, attempt.payment_rail, 'link_missing_after_mint');
    throw new HttpError(404, 'Payment link not found.');
  }

  const terminalStatus = linkTerminalStatus(state.link, state.attempt, new Date());
  if (terminalStatus) {
    await cancelProviderAttempt(
      session.payId,
      attempt.payment_rail,
      `link_${terminalStatus}`,
    );
    if (state.attempt && state.attempt.status !== 'paid') {
      await reconcilePaymentLinkAttempt(client, state.attempt, 'payment-link-public-race');
      state = await loadPublicState(client, { linkId, attemptId: attempt.id });
      if (!state) throw new HttpError(404, 'Payment link not found.');
    }
    return statusResponse(state.link, state.attempt);
  }

  return startResponse({
    ...attempt,
    pay_id: session.payId,
    checkout_url: session.url,
    expires_at: session.expiresAt,
    status: 'pending',
  });
}

type PublicState = { link: PaymentLinkRow; attempt: PaymentLinkAttemptRow | null };

async function loadPublicState(
  client: SupabaseClient,
  identity: { linkId: string; attemptId: string },
): Promise<PublicState | null> {
  let attempt: PaymentLinkAttemptRow | null = null;
  let linkId = identity.linkId;

  if (identity.attemptId) {
    attempt = await findPaymentLinkAttempt(client, identity.attemptId);
    if (!attempt) return null;
    linkId = attempt.payment_link_id;
    if (identity.linkId && identity.linkId !== linkId) return null;
  }

  const { data: link, error } = await table<PaymentLinkRow>(client, 'payment_links')
    .select(PAYMENT_LINK_COLUMNS)
    .eq('id', linkId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!link) return null;

  if (!attempt) {
    attempt = await latestAttempt(client, link.id);
  }
  return { link, attempt };
}

async function latestAttempt(client: SupabaseClient, linkId: string) {
  const { data, error } = await table<PaymentLinkAttemptRow>(client, 'payment_link_attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('payment_link_id', linkId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function liveAttempt(client: SupabaseClient, linkId: string) {
  const { data, error } = await table<PaymentLinkAttemptRow>(client, 'payment_link_attempts')
    .select(ATTEMPT_COLUMNS)
    .eq('payment_link_id', linkId)
    .in('status', ['creating', 'pending'])
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function resolveReusableAttempt(
  client: SupabaseClient,
  link: PaymentLinkRow,
  initial: PaymentLinkAttemptRow | null,
) {
  const live = initial && ['creating', 'pending'].includes(initial.status)
    ? initial
    : await liveAttempt(client, link.id);
  if (!live || !isAttemptValid(live, new Date())) return null;
  if (live.status === 'pending' && live.pay_id && live.checkout_url) return live;
  if (live.status === 'creating') return await waitForReusableAttempt(client, link.id);
  return null;
}

export async function waitForReusableAttempt(
  client: SupabaseClient,
  linkId: string,
  wait: (milliseconds: number) => Promise<void> = delay,
) {
  for (let index = 0; index < CREATING_WAIT_ATTEMPTS; index += 1) {
    const attempt = await liveAttempt(client, linkId);
    if (!attempt) return null;
    if (attempt.status === 'pending' && isAttemptValid(attempt, new Date())) {
      if (attempt.pay_id && attempt.checkout_url) return attempt;
      return null;
    }
    if (attempt.status !== 'creating') return null;
    await wait(CREATING_WAIT_MS);
  }
  throw new HttpError(409, 'Payment initialization is still in progress. Please retry.');
}

async function claimAttempt(client: SupabaseClient, link: PaymentLinkRow): Promise<ClaimRow> {
  const { data, error } = await (client as RpcClient).rpc('claim_payment_link_attempt', {
    p_link_id: link.id,
    p_rail: link.payment_rail,
    p_now: new Date().toISOString(),
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : null;
  if (!isClaimRow(row)) {
    throw new Error('Payment-link claim did not return an attempt.');
  }
  return row;
}

type MintedSession = {
  payId: string;
  url: string;
  expiresAt: string;
  providerPayload: Record<string, unknown>;
};

async function mintSession(
  request: Request,
  link: PaymentLinkRow,
  attempt: PaymentLinkAttemptRow,
): Promise<MintedSession> {
  const description = String(link.label || '').trim() || 'Plată EcoVila';
  const siteUrl = getSiteUrl();
  const returnUrl = `${siteUrl}/plata.html?p=${link.id}`;

  if (attempt.payment_rail === 'mia') {
    const expiresAt = sessionExpiry(link, MIA_SESSION_MINUTES);
    const qr = await createMaibMiaQr({
      amount: Number(attempt.amount),
      orderId: attempt.id,
      description,
      callbackUrl: getMaibMiaCallbackUrl(),
      expiresAt,
    });
    return {
      payId: qr.qrId,
      url: qr.url,
      expiresAt,
      providerPayload: {
        qr: { qrId: qr.qrId, orderId: attempt.id, expiresAt: qr.expiresAt },
      },
    };
  }

  const expiresAt = sessionExpiry(link, CARD_SESSION_MINUTES);
  const checkout = await createMaibCheckout({
    amount: Number(attempt.amount),
    orderId: attempt.id,
    itemExternalId: 'ecovila-payment-link',
    description,
    guestEmail: '',
    guestName: '',
    guestPhone: '',
    language: 'ro',
    createdAt: new Date().toISOString(),
    callbackUrl: getMaibCallbackUrl(),
    successUrl: returnUrl,
    failUrl: returnUrl,
    ip: rateLimitIp(request),
    userAgent: request.headers.get('user-agent') || '',
  });
  return {
    payId: checkout.payId,
    url: checkout.payUrl,
    expiresAt,
    providerPayload: {
      checkout: { checkoutId: checkout.payId, orderId: attempt.id },
    },
  };
}

async function persistSession(
  client: SupabaseClient,
  attemptId: string,
  session: MintedSession,
) {
  const { error } = await table(client, 'payment_link_attempts')
    .update({
      pay_id: session.payId,
      checkout_url: session.url,
      status: 'pending',
      provider_payload: session.providerPayload,
      expires_at: session.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', attemptId)
    .eq('status', 'creating');
  if (error) throw new Error(error.message);
}

async function markAttemptFailed(client: SupabaseClient, attemptId: string, cause: unknown) {
  const now = new Date().toISOString();
  const { error } = await table(client, 'payment_link_attempts')
    .update({
      status: 'failed',
      provider_payload: {
        creationError: cause instanceof Error ? cause.message.slice(0, 300) : 'creation failed',
      },
      processed_at: now,
      updated_at: now,
    })
    .eq('id', attemptId)
    .eq('status', 'creating');
  if (error) {
    console.error('Could not mark payment-link attempt failed', {
      attemptId,
      message: error.message,
    });
  }
}

function statusResponse(
  link: PaymentLinkRow,
  attempt: PaymentLinkAttemptRow | null,
  statusOverride?: string,
) {
  const now = new Date();
  return {
    ok: true,
    status: statusOverride || publicStatus(link, attempt, now),
    amount: Number(link.amount),
    currency: link.currency,
    paymentRail: link.payment_rail,
    label: String(link.label || '').trim() || 'Plată EcoVila',
    expiresAt: link.expires_at ?? null,
    attempt: attempt
      ? {
        id: attempt.id,
        status: attempt.status,
        checkoutUrl: isAttemptValid(attempt, now) ? attempt.checkout_url ?? null : null,
        expiresAt: attempt.expires_at ?? null,
      }
      : null,
  };
}

function notFoundResponse() {
  return {
    ok: true,
    status: 'not_found',
    amount: null,
    currency: 'MDL',
    paymentRail: null,
    label: null,
    expiresAt: null,
    attempt: null,
  };
}

function startResponse(attempt: PaymentLinkAttemptRow) {
  const base = {
    ok: true,
    attemptId: attempt.id,
    paymentRail: attempt.payment_rail,
    expiresAt: attempt.expires_at ?? null,
  };
  if (attempt.payment_rail === 'mia') {
    return {
      ...base,
      qrUrl: String(attempt.checkout_url || ''),
      qrId: String(attempt.pay_id || ''),
    };
  }
  return { ...base, payUrl: String(attempt.checkout_url || '') };
}

export function publicStatus(
  link: PaymentLinkRow,
  attempt: PaymentLinkAttemptRow | null,
  now: Date,
) {
  if (link.manual_review || attempt?.manual_review) return 'review';
  if (link.status === 'paid') return 'paid';
  if (attempt && isAttemptInFlight(attempt, now)) return 'pending';
  if (link.status === 'revoked') return 'revoked';
  if (link.expires_at && new Date(link.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function isAttemptInFlight(attempt: PaymentLinkAttemptRow, now: Date) {
  return attempt.status === 'pending' ||
    (attempt.status === 'creating' && isAttemptValid(attempt, now));
}

function linkTerminalStatus(
  link: PaymentLinkRow,
  attempt: PaymentLinkAttemptRow | null,
  now: Date,
) {
  if (link.manual_review || attempt?.manual_review) return 'review';
  if (link.status === 'paid') return 'paid';
  if (link.status === 'revoked') return 'revoked';
  if (link.expires_at && new Date(link.expires_at).getTime() <= now.getTime()) return 'expired';
  return '';
}

function isAttemptValid(attempt: PaymentLinkAttemptRow, now: Date) {
  if (attempt.status === 'creating') {
    return new Date(attempt.created_at).getTime() > now.getTime() - 2 * 60 * 1000;
  }
  return attempt.status === 'pending' &&
    (!attempt.expires_at || new Date(attempt.expires_at).getTime() > now.getTime());
}

function sessionExpiry(link: PaymentLinkRow, minutes: number) {
  const providerDeadline = Date.now() + minutes * 60 * 1000;
  const linkDeadline = link.expires_at ? new Date(link.expires_at).getTime() : Infinity;
  return new Date(Math.min(providerDeadline, linkDeadline)).toISOString();
}

function claimToAttempt(row: ClaimRow): PaymentLinkAttemptRow {
  return {
    id: row.attempt_id,
    payment_link_id: row.payment_link_id,
    amount: row.amount,
    currency: row.currency,
    payment_rail: row.payment_rail,
    pay_id: row.pay_id,
    provider_payment_id: row.provider_payment_id,
    status: row.status,
    checkout_url: row.checkout_url,
    provider_payload: row.provider_payload,
    expires_at: row.expires_at,
    processed_at: row.processed_at,
    manual_review: row.manual_review,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isClaimRow(value: unknown): value is ClaimRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Boolean(row.attempt_id && row.payment_link_id && row.payment_rail);
}

function requiredUuid(value: unknown, field: string) {
  const id = String(value || '').trim();
  if (!UUID_PATTERN.test(id)) {
    throw new HttpError(400, `${field} must be a valid UUID.`);
  }
  return id;
}

function optionalUuid(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return '';
  return requiredUuid(value, field);
}

function isLiveAttemptConflict(error: unknown) {
  return isQueryError(error) && error.code === 'P0001' &&
    String(error.message || '').includes('live payment-link attempt');
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

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
