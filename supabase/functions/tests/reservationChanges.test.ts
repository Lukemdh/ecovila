import { assertEquals, assertRejects } from 'std/assert';
import type { ChangeReservationRow, ReservationChangeRow } from '../_shared/reservationChanges.ts';

// ADR-057 "add guests to a paid booking" money module. These cover the
// server-authoritative paths a tampered client could attack: capacity bounding,
// the price difference, the add-only / superset rules, and the once-only apply.

const PRICING_TIERS = [
  {
    nights_tier: 1,
    day_type: 'weekday',
    adult_price: 1100,
    kid_price: 900,
    effective_from: '2026-05-06',
  },
  {
    nights_tier: 1,
    day_type: 'holiday',
    adult_price: 1300,
    kid_price: 1000,
    effective_from: '2026-05-06',
  },
  {
    nights_tier: 2,
    day_type: 'weekday',
    adult_price: 1000,
    kid_price: 800,
    effective_from: '2026-05-06',
  },
  {
    nights_tier: 2,
    day_type: 'holiday',
    adult_price: 1200,
    kid_price: 900,
    effective_from: '2026-05-06',
  },
  {
    nights_tier: 3,
    day_type: 'weekday',
    adult_price: 900,
    kid_price: 700,
    effective_from: '2026-05-06',
  },
  {
    nights_tier: 3,
    day_type: 'holiday',
    adult_price: 1100,
    kid_price: 800,
    effective_from: '2026-05-06',
  },
];

// Minimal chainable client that only serves pricing_tiers + holidays reads, the
// only DB access quoteBookingChange performs (it takes reservations as input).
function pricingClient(holidays: { date: string }[] = []) {
  const data: Record<string, unknown[]> = { pricing_tiers: PRICING_TIERS, holidays };
  return {
    from(table: string) {
      const result = Promise.resolve({ data: data[table] || [], error: null });
      const builder = {
        select: () => builder,
        order: () => result,
      };
      return builder;
    },
  };
}

function reservationRow(overrides: Partial<ChangeReservationRow> = {}): ChangeReservationRow {
  return {
    id: 'res-1',
    booking_group_id: 'grp-1',
    room_id: 'room-a',
    guest_first_name: 'Ana',
    guest_last_name: 'Munteanu',
    guest_phone: '+37360123456',
    guest_email: 'ana@example.md',
    guest_language: 'ro',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    adults: 2,
    kids_ages: [],
    total_price: 4000,
    payment_type: 'card',
    payment_status: 'paid',
    cancelled_at: null,
    rooms: { number: 1, type: 'small' },
    ...overrides,
  };
}

// ── quoteBookingChange: difference, capacity, add-only/superset ──────────────

Deno.test('quoteBookingChange charges only the added chargeable child', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  // 2 adults, 2 weekday nights (tier 2 @ 1000) = 4000 already paid. Adding a
  // 5-year-old (kid fee @ 800 x 2 nights) is a 1600 difference.
  const quote = await quoteBookingChange(pricingClient(), {
    reservations: [reservationRow()],
    newAdults: 2,
    newKidsAges: [5],
  });

  assertEquals(quote.difference, 1600);
  assertEquals(quote.newAdults, 2);
  assertEquals(quote.newKidsAges, [5]);
  assertEquals(quote.prevTotal, 4000);
  assertEquals(quote.newTotal, 5600);
  assertEquals(quote.units, 1);
});

Deno.test('quoteBookingChange returns a zero difference for a free infant', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  // A 1–3-year-old is free, so the difference is 0 (applied instantly, no pay).
  const quote = await quoteBookingChange(pricingClient(), {
    reservations: [reservationRow()],
    newAdults: 2,
    newKidsAges: [2],
  });

  assertEquals(quote.difference, 0);
  assertEquals(quote.newKidsAges, [2]);
});

Deno.test('quoteBookingChange keeps the existing children when only adding new ones', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  // Existing 5-year-old kept, a free 2-year-old added: still 0 difference but
  // the new party must carry BOTH children.
  const quote = await quoteBookingChange(pricingClient(), {
    reservations: [reservationRow({ kids_ages: [5] })],
    newAdults: 2,
    newKidsAges: [5, 2],
  });

  assertEquals(quote.difference, 0);
  assertEquals(quote.newKidsAges, [2, 5]);
});

Deno.test('quoteBookingChange rejects a forged oversized adult count before any capacity scan', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  // Bound check fires on a value that would otherwise spin getUnitsNeeded (DoS).
  const error = await assertRejects(
    () =>
      quoteBookingChange(pricingClient(), {
        reservations: [reservationRow()],
        newAdults: 1_000_000_000,
        newKidsAges: [],
      }),
    HttpError,
    'do not fit',
  );
  assertEquals(error.status, 409);
});

Deno.test('quoteBookingChange rejects an oversized kids array before normalizing it', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  const error = await assertRejects(
    () =>
      quoteBookingChange(pricingClient(), {
        reservations: [reservationRow()],
        newAdults: 2,
        newKidsAges: new Array(5000).fill(5),
      }),
    HttpError,
    'do not fit',
  );
  assertEquals(error.status, 409);
});

Deno.test('quoteBookingChange rejects a party that needs more villas than booked', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  // Within the raw bound, but 3 kids force a 2nd small villa (only 1 booked).
  await assertRejects(
    () =>
      quoteBookingChange(pricingClient(), {
        reservations: [reservationRow()],
        newAdults: 2,
        newKidsAges: [5, 6, 7],
      }),
    HttpError,
    'do not fit',
  );
});

Deno.test('quoteBookingChange refuses to remove adults or edit existing children', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');

  await assertRejects(
    () =>
      quoteBookingChange(pricingClient(), {
        reservations: [reservationRow()],
        newAdults: 1,
        newKidsAges: [],
      }),
    HttpError,
    'only be added',
  );

  await assertRejects(
    () =>
      quoteBookingChange(pricingClient(), {
        reservations: [reservationRow({ kids_ages: [5] })],
        newAdults: 2,
        newKidsAges: [6],
      }),
    HttpError,
    'Existing children',
  );
});

Deno.test('quoteBookingChange rejects a no-op change', async () => {
  const { quoteBookingChange } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  await assertRejects(
    () =>
      quoteBookingChange(pricingClient(), {
        reservations: [reservationRow()],
        newAdults: 2,
        newKidsAges: [],
      }),
    HttpError,
    'No new guests',
  );
});

// ── applyBookingChange: apply the party exactly once ─────────────────────────

function applyMockClient() {
  const state = { appliedAt: null as string | null, reservationsPayload: null as unknown };

  return {
    state,
    from(table: string) {
      if (table === 'reservation_changes') {
        const builder = {
          _claim: null as Record<string, unknown> | null,
          update(payload: Record<string, unknown>) {
            this._claim = payload;
            return this;
          },
          eq() {
            return this;
          },
          is() {
            return this;
          },
          select() {
            return this;
          },
          // Atomic "claim": only the first caller (applied_at still null) wins.
          order() {
            if (state.appliedAt === null) {
              state.appliedAt = String(this._claim?.applied_at ?? '');
              return Promise.resolve({ data: [{ id: 'chg-1' }], error: null });
            }
            return Promise.resolve({ data: [], error: null });
          },
        };
        return builder;
      }

      const resBuilder = {
        update(payload: unknown) {
          state.reservationsPayload = payload;
          return this;
        },
        in() {
          return this;
        },
        is() {
          return this;
        },
        select() {
          return Promise.resolve({ data: [{ id: 'res-1' }], error: null });
        },
      };
      return resBuilder;
    },
  };
}

function changeRow(overrides: Partial<ReservationChangeRow> = {}): ReservationChangeRow {
  return {
    id: 'chg-1',
    booking_group_id: 'grp-1',
    reservation_ids: ['res-1'],
    room_type: 'small',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    prev_adults: 2,
    prev_kids_ages: [],
    new_adults: 3,
    new_kids_ages: [5],
    prev_total: 4000,
    new_total: 5600,
    difference_amount: 1600,
    payment_rail: 'card',
    pay_id: 'pay-1',
    provider_payment_id: null,
    status: 'pending',
    checkout_url: '',
    expires_at: null,
    paid_at: null,
    applied_at: null,
    ...overrides,
  };
}

Deno.test('applyBookingChange applies the new party exactly once', async () => {
  const { applyBookingChange } = await import('../_shared/reservationChanges.ts');
  const client = applyMockClient();
  const change = changeRow();
  const now = '2026-06-18T10:00:00.000Z';

  const first = await applyBookingChange(client as never, change, now);
  assertEquals(first.applied, true);
  assertEquals(client.state.reservationsPayload, { adults: 3, kids_ages: [5] });

  // A re-entrant callback/poll for the same change must no-op (applied_at set).
  const second = await applyBookingChange(client as never, change, now);
  assertEquals(second.applied, false);
});

// ── insertChangeRow: concurrent double-submit surfaces as a retryable 409 ────

function insertMockClient(error: { code?: string; message: string } | null) {
  return {
    from() {
      const builder = {
        insert() {
          return builder;
        },
        select() {
          return builder;
        },
        single() {
          return Promise.resolve(
            error ? { data: null, error } : { data: { id: 'chg-1' }, error: null },
          );
        },
      };
      return builder;
    },
  };
}

function insertInput() {
  return {
    bookingGroupId: 'grp-1',
    reservationIds: ['res-1'],
    quote: {
      roomType: 'small',
      units: 1,
      checkIn: '2026-06-01',
      checkOut: '2026-06-03',
      prevAdults: 2,
      prevKidsAges: [],
      newAdults: 2,
      newKidsAges: [5],
      prevTotal: 4000,
      newTotal: 5600,
      difference: 1600,
    },
    paymentRail: 'card' as const,
    status: 'pending',
    expiresAt: null,
    paidAt: null,
    appliedAt: null,
  };
}

Deno.test('insertChangeRow maps the one-open-change unique violation to a 409', async () => {
  const { insertChangeRow } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  const client = insertMockClient({ code: '23505', message: 'duplicate key value' });

  const error = await assertRejects(
    () => insertChangeRow(client as never, insertInput()),
    HttpError,
    'already in progress',
  );
  assertEquals(error.status, 409);
});

Deno.test('insertChangeRow rethrows other database errors verbatim', async () => {
  const { insertChangeRow } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  const client = insertMockClient({ code: '42501', message: 'permission denied' });

  // A non-conflict failure is a real error, not a friendly 409.
  const error = await assertRejects(
    () => insertChangeRow(client as never, insertInput()),
    Error,
    'permission denied',
  );
  assertEquals(error instanceof HttpError, false);
});

// ── assertEligibleForChange + storedChangeStatus ─────────────────────────────

Deno.test('assertEligibleForChange enforces online-paid, live, upcoming bookings', async () => {
  const { assertEligibleForChange } = await import('../_shared/reservationChanges.ts');
  const { HttpError } = await import('../_shared/http.ts');
  const now = new Date('2026-06-18T12:00:00.000Z');
  // assertEligibleForChange throws synchronously; wrap in async arrows so the
  // throw surfaces as a rejection for assertRejects.
  await assertRejects(async () => assertEligibleForChange([], now), HttpError, 'not found');

  await assertRejects(
    async () => assertEligibleForChange([reservationRow({ payment_type: 'cash' })], now),
    HttpError,
    'online-paid',
  );

  await assertRejects(
    async () =>
      assertEligibleForChange([reservationRow({ cancelled_at: '2026-06-01T00:00:00Z' })], now),
    HttpError,
    'online-paid',
  );

  await assertRejects(
    async () =>
      assertEligibleForChange(
        [reservationRow({ check_in: '2026-05-01', check_out: '2026-05-03' })],
        now,
      ),
    HttpError,
    'ended',
  );

  // A valid upcoming online-paid booking does not throw.
  assertEligibleForChange([reservationRow({ check_out: '2026-12-01' })], now);
});

Deno.test('storedChangeStatus maps stored state and lazy expiry to a public status', async () => {
  const { storedChangeStatus } = await import('../_shared/reservationChanges.ts');

  assertEquals(storedChangeStatus(changeRow({ status: 'paid' })), 'paid');
  assertEquals(storedChangeStatus(changeRow({ status: 'refunded' })), 'paid');
  assertEquals(
    storedChangeStatus(changeRow({ status: 'pending', applied_at: '2026-06-18T10:00:00Z' })),
    'paid',
  );
  assertEquals(storedChangeStatus(changeRow({ status: 'failed' })), 'failed');
  assertEquals(storedChangeStatus(changeRow({ status: 'cancelled' })), 'failed');
  assertEquals(storedChangeStatus(changeRow({ status: 'expired' })), 'expired');
  assertEquals(
    storedChangeStatus(changeRow({ status: 'pending', expires_at: '2000-01-01T00:00:00Z' })),
    'expired',
  );
  assertEquals(
    storedChangeStatus(changeRow({ status: 'pending', expires_at: '2999-01-01T00:00:00Z' })),
    'pending',
  );
});
