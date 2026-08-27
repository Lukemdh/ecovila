import { assert, assertEquals, assertRejects } from 'std/assert';
import {
  alertUnrefundedAccommodationDifferences,
  findUnrefundedAccommodationDifferences,
  type PaymentLinkRow,
  sumUnrefundedDifferenceAmount,
} from '../_shared/paymentLinks.ts';
import { buildCancellationEmail, cancellationConfirmationSms } from '../_shared/notifications.ts';
import { handleCancelReservation } from '../reservation-cancel/index.ts';
import type { SupabaseClient } from '../_shared/supabaseAdmin.ts';

Deno.env.set('ECOVILA_CRON_SECRET', 'test-cron-secret-for-cancellation');
Deno.env.set('ECOVILA_SITE_URL', 'https://ecovila.md');
Deno.env.set('SMSMD_API_TOKEN', 'test-sms-token');
Deno.env.set('SMSMD_FROM', 'EcoVila');
Deno.env.set('RESEND_API_KEY', 'test-resend-key');
Deno.env.set('RESEND_FROM_EMAIL', 'test@ecovila.md');

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  '^{}\\[~]|€';

function nonGsm7(message: string) {
  return [...message].filter((character) => !GSM7.includes(character));
}

function sampleDifferenceLink(overrides: Partial<PaymentLinkRow> = {}): PaymentLinkRow {
  return {
    id: 'link-diff-1',
    amount: 500,
    currency: 'MDL',
    payment_rail: 'card',
    label: 'Diferență Căsuța #3',
    purpose: 'accommodation_difference',
    reservation_id: 'res-1',
    booking_group_id: 'grp-1',
    room_type: 'large',
    status: 'paid',
    expires_at: null,
    paid_at: '2026-08-20T10:00:00.000Z',
    paid_amount: 500,
    revoked_at: null,
    settled_attempt_id: 'att-1',
    refunded_at: null,
    refunded_amount: null,
    refund_note: null,
    manual_review: false,
    created_at: '2026-08-20T09:00:00.000Z',
    updated_at: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// 1. Difference link lookup, summation, and scoping
// -----------------------------------------------------------------------------

Deno.test('findUnrefundedAccommodationDifferences matches paid bound links with an outstanding balance', async () => {
  const links: PaymentLinkRow[] = [
    sampleDifferenceLink({ id: 'valid-diff-1', reservation_id: 'res-1', paid_amount: 400 }),
    sampleDifferenceLink({
      id: 'diff-other-res',
      reservation_id: 'res-surviving',
      paid_amount: 600,
    }),
    sampleDifferenceLink({
      id: 'diff-standalone',
      purpose: 'standalone',
      reservation_id: null,
      paid_amount: 300,
    }),
    sampleDifferenceLink({
      id: 'diff-active-unpaid',
      reservation_id: 'res-1',
      status: 'active',
      paid_amount: null,
    }),
    sampleDifferenceLink({
      id: 'diff-revoked',
      reservation_id: 'res-1',
      status: 'revoked',
      paid_amount: null,
    }),
    sampleDifferenceLink({
      id: 'diff-partially-refunded',
      reservation_id: 'res-1',
      paid_amount: 1000,
      refunded_at: '2026-08-21T12:00:00.000Z',
      refunded_amount: 400,
    }),
    sampleDifferenceLink({
      id: 'diff-fully-refunded-amount',
      reservation_id: 'res-1',
      refunded_at: '2026-08-21T12:00:00.000Z',
      paid_amount: 300,
      refunded_amount: 300,
    }),
  ];

  const client = {
    from(tableName: string) {
      assertEquals(tableName, 'payment_links');
      const filters: Array<(row: PaymentLinkRow) => boolean> = [];
      const chain = {
        select() {
          return chain;
        },
        eq(column: string, value: unknown) {
          filters.push((r) => (r as unknown as Record<string, unknown>)[column] === value);
          return chain;
        },
        in(column: string, values: unknown[]) {
          filters.push((r) => values.includes((r as unknown as Record<string, unknown>)[column]));
          return chain;
        },
        is(column: string, value: unknown) {
          filters.push((r) => (r as unknown as Record<string, unknown>)[column] === value);
          return chain;
        },
        then(resolve: (val: unknown) => unknown) {
          const matched = links.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: matched, error: null }).then(resolve);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;

  // Query scoped to cancelled reservation 'res-1'
  const matched = await findUnrefundedAccommodationDifferences(client, ['res-1']);
  assertEquals(matched.length, 2);
  assertEquals(matched[0].id, 'valid-diff-1');
  assertEquals(matched[1].id, 'diff-partially-refunded');

  // Sum correctly calculates unrefunded balance
  const sum = sumUnrefundedDifferenceAmount(matched);
  assertEquals(sum, 1000);

  // Partial refund reduces the sum
  const partiallyRefunded = [sampleDifferenceLink({ paid_amount: 500, refunded_amount: 150 })];
  assertEquals(sumUnrefundedDifferenceAmount(partiallyRefunded), 350);
});

Deno.test('findUnrefundedAccommodationDifferences scopes strictly by reservation_id and excludes surviving villas', async () => {
  const links: PaymentLinkRow[] = [
    sampleDifferenceLink({
      id: 'link-surviving',
      reservation_id: 'res-villa-2',
      booking_group_id: 'grp-1',
      paid_amount: 700,
    }),
  ];

  const client = {
    from() {
      const filters: Array<(row: PaymentLinkRow) => boolean> = [];
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
          return chain;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
          return chain;
        },
        then(resolve: (val: unknown) => unknown) {
          const data = links.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;

  // When only res-villa-1 is cancelled, res-villa-2's link must NOT be matched
  const matched = await findUnrefundedAccommodationDifferences(client, ['res-villa-1']);
  assertEquals(matched.length, 0);
  assertEquals(sumUnrefundedDifferenceAmount(matched), 0);
});

Deno.test('paid differences with unverified paid_amount fail closed and never use requested amount', async () => {
  const unverified = sampleDifferenceLink({
    id: 'link-unverified-paid-amount',
    amount: 900,
    paid_amount: null,
  });
  const client = {
    from() {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [unverified], error: null }).then(resolve),
      };
      return chain;
    },
  } as unknown as SupabaseClient;

  await assertRejects(
    () => findUnrefundedAccommodationDifferences(client, ['res-1']),
    Error,
    '(UNVERIFIED): link-unverified-paid-amount',
  );
  assertEquals(sumUnrefundedDifferenceAmount([unverified]), 0);
  assertEquals(
    sumUnrefundedDifferenceAmount([
      { amount: 700, paid_amount: 'not-a-number', refunded_amount: null },
    ]),
    0,
  );

  const alerts: Array<Array<string | null | undefined>> = [];
  await alertUnrefundedAccommodationDifferences(
    {
      bookingGroupId: 'grp-1',
      reservationIds: ['res-1'],
      links: [unverified],
      totalAmount: 0,
    },
    (_subject, lines) => {
      alerts.push(lines);
      return Promise.resolve({ sent: true });
    },
  );
  const alertText = alerts[0].filter(Boolean).join('\n');
  assert(alertText.includes('link-unverified-paid-amount (UNVERIFIED MDL)'), alertText);
  assertEquals(alertText.includes('link-unverified-paid-amount (900 MDL)'), false);
});

// -----------------------------------------------------------------------------
// 2. Staff alert formatting
// -----------------------------------------------------------------------------

Deno.test('alertUnrefundedAccommodationDifferences names the booking, amount, and link id', async () => {
  const recordedAlerts: Array<{ subject: string; lines: Array<string | null | undefined> }> = [];

  const fakeAlertSender = (
    subject: string,
    lines: Array<string | null | undefined>,
  ): Promise<{ sent: boolean }> => {
    recordedAlerts.push({ subject, lines });
    return Promise.resolve({ sent: true });
  };

  await alertUnrefundedAccommodationDifferences(
    {
      bookingGroupId: 'grp-test-123',
      reservationIds: ['res-abc', 'res-def'],
      links: [
        { id: 'link-111', amount: 500, paid_amount: 500, currency: 'MDL' },
        { id: 'link-222', amount: 300, paid_amount: 300, currency: 'MDL' },
      ],
      totalAmount: 800,
      guestName: 'Diana Test',
      guestPhone: '+37369000000',
    },
    fakeAlertSender,
  );

  assertEquals(recordedAlerts.length, 1);
  const alert = recordedAlerts[0];
  assertEquals(alert.subject, 'Diferență cazare de restituit manual la anulare');

  const bodyText = alert.lines.filter(Boolean).join('\n');
  assert(bodyText.includes('grp-test-123'), bodyText);
  assert(bodyText.includes('link-111 (500 MDL)'), bodyText);
  assert(bodyText.includes('link-222 (300 MDL)'), bodyText);
  assert(bodyText.includes('800 MDL'), bodyText);
  assert(bodyText.includes('Diana Test'), bodyText);
  assert(bodyText.includes('+37369000000'), bodyText);
});

// -----------------------------------------------------------------------------
// 3. Honest guest cancellation copy (Email and SMS)
// -----------------------------------------------------------------------------

Deno.test('honest copy appears in cancellation email only when hasManualDifferenceRefund is true', () => {
  const expectedPhrases = {
    ro: 'Diferența de cazare achitată separat se restituie separat și te vom contacta.',
    ru: 'Отдельно оплаченная разница за проживание возвращается отдельно, мы свяжемся с вами.',
    en:
      'The separately paid accommodation difference is returned separately and we will contact you.',
  };

  for (const lang of ['ro', 'ru', 'en'] as const) {
    // When hasManualDifferenceRefund is true -> honest sentence must be in email
    const emailWithDiff = buildCancellationEmail({
      lang,
      firstName: 'Ion',
      fullName: 'Ion Creangă',
      roomCopy: 'Căsuță mică',
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      refundAmount: 2000,
      withheldCommission: 28,
      refundStatus: 'scheduled',
      refundEta: '2026-08-28T18:30:00.000Z',
      siteUrl: 'https://ecovila.md',
      hasManualDifferenceRefund: true,
    });

    assert(
      emailWithDiff.text.includes(expectedPhrases[lang]),
      `${lang} email text must contain honest difference note: ${emailWithDiff.text}`,
    );
    assert(
      emailWithDiff.html.includes(expectedPhrases[lang]),
      `${lang} email html must contain honest difference note`,
    );

    // When hasManualDifferenceRefund is false / omitted -> honest sentence must NOT be in email
    const emailWithoutDiff = buildCancellationEmail({
      lang,
      firstName: 'Ion',
      fullName: 'Ion Creangă',
      roomCopy: 'Căsuță mică',
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      refundAmount: 2000,
      withheldCommission: 28,
      refundStatus: 'scheduled',
      refundEta: '2026-08-28T18:30:00.000Z',
      siteUrl: 'https://ecovila.md',
      hasManualDifferenceRefund: false,
    });

    assertEquals(
      emailWithoutDiff.text.includes(expectedPhrases[lang]),
      false,
      `${lang} email text must not contain difference note when hasManualDifferenceRefund is false`,
    );
  }
});

Deno.test('honest copy appears in cancellation SMS only when hasManualDifferenceRefund is true and stays GSM-7 in RO', () => {
  const expectedSmsPhrases = {
    ro: 'Diferenta de cazare achitata separat se restituie separat si va vom contacta.',
    ru: 'Отдельно оплаченная разница за проживание возвращается отдельно, мы свяжемся с вами.',
    en:
      'The separately paid accommodation difference is returned separately and we will contact you.',
  };

  for (const language of ['ro', 'ru', 'en'] as const) {
    const smsWithDiff = cancellationConfirmationSms({
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      refundAmount: 2000,
      withheldCommission: 28,
      refundStatus: 'scheduled',
      refundEta: '2026-08-28T18:30:00.000Z',
      language,
      hasManualDifferenceRefund: true,
    });

    assert(
      smsWithDiff.includes(expectedSmsPhrases[language]),
      `${language} SMS must contain honest difference note: ${smsWithDiff}`,
    );

    if (language === 'ro') {
      assertEquals(
        nonGsm7(smsWithDiff),
        [],
        `RO cancellation SMS with difference note must stay GSM-7: ${smsWithDiff}`,
      );
    }

    const smsWithoutDiff = cancellationConfirmationSms({
      checkIn: '2026-10-10',
      checkOut: '2026-10-12',
      refundAmount: 2000,
      withheldCommission: 28,
      refundStatus: 'scheduled',
      refundEta: '2026-08-28T18:30:00.000Z',
      language,
      hasManualDifferenceRefund: false,
    });

    assertEquals(
      smsWithoutDiff.includes(expectedSmsPhrases[language]),
      false,
      `${language} SMS must not contain difference note when false`,
    );
  }
});

// -----------------------------------------------------------------------------
// 4. End-to-end handleCancelReservation tests (a, b, c)
// -----------------------------------------------------------------------------

function createMockSupabaseForCancellation(options: {
  paymentLinkRows?: PaymentLinkRow[];
  paymentLinksError?: string | null;
}) {
  const updatedReservations: Array<Record<string, unknown>> = [];
  const insertedMaibRefunds: Array<Record<string, unknown>> = [];
  const insertedNotificationEvents: Array<Record<string, unknown>> = [];

  const client = {
    from(tableName: string) {
      if (tableName === 'rate_limits') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          then: (resolve: (val: unknown) => unknown) =>
            Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
        };
        return chain;
      }

      if (tableName === 'reservation_manage_tokens') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { phone: '+37369111222', expires_at: '2099-01-01T00:00:00.000Z' },
              error: null,
            }),
        };
        return chain;
      }

      if (tableName === 'reservations') {
        let updatePayload: Record<string, unknown> | null = null;
        const chain = {
          select: () => chain,
          eq: (col: string, _val: unknown) => {
            if (col === 'id') {
              return {
                ...chain,
                maybeSingle: () =>
                  Promise.resolve({
                    data: { booking_group_id: 'grp-test-107' },
                    error: null,
                  }),
              };
            }
            return chain;
          },
          or: () => chain,
          in: () => chain,
          is: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: { booking_group_id: 'grp-test-107' },
              error: null,
            }),
          update: (payload: Record<string, unknown>) => {
            updatePayload = payload;
            updatedReservations.push(payload);
            return chain;
          },
          then: (resolve: (val: unknown) => unknown) => {
            if (updatePayload) {
              return Promise.resolve({ data: null, error: null }).then(resolve);
            }
            // Active group selection
            return Promise.resolve({
              data: [
                {
                  id: 'res-cancelled-1',
                  booking_group_id: 'grp-test-107',
                  guest_first_name: 'Ana',
                  guest_last_name: 'Test',
                  guest_phone: '+37369111222',
                  guest_email: 'ana@test.md',
                  guest_language: 'ro',
                  check_in: '2026-10-15',
                  check_out: '2026-10-18',
                  total_price: 3000,
                  payment_type: 'card',
                  payment_status: 'paid',
                  created_at: '2026-08-01T10:00:00.000Z',
                  cancelled_at: null,
                  rooms: { number: 1, type: 'small' },
                },
              ],
              error: null,
            }).then(resolve);
          },
        };
        return chain;
      }

      if (tableName === 'maib_payments') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: {
                pay_id: 'pay-main-1',
                provider_payment_id: 'prov-1',
                amount: 3000,
                currency: 'MDL',
                status: 'paid',
              },
              error: null,
            }),
        };
        return chain;
      }

      if (tableName === 'reservation_changes') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          then: (resolve: (val: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return chain;
      }

      if (tableName === 'maib_refunds') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: (payload: Record<string, unknown>) => {
            insertedMaibRefunds.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
          upsert: (payload: Record<string, unknown>) => {
            insertedMaibRefunds.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
          update: () => chain,
          then: (resolve: (val: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return chain;
      }

      if (tableName === 'payment_links') {
        if (options.paymentLinksError) {
          const chain = {
            select: () => chain,
            eq: () => chain,
            in: () => chain,
            is: () => chain,
            then: (resolve: (val: unknown) => unknown) =>
              Promise.resolve({
                data: null,
                error: { message: options.paymentLinksError },
              }).then(resolve),
          };
          return chain;
        }

        const rows = options.paymentLinkRows || [];
        const filters: Array<(row: PaymentLinkRow) => boolean> = [];
        const chain = {
          select: () => chain,
          eq: (col: string, val: unknown) => {
            filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
            return chain;
          },
          in: (col: string, vals: unknown[]) => {
            filters.push((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
            return chain;
          },
          is: (col: string, val: unknown) => {
            filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
            return chain;
          },
          then: (resolve: (val: unknown) => unknown) => {
            const data = rows.filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data, error: null }).then(resolve);
          },
        };
        return chain;
      }

      if (tableName === 'notification_events') {
        const chain = {
          insert: (payload: Record<string, unknown>) => {
            insertedNotificationEvents.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
          update: () => chain,
          eq: () => chain,
          then: (resolve: (val: unknown) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return chain;
      }

      throw new Error(`Unexpected table ${tableName}`);
    },
    rpc(fnName: string, _args: Record<string, unknown>) {
      if (fnName === 'prepare_full_refund_intent') {
        return Promise.resolve({
          data: {
            main_status: 'requested',
            main_eligible_at: '2026-08-28T18:30:00.000Z',
            main_amount: 3000,
            main_gross_amount: 3000,
            main_withheld: 0,
            main_rate_bps: 0,
            main_policy_version: 'adr-105-1.4pct',
            change_quotes: [],
          },
          error: null,
        });
      }
      throw new Error(`Unexpected rpc ${fnName}`);
    },
  } as unknown as SupabaseClient;

  return { client, updatedReservations, insertedMaibRefunds };
}

type RecordedFetch = { url: string; init?: RequestInit };

function withMockFetch(fn: (calls: RecordedFetch[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalAlertEmail = Deno.env.get('ECOVILA_ALERT_EMAIL');
  const calls: RecordedFetch[] = [];
  Deno.env.set('ECOVILA_ALERT_EMAIL', 'alerts@ecovila.md');
  globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) => {
    calls.push({
      url: _url instanceof Request ? _url.url : String(_url),
      init: _init,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'msg_test_ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  return fn(calls).finally(() => {
    globalThis.fetch = originalFetch;
    if (originalAlertEmail === undefined) {
      Deno.env.delete('ECOVILA_ALERT_EMAIL');
    } else {
      Deno.env.set('ECOVILA_ALERT_EMAIL', originalAlertEmail);
    }
  });
}

Deno.test('(a) a partially refunded difference still sends honest copy and raises an alert', async () => {
  await withMockFetch(async (calls) => {
    const diffLink = sampleDifferenceLink({
      id: 'link-test-107',
      reservation_id: 'res-cancelled-1',
      booking_group_id: 'grp-test-107',
      amount: 1000,
      paid_amount: 1000,
      refunded_at: '2026-08-25T12:00:00.000Z',
      refunded_amount: 400,
    });

    const { client, updatedReservations } = createMockSupabaseForCancellation({
      paymentLinkRows: [diffLink],
    });

    const request = new Request('https://api.test/reservation-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manageToken: 'valid-token',
        reservationId: 'res-cancelled-1',
      }),
    });

    const response = await handleCancelReservation(request, client);
    assertEquals(response.status, 200);

    const payload = await response.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.status, 'cancelled');
    assertEquals(payload.refundScheduled, true);

    // Reservation payment_status was updated to cancelled
    assertEquals(updatedReservations.length, 1);
    assertEquals(updatedReservations[0].payment_status, 'cancelled');

    // Notification was delivered with honest copy
    assertEquals(payload.notificationResults?.length, 1);
    assertEquals(payload.notificationResults[0].sent, true);

    const smsCall = calls.find((call) => call.url.includes('api.sms.md'));
    if (!smsCall) throw new Error('guest SMS must be sent');
    assert(
      new URL(smsCall.url).searchParams.get('message')?.includes(
        'Diferenta de cazare achitata separat se restituie separat si va vom contacta.',
      ),
      'guest SMS must warn that the outstanding difference is refunded separately',
    );

    const alertCall = calls.find((call) => {
      if (!call.init?.body || typeof call.init.body !== 'string') return false;
      const body = JSON.parse(call.init.body);
      return String(body.subject || '').includes('Diferență cazare de restituit manual');
    });
    if (!alertCall) {
      throw new Error('staff alert must be raised for the partially refunded difference');
    }
    const alertBody = JSON.parse(String(alertCall.init?.body));
    assert(String(alertBody.text).includes('Sumă de restituit manual: 600 MDL'));
  });
});

Deno.test('(b) a failed lookup sends pessimistic guest copy and an alert without changing cancellation or refund', async () => {
  await withMockFetch(async (calls) => {
    const { client, updatedReservations } = createMockSupabaseForCancellation({
      paymentLinksError: 'connection refused to payment_links table',
    });

    const request = new Request('https://api.test/reservation-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manageToken: 'valid-token',
        reservationId: 'res-cancelled-1',
      }),
    });

    // Must not throw despite the payment_links lookup failure
    const response = await handleCancelReservation(request, client);
    assertEquals(response.status, 200);

    const payload = await response.json();
    assertEquals(payload.ok, true);
    assertEquals(payload.status, 'cancelled');
    assertEquals(payload.refundScheduled, true);
    assertEquals(payload.refundQuote?.gross, 3000);
    assertEquals(payload.refundQuote?.net, 3000);
    assertEquals(payload.refundTotal?.gross, 3000);
    assertEquals(payload.refundTotal?.net, 3000);

    // Booking was still cancelled
    assertEquals(updatedReservations.length, 1);
    assertEquals(updatedReservations[0].payment_status, 'cancelled');

    const smsCall = calls.find((call) => call.url.includes('api.sms.md'));
    if (!smsCall) throw new Error('guest SMS must still be sent');
    const smsMessage = new URL(smsCall.url).searchParams.get('message') || '';
    assert(
      smsMessage.includes(
        'Nu am putut verifica diferenta de cazare achitata separat. Echipa noastra va va contacta.',
      ),
      smsMessage,
    );
    assertEquals(nonGsm7(smsMessage), [], `RO pessimistic SMS must stay GSM-7: ${smsMessage}`);

    const emailCalls = calls
      .filter((call) => call.init?.body && typeof call.init.body === 'string')
      .map((call) => JSON.parse(String(call.init?.body)));
    const guestEmail = emailCalls.find((body) => body.to === 'ana@test.md');
    assert(guestEmail, 'guest email must still be sent');
    assert(
      String(guestEmail.text).includes(
        'Nu am putut verifica diferența de cazare achitată separat. Echipa noastră te va contacta.',
      ),
    );

    const verificationAlert = emailCalls.find((body) =>
      String(body.subject || '').includes('Verificare eșuată a diferenței de cazare')
    );
    assert(verificationAlert, 'staff alert must be raised when verification fails');
    assert(String(verificationAlert.text).includes('connection refused to payment_links table'));
  });
});

Deno.test('(b2) a paid link without paid_amount follows the same pessimistic verification path', async () => {
  await withMockFetch(async (calls) => {
    const { client } = createMockSupabaseForCancellation({
      paymentLinkRows: [
        sampleDifferenceLink({
          id: 'link-unverified-cancellation',
          reservation_id: 'res-cancelled-1',
          amount: 1250,
          paid_amount: null,
        }),
      ],
    });
    const request = new Request('https://api.test/reservation-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manageToken: 'valid-token',
        reservationId: 'res-cancelled-1',
      }),
    });

    const response = await handleCancelReservation(request, client);
    assertEquals(response.status, 200);

    const smsCall = calls.find((call) => call.url.includes('api.sms.md'));
    if (!smsCall) throw new Error('guest SMS must still be sent');
    assert(
      new URL(smsCall.url).searchParams.get('message')?.includes(
        'Nu am putut verifica diferenta de cazare achitata separat.',
      ),
      'missing paid_amount must use pessimistic guest copy',
    );

    const emailCalls = calls
      .filter((call) => call.init?.body && typeof call.init.body === 'string')
      .map((call) => JSON.parse(String(call.init?.body)));
    const verificationAlert = emailCalls.find((body) =>
      String(body.subject || '').includes('Verificare eșuată a diferenței de cazare')
    );
    assert(verificationAlert, 'missing paid_amount must raise the verification-failure alert');
    assert(String(verificationAlert.text).includes('link-unverified-cancellation'));
    assert(String(verificationAlert.text).includes('UNVERIFIED'));
    assertEquals(
      emailCalls.some((body) =>
        String(body.subject || '').includes('Diferență cazare de restituit manual')
      ),
      false,
      'requested amount must never be reported as confirmed captured money',
    );
  });
});

Deno.test('(c) refund amounts are UNCHANGED by accommodation_difference payment links', async () => {
  await withMockFetch(async () => {
    // Booking has 3000 MDL card payment, plus a 600 MDL paid difference link
    const diffLink = sampleDifferenceLink({
      id: 'link-test-107',
      reservation_id: 'res-cancelled-1',
      booking_group_id: 'grp-test-107',
      amount: 600,
      paid_amount: 600,
      refunded_at: null,
    });

    const { client } = createMockSupabaseForCancellation({
      paymentLinkRows: [diffLink],
    });

    const request = new Request('https://api.test/reservation-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manageToken: 'valid-token',
        reservationId: 'res-cancelled-1',
      }),
    });

    const response = await handleCancelReservation(request, client);
    assertEquals(response.status, 200);

    const payload = await response.json();
    assertEquals(payload.ok, true);

    // Refund quotes in response must be strictly based on the 3000 MDL base payment (gross 3000, net 3000, withheld 0)
    // and MUST NOT include the 600 MDL payment link difference!
    assertEquals(payload.refundQuote?.gross, 3000);
    assertEquals(payload.refundQuote?.net, 3000);
    assertEquals(payload.refundQuote?.withheld, 0);

    assertEquals(payload.refundTotal?.gross, 3000);
    assertEquals(payload.refundTotal?.net, 3000);
    assertEquals(payload.refundTotal?.withheld, 0);
  });
});
