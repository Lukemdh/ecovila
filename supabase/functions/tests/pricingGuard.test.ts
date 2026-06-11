import { assertEquals, assertRejects } from 'std/assert';

type TableData = Record<string, unknown[]>;

function fakeClient(data: TableData) {
  return {
    from(table: string) {
      const result = Promise.resolve({ data: data[table] || [], error: null });
      const builder = {
        select: () => builder,
        in: () => builder,
        order: () => builder,
        then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          result.then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

const PRICING_TIERS = [
  { nights_tier: 1, day_type: 'weekday', adult_price: 1100, kid_price: 900, effective_from: '2026-05-06' },
  { nights_tier: 1, day_type: 'holiday', adult_price: 1300, kid_price: 1000, effective_from: '2026-05-06' },
  { nights_tier: 2, day_type: 'weekday', adult_price: 1000, kid_price: 800, effective_from: '2026-05-06' },
  { nights_tier: 2, day_type: 'holiday', adult_price: 1200, kid_price: 900, effective_from: '2026-05-06' },
  { nights_tier: 3, day_type: 'weekday', adult_price: 900, kid_price: 700, effective_from: '2026-05-06' },
  { nights_tier: 3, day_type: 'holiday', adult_price: 1100, kid_price: 800, effective_from: '2026-05-06' },
];

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    room_id: 'room-a',
    guest_first_name: 'Ana',
    guest_last_name: 'Munteanu',
    guest_phone: '+37360123456',
    guest_email: 'ana@example.md',
    guest_language: 'ro',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    adults: 2,
    kids_ages: [] as number[],
    total_price: 4000,
    payment_type: 'card' as const,
    payment_status: 'pending' as const,
    room_explicitly_selected: false,
    conference_room: false as const,
    notes: null,
    cash_expires_at: null,
    cash_extended: false as const,
    created_by: 'guest' as const,
    ...overrides,
  };
}

Deno.test('verifyReservationGroupPricing accepts a total that matches database pricing', async () => {
  const { verifyReservationGroupPricing } = await import('../_shared/pricingGuard.ts');
  // Mon 2026-06-01 and Tue 2026-06-02 nights, tier 2, both weekday: 2 adults x 1000 x 2.
  const client = fakeClient({
    rooms: [{ id: 'room-a', type: 'small', is_active: true }],
    pricing_tiers: PRICING_TIERS,
    holidays: [],
  });

  const rows = await verifyReservationGroupPricing(client, [reservationRow()]);

  assertEquals(rows[0].total_price, 4000);
});

Deno.test('verifyReservationGroupPricing rejects a tampered total with 409', async () => {
  const { verifyReservationGroupPricing } = await import('../_shared/pricingGuard.ts');
  const { HttpError } = await import('../_shared/http.ts');
  const client = fakeClient({
    rooms: [{ id: 'room-a', type: 'small', is_active: true }],
    pricing_tiers: PRICING_TIERS,
    holidays: [],
  });

  const error = await assertRejects(
    () => verifyReservationGroupPricing(client, [reservationRow({ total_price: 1 })]),
    HttpError,
    'Reservation total does not match current pricing',
  );
  assertEquals(error.status, 409);
});

Deno.test('verifyReservationGroupPricing normalizes the per-room split for multi-room bookings', async () => {
  const { verifyReservationGroupPricing } = await import('../_shared/pricingGuard.ts');
  // 4 adults in 2 small rooms: minimum billing 4 adults x 1000 x 2 weekday nights = 8000.
  const client = fakeClient({
    rooms: [
      { id: 'room-a', type: 'small', is_active: true },
      { id: 'room-b', type: 'small', is_active: true },
    ],
    pricing_tiers: PRICING_TIERS,
    holidays: [],
  });
  const rows = await verifyReservationGroupPricing(client, [
    reservationRow({ adults: 4, total_price: 0 }),
    reservationRow({ room_id: 'room-b', adults: 4, total_price: 8000 }),
  ]);

  assertEquals(rows.map((row) => row.total_price), [4000, 4000]);
});

Deno.test('verifyReservationGroupPricing applies recurring holidays regardless of stored year', async () => {
  const { verifyReservationGroupPricing } = await import('../_shared/pricingGuard.ts');
  // Holiday stored for 2025-08-27 must still raise the price of the night
  // before 2026-08-27 (Thu): 1 night, tier 1, holiday rate 1300 x 2 adults.
  const client = fakeClient({
    rooms: [{ id: 'room-a', type: 'small', is_active: true }],
    pricing_tiers: PRICING_TIERS,
    holidays: [{ date: '2025-08-27' }],
  });

  const rows = await verifyReservationGroupPricing(client, [
    reservationRow({ check_in: '2026-08-26', check_out: '2026-08-27', total_price: 2600 }),
  ]);

  assertEquals(rows[0].total_price, 2600);
});

Deno.test('verifyReservationGroupPricing rejects unknown, inactive, or mixed-type rooms', async () => {
  const { verifyReservationGroupPricing } = await import('../_shared/pricingGuard.ts');
  const { HttpError } = await import('../_shared/http.ts');

  await assertRejects(
    () =>
      verifyReservationGroupPricing(
        fakeClient({ rooms: [], pricing_tiers: PRICING_TIERS, holidays: [] }),
        [reservationRow()],
      ),
    HttpError,
    'not available',
  );

  await assertRejects(
    () =>
      verifyReservationGroupPricing(
        fakeClient({
          rooms: [{ id: 'room-a', type: 'small', is_active: false }],
          pricing_tiers: PRICING_TIERS,
          holidays: [],
        }),
        [reservationRow()],
      ),
    HttpError,
    'not available',
  );

  await assertRejects(
    () =>
      verifyReservationGroupPricing(
        fakeClient({
          rooms: [
            { id: 'room-a', type: 'small', is_active: true },
            { id: 'room-b', type: 'large', is_active: true },
          ],
          pricing_tiers: PRICING_TIERS,
          holidays: [],
        }),
        [
          reservationRow({ adults: 4 }),
          reservationRow({ room_id: 'room-b', adults: 4 }),
        ],
      ),
    HttpError,
    'same accommodation type',
  );
});

Deno.test('verifyReservationGroupPricing rejects rows with diverging stay details or duplicate rooms', async () => {
  const { verifyReservationGroupPricing } = await import('../_shared/pricingGuard.ts');
  const { HttpError } = await import('../_shared/http.ts');
  const client = fakeClient({
    rooms: [
      { id: 'room-a', type: 'small', is_active: true },
      { id: 'room-b', type: 'small', is_active: true },
    ],
    pricing_tiers: PRICING_TIERS,
    holidays: [],
  });

  await assertRejects(
    () =>
      verifyReservationGroupPricing(client, [
        reservationRow(),
        reservationRow({ room_id: 'room-b', check_out: '2026-06-04' }),
      ]),
    HttpError,
    'same stay details',
  );

  await assertRejects(
    () =>
      verifyReservationGroupPricing(client, [
        reservationRow({ adults: 4 }),
        reservationRow({ adults: 4 }),
      ]),
    HttpError,
    'only once',
  );
});
