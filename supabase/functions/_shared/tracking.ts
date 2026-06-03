import { optionalEnv } from './env.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

type QueryBuilder<T = unknown> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  insert(payload: unknown): QueryBuilder<T>;
  eq(column: string, value: unknown): QueryBuilder<T>;
  maybeSingle(): Promise<SupabaseQueryResult<T | null>>;
};

export type TrackingUserInput = {
  email?: string | null;
  phone?: string | null;
};

export type HashedUserData = {
  emailHash?: string;
  phoneHash?: string;
};

export type TrackingReservation = {
  id: string;
  booking_group_id?: string | null;
  guest_email?: string | null;
  guest_phone?: string | null;
  total_price?: number | string | null;
  tracking_event_id?: string | null;
  tracking_fbp?: string | null;
  tracking_fbc?: string | null;
  tracking_user_agent?: string | null;
  tracking_source_url?: string | null;
};

type DispatchInput = {
  eventName: string;
  eventId: string;
  eventSourceUrl?: string;
  value?: number | null;
  currency?: string;
  fbp?: string | null;
  fbc?: string | null;
  userAgent?: string | null;
  userData?: HashedUserData;
  now?: Date;
};

type TrackingEventRow = {
  id?: string;
};

const DEFAULT_META_API_VERSION = 'v21.0';
const DEFAULT_GOOGLE_ADS_API_VERSION = 'v21';

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeEmail(value: unknown) {
  return String(value || '').trim().toLowerCase();
}

export function normalizePhone(value: unknown) {
  return String(value || '').replace(/\D/g, '');
}

export async function hashUserData(input: TrackingUserInput): Promise<HashedUserData> {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const data: HashedUserData = {};

  if (email) {
    data.emailHash = await sha256Hex(email);
  }

  if (phone) {
    data.phoneHash = await sha256Hex(phone);
  }

  return data;
}

export function buildMetaConversionEvent(input: DispatchInput) {
  const userData: Record<string, unknown> = {};

  if (input.userData?.emailHash) {
    userData.em = [input.userData.emailHash];
  }
  if (input.userData?.phoneHash) {
    userData.ph = [input.userData.phoneHash];
  }
  if (input.fbp) {
    userData.fbp = input.fbp;
  }
  if (input.fbc) {
    userData.fbc = input.fbc;
  }
  if (input.userAgent) {
    userData.client_user_agent = input.userAgent;
  }

  const customData: Record<string, unknown> = {
    currency: input.currency || 'MDL',
  };
  if (Number.isFinite(Number(input.value))) {
    customData.value = Number(input.value);
  }

  return {
    data: [
      {
        event_name: input.eventName,
        event_time: Math.floor((input.now || new Date()).getTime() / 1000),
        event_id: input.eventId,
        event_source_url: input.eventSourceUrl || 'https://ecovila.md/',
        action_source: 'website',
        user_data: userData,
        custom_data: customData,
      },
    ],
  };
}

export function buildGoogleClickConversion(input: {
  customerId: string;
  conversionActionId: string;
  eventId: string;
  conversionDateTime: string;
  value: number;
  currency: string;
  userData?: HashedUserData;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
}) {
  const userIdentifiers = [];

  if (input.userData?.emailHash) {
    userIdentifiers.push({ hashedEmail: input.userData.emailHash });
  }
  if (input.userData?.phoneHash) {
    userIdentifiers.push({ hashedPhoneNumber: input.userData.phoneHash });
  }

  return {
    conversions: [
      {
        conversionAction:
          `customers/${input.customerId}/conversionActions/${input.conversionActionId}`,
        conversionDateTime: input.conversionDateTime,
        conversionValue: input.value,
        currencyCode: input.currency,
        orderId: input.eventId,
        userIdentifiers,
        ...(input.gclid ? { gclid: input.gclid } : {}),
        ...(input.gbraid ? { gbraid: input.gbraid } : {}),
        ...(input.wbraid ? { wbraid: input.wbraid } : {}),
      },
    ],
    partialFailure: true,
    validateOnly: false,
  };
}

export async function dispatchTrackingEvent(input: DispatchInput, fetchImpl: typeof fetch = fetch) {
  const [meta, google] = await Promise.all([
    sendMetaConversion(input, fetchImpl),
    input.eventName === 'Purchase'
      ? sendGoogleAdsConversion(input, fetchImpl)
      : Promise.resolve({ skipped: true }),
  ]);

  return { meta, google };
}

export async function dispatchPurchaseTrackingOnce(
  client: SupabaseClient,
  reservations: TrackingReservation[],
  options: { source?: string; now?: Date; fetchImpl?: typeof fetch } = {},
) {
  const rows = Array.isArray(reservations) ? reservations : [];

  if (!rows.length) {
    return { sent: false, skipped: true, reason: 'no-reservations' };
  }

  const primary = rows[0];
  const eventId = String(primary.tracking_event_id || primary.booking_group_id || primary.id || '')
    .trim();

  if (!eventId) {
    return { sent: false, skipped: true, reason: 'missing-event-id' };
  }

  const reserved = await reserveTrackingEvent(client, {
    eventName: 'Purchase',
    eventId,
    bookingGroupId: primary.booking_group_id || null,
    source: options.source || 'payment-confirmation',
  });

  if (!reserved) {
    return { sent: false, skipped_duplicate: true };
  }

  const value = rows.reduce((sum, row) => sum + Number(row.total_price || 0), 0);
  const userData = await hashUserData({
    email: primary.guest_email,
    phone: primary.guest_phone,
  });
  const result = await dispatchTrackingEvent(
    {
      eventName: 'Purchase',
      eventId,
      value,
      currency: 'MDL',
      eventSourceUrl: primary.tracking_source_url || 'https://ecovila.md/confirmare.html',
      fbp: primary.tracking_fbp || undefined,
      fbc: primary.tracking_fbc || undefined,
      userAgent: primary.tracking_user_agent || undefined,
      userData,
      now: options.now,
    },
    options.fetchImpl || fetch,
  );

  return {
    sent: true,
    eventId,
    value,
    currency: 'MDL',
    result,
  };
}

async function reserveTrackingEvent(
  client: SupabaseClient,
  input: { eventName: string; eventId: string; bookingGroupId?: string | null; source: string },
) {
  const { error } = await table<TrackingEventRow>(client, 'tracking_events')
    .insert({
      event_name: input.eventName,
      event_id: input.eventId,
      booking_group_id: input.bookingGroupId || null,
      source: input.source,
      provider_results: {},
    })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') {
    return false;
  }

  if (error) {
    throw new Error(error.message);
  }

  return true;
}

async function sendMetaConversion(input: DispatchInput, fetchImpl: typeof fetch) {
  const pixelId = optionalEnv('META_PIXEL_ID');
  const token = optionalEnv('META_CAPI_ACCESS_TOKEN');

  if (!pixelId || !token) {
    return { skipped: true, provider: 'meta' };
  }

  const apiVersion = optionalEnv('META_GRAPH_API_VERSION') || DEFAULT_META_API_VERSION;
  const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(pixelId)}/events`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...buildMetaConversionEvent(input),
      access_token: token,
    }),
  });

  return providerResult('meta', response);
}

async function sendGoogleAdsConversion(input: DispatchInput, fetchImpl: typeof fetch) {
  const developerToken = optionalEnv('GOOGLE_ADS_DEVELOPER_TOKEN');
  const accessToken = optionalEnv('GOOGLE_ADS_ACCESS_TOKEN');
  const customerId = normalizeGoogleCustomerId(optionalEnv('GOOGLE_ADS_CUSTOMER_ID'));
  const conversionActionId = normalizeGoogleCustomerId(
    optionalEnv('GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID'),
  );

  if (!developerToken || !accessToken || !customerId || !conversionActionId) {
    return { skipped: true, provider: 'google_ads' };
  }

  const apiVersion = optionalEnv('GOOGLE_ADS_API_VERSION') || DEFAULT_GOOGLE_ADS_API_VERSION;
  const url =
    `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}:uploadClickConversions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
  };
  const loginCustomerId = normalizeGoogleCustomerId(optionalEnv('GOOGLE_ADS_LOGIN_CUSTOMER_ID'));
  if (loginCustomerId) {
    headers['login-customer-id'] = loginCustomerId;
  }

  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      buildGoogleClickConversion({
        customerId,
        conversionActionId,
        eventId: input.eventId,
        conversionDateTime: formatGoogleConversionDate(input.now || new Date()),
        value: Number(input.value || 0),
        currency: input.currency || 'MDL',
        userData: input.userData,
      }),
    ),
  });

  return providerResult('google_ads', response);
}

async function providerResult(provider: string, response: Response) {
  const body = await response.text();

  return {
    provider,
    ok: response.ok,
    status: response.status,
    body: body.slice(0, 1000),
  };
}

function normalizeGoogleCustomerId(value: unknown) {
  return String(value || '').replace(/\D/g, '');
}

function formatGoogleConversionDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);

  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`,
  ].join(' ');
}

function table<T = unknown>(client: SupabaseClient, name: string) {
  return client.from(name) as QueryBuilder<T>;
}
