import { assertEquals } from 'std/assert';
import {
  notifyPaidReservations,
  type PaymentReservationRow,
} from '../_shared/bookingSettlement.ts';

// Regression guard for the MIA double-SMS bug (ADR-058). A two-villa booking is
// one booking group with two reservation rows. Both online rails can settle it
// concurrently — the MIA push callback and the browser status poll — and each
// settlement's `paidReservations` can be a different subset of the group. The
// confirmation must still go out exactly once for the whole group, because the
// dedup is claimed on a booking-group-stable owner, not on each call's subset.

const OWNER_ID = '11111111-1111-1111-1111-111111111111';
const SECOND_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function reservation(id: string, roomNumber: number): PaymentReservationRow {
  return {
    id,
    booking_group_id: GROUP_ID,
    guest_first_name: 'Ana',
    guest_last_name: 'Pop',
    guest_phone: '+37360000000',
    guest_email: 'ana@example.com',
    guest_language: 'ro',
    check_in: '2026-07-07',
    check_out: '2026-07-08',
    total_price: 2500,
    payment_type: 'card',
    payment_status: 'paid',
    room_number: roomNumber,
    room_type: 'small',
  };
}

// In-memory stand-in for the tables `notifyPaidReservations` touches. The only
// behaviour that matters for the race is that `notification_events` enforces the
// real unique(reservation_id, event_type) constraint across both settlements.
function createSettlementStore() {
  const reservations = [
    { ...reservation(OWNER_ID, 3), rooms: { number: 3, type: 'small' } },
    { ...reservation(SECOND_ID, 5), rooms: { number: 5, type: 'small' } },
  ];
  const notificationEvents: Array<Record<string, unknown>> = [];
  const cancellationTokens = [{
    reservation_id: OWNER_ID,
    token: 'cancel-token-owner',
    used: false,
  }];

  function builder(resolve: () => { data: unknown; error: unknown }) {
    const chain = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      order: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (
        onfulfilled?: (value: { data: unknown; error: unknown }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(onfulfilled, onrejected),
    };
    return chain;
  }

  const client = {
    from(table: string) {
      if (table === 'reservations') {
        return builder(() => ({
          data: [...reservations].sort((a, b) => a.id.localeCompare(b.id)),
          error: null,
        }));
      }

      if (table === 'cancellation_tokens') {
        return {
          select: () =>
            builder(() => ({
              data: cancellationTokens.find((row) => !row.used) ?? null,
              error: null,
            })),
          insert: (rows: Array<Record<string, unknown>>) => {
            cancellationTokens.push({
              reservation_id: String(rows[0].reservation_id),
              token: String(rows[0].token),
              used: false,
            });
            return builder(() => ({ data: rows[0], error: null }));
          },
        };
      }

      if (table === 'notification_events') {
        return {
          insert: (payload: Record<string, unknown>) => {
            const duplicate = notificationEvents.some(
              (row) =>
                row.reservation_id === payload.reservation_id &&
                row.event_type === payload.event_type,
            );
            if (duplicate) {
              return builder(() => ({ data: null, error: { code: '23505' } }));
            }
            const id = crypto.randomUUID();
            notificationEvents.push({ id, ...payload });
            return builder(() => ({ data: { id }, error: null }));
          },
          update: (payload: Record<string, unknown>) =>
            builder(() => ({ data: payload, error: null })),
        };
      }

      if (table === 'reservation_manage_tokens') {
        return { insert: () => builder(() => ({ data: null, error: null })) };
      }

      throw new Error(`unexpected table ${table}`);
    },
  };

  return { client, notificationEvents };
}

Deno.test('notifyPaidReservations sends one confirmation per booking group across racing settlements', async () => {
  const previousEnv = {
    cron: Deno.env.get('ECOVILA_CRON_SECRET'),
    smsToken: Deno.env.get('SMSMD_API_TOKEN'),
    smsFrom: Deno.env.get('SMSMD_FROM'),
    smsUrl: Deno.env.get('SMSMD_API_URL'),
    resendKey: Deno.env.get('RESEND_API_KEY'),
    resendFrom: Deno.env.get('RESEND_FROM_EMAIL'),
    resendUrl: Deno.env.get('RESEND_API_URL'),
  };
  const previousFetch = globalThis.fetch;

  Deno.env.set('ECOVILA_CRON_SECRET', 'test-secret');
  Deno.env.set('SMSMD_API_TOKEN', 'sms-token');
  Deno.env.set('SMSMD_FROM', 'EcoVila');
  Deno.env.set('SMSMD_API_URL', 'https://sms.test/send');
  Deno.env.set('RESEND_API_KEY', 'resend-key');
  Deno.env.set('RESEND_FROM_EMAIL', 'hello@ecovila.md');
  Deno.env.set('RESEND_API_URL', 'https://email.test/send');

  let smsCount = 0;
  let emailCount = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://sms.test/')) {
      smsCount += 1;
    } else if (url.startsWith('https://email.test/')) {
      emailCount += 1;
    }
    return Promise.resolve(new Response(JSON.stringify({ id: 'provider-ok' }), { status: 200 }));
  }) as typeof fetch;

  try {
    const { client, notificationEvents } = createSettlementStore();
    const owner = reservation(OWNER_ID, 3);
    const second = reservation(SECOND_ID, 5);

    // Rail 1 (e.g. the MIA push callback) settles the whole group.
    const first = await notifyPaidReservations(
      client as never,
      [owner, second],
      'maib-mia-callback',
    );
    // Rail 2 (the browser status poll) races in and only "owns" the second villa
    // — the exact subset split that used to produce a second SMS.
    const secondRail = await notifyPaidReservations(client as never, [second], 'maib-mia-status');

    assertEquals(smsCount, 1);
    assertEquals(emailCount, 1);

    const confirmations = notificationEvents.filter(
      (row) => row.event_type === 'payment_confirmation',
    );
    assertEquals(confirmations.length, 1);
    // The single confirmation is always keyed on the group owner (lowest id).
    assertEquals(confirmations[0].reservation_id, OWNER_ID);

    assertEquals(first[0]?.sent, true);
    assertEquals(secondRail[0]?.skipped_duplicate, true);
    assertEquals(secondRail[0]?.sent, false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('ECOVILA_CRON_SECRET', previousEnv.cron);
    restoreEnv('SMSMD_API_TOKEN', previousEnv.smsToken);
    restoreEnv('SMSMD_FROM', previousEnv.smsFrom);
    restoreEnv('SMSMD_API_URL', previousEnv.smsUrl);
    restoreEnv('RESEND_API_KEY', previousEnv.resendKey);
    restoreEnv('RESEND_FROM_EMAIL', previousEnv.resendFrom);
    restoreEnv('RESEND_API_URL', previousEnv.resendUrl);
  }
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}
