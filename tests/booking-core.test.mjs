import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const pricing = require('../js/pricing.js');
const calendar = require('../js/calendar.js');
const supabaseHelpers = require('../js/supabase.js');

const rooms = [
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `small-${index + 1}`,
    number: index + 1,
    type: 'small',
    is_active: true,
  })),
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `large-${index + 9}`,
    number: index + 9,
    type: 'large',
    is_active: true,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    id: `hotel-${index + 16}`,
    number: index + 16,
    type: 'hotel',
    is_active: true,
  })),
];

const pricingTiers = [
  { nights_tier: 1, day_type: 'weekday', adult_price: 1100, kid_price: 900, effective_from: '2026-05-06' },
  { nights_tier: 1, day_type: 'holiday', adult_price: 1300, kid_price: 1000, effective_from: '2026-05-06' },
  { nights_tier: 2, day_type: 'weekday', adult_price: 1000, kid_price: 800, effective_from: '2026-05-06' },
  { nights_tier: 2, day_type: 'holiday', adult_price: 1200, kid_price: 900, effective_from: '2026-05-06' },
  { nights_tier: 3, day_type: 'weekday', adult_price: 900, kid_price: 700, effective_from: '2026-05-06' },
  { nights_tier: 3, day_type: 'holiday', adult_price: 1100, kid_price: 800, effective_from: '2026-05-06' },
];

describe('EcoVila Step 3 pricing core', () => {
  it('normalizes selected child ages into free children, chargeable children, and teens billed as adults', () => {
    const party = pricing.normalizeParty({ adults: 2, kidsAges: [2, 5, 15] });

    assert.deepEqual(party, {
      adults: 2,
      kidsAges: [2, 5, 15],
      freeChildAges: [2],
      chargeableKidAges: [5],
      teenAges: [15],
      kids: 2,
      freeKids: 1,
      chargeableKids: 1,
      teensAsAdults: 1,
      effectiveAdults: 3,
    });
  });

  it('rejects public kids-only bookings while allowing Diana overrides', () => {
    assert.deepEqual(pricing.validateParty({ adults: 0, kidsAges: [4, 8] }).errors, [
      'At least one adult is required for public bookings.',
    ]);
    assert.equal(
      pricing.validateParty({ adults: 0, kidsAges: [4, 8] }, { publicBooking: false }).valid,
      true,
    );
    assert.equal(
      pricing.validateParty({ adults: 1, kidsAges: [1, 18] }).valid,
      true,
      'public child age selector should allow ages 1-18',
    );
  });

  it('calculates room units needed for groups larger than one accommodation unit', () => {
    assert.equal(pricing.getUnitsNeeded('small', { adults: 4, kidsAges: [] }), 2);
    assert.equal(pricing.getUnitsNeeded('large', { adults: 4, kidsAges: [5, 8] }), 1);
    assert.equal(pricing.getUnitsNeeded('hotel', { adults: 2, kidsAges: [3, 7, 9] }), 2);
    assert.equal(
      pricing.getUnitsNeeded('small', { adults: 2, kidsAges: [15] }),
      2,
      'children aged 13+ should count against adult capacity',
    );
  });

  it('promotes children into minimum adult billing floors before applying kid rates', () => {
    assert.deepEqual(pricing.calculateBillableGuests('small', { adults: 1, kidsAges: [6] }), {
      actualAdults: 1,
      actualKids: 1,
      capacityKids: 1,
      freeKids: 0,
      chargeableKids: 1,
      teensAsAdults: 0,
      billableAdults: 2,
      billableKids: 0,
      kidsChargedAsAdults: 1,
      emptyAdultSlots: 0,
      units: 1,
      minimumAdults: 2,
    });

    assert.deepEqual(pricing.calculateBillableGuests('large', { adults: 2, kidsAges: [6, 10] }), {
      actualAdults: 2,
      actualKids: 2,
      capacityKids: 2,
      freeKids: 0,
      chargeableKids: 2,
      teensAsAdults: 0,
      billableAdults: 3,
      billableKids: 1,
      kidsChargedAsAdults: 1,
      emptyAdultSlots: 0,
      units: 1,
      minimumAdults: 3,
    });
  });

  it('keeps ages 0-3 free while billing ages 13+ as adults', () => {
    const billable = pricing.calculateBillableGuests('large', {
      adults: 2,
      kidsAges: [2, 5, 15],
    });

    assert.deepEqual(billable, {
      actualAdults: 2,
      actualKids: 3,
      capacityKids: 2,
      freeKids: 1,
      chargeableKids: 1,
      teensAsAdults: 1,
      billableAdults: 3,
      billableKids: 1,
      kidsChargedAsAdults: 0,
      emptyAdultSlots: 0,
      units: 1,
      minimumAdults: 3,
    });

    const quote = pricing.calculateStayPrice({
      roomType: 'large',
      adults: 2,
      kidsAges: [2, 5, 15],
      checkIn: '2026-05-18',
      checkOut: '2026-05-19',
      pricingTiers,
      holidays: [],
      createdOn: '2026-05-07',
    });

    assert.equal(quote.total, 4200);
  });

  it('uses total nights for the tier and the next morning for weekend or holiday rates', () => {
    const quote = pricing.calculateStayPrice({
      roomType: 'large',
      adults: 2,
      kidsAges: [6, 10],
      checkIn: '2026-05-13',
      checkOut: '2026-05-16',
      pricingTiers,
      holidays: ['2026-05-14'],
      createdOn: '2026-05-07',
    });

    assert.equal(quote.nights, 3);
    assert.equal(quote.nightsTier, 3);
    assert.equal(quote.total, 11600);
    assert.deepEqual(
      quote.nightlyBreakdown.map((night) => ({
        date: night.date,
        dayType: night.dayType,
        adultPrice: night.adultPrice,
        kidPrice: night.kidPrice,
        subtotal: night.subtotal,
      })),
      [
        { date: '2026-05-13', dayType: 'holiday', adultPrice: 1100, kidPrice: 800, subtotal: 4100 },
        { date: '2026-05-14', dayType: 'weekday', adultPrice: 900, kidPrice: 700, subtotal: 3400 },
        { date: '2026-05-15', dayType: 'holiday', adultPrice: 1100, kidPrice: 800, subtotal: 4100 },
      ],
    );
  });

  it('prices the night before a manual holiday as premium', () => {
    const quote = pricing.calculateStayPrice({
      roomType: 'small',
      adults: 2,
      kidsAges: [],
      checkIn: '2026-04-30',
      checkOut: '2026-05-01',
      pricingTiers,
      holidays: ['2026-05-01'],
      createdOn: '2026-05-07',
    });

    assert.equal(quote.total, 2600);
    assert.deepEqual(quote.nightlyBreakdown, [
      {
        date: '2026-04-30',
        dayType: 'holiday',
        adultPrice: 1300,
        kidPrice: 1000,
        billableAdults: 2,
        billableKids: 0,
        subtotal: 2600,
      },
    ]);
  });

  it('prices Sunday-to-Monday nights as standard unless the date is a manual holiday', () => {
    const quote = pricing.calculateStayPrice({
      roomType: 'small',
      adults: 2,
      kidsAges: [],
      checkIn: '2026-05-17',
      checkOut: '2026-05-18',
      pricingTiers,
      holidays: [],
      createdOn: '2026-05-07',
    });

    assert.equal(quote.total, 2200);
    assert.deepEqual(quote.nightlyBreakdown, [
      {
        date: '2026-05-17',
        dayType: 'weekday',
        adultPrice: 1100,
        kidPrice: 900,
        billableAdults: 2,
        billableKids: 0,
        subtotal: 2200,
      },
    ]);
  });

  it('selects the pricing row active on the reservation creation date', () => {
    const scheduledPrices = pricingTiers.concat({
      nights_tier: 1,
      day_type: 'weekday',
      adult_price: 1500,
      kid_price: 1200,
      effective_from: '2026-06-01',
    });

    assert.equal(
      pricing.findPricingRow(scheduledPrices, {
        nightsTier: 1,
        dayType: 'weekday',
        createdOn: '2026-05-31',
      }).adult_price,
      1100,
    );
    assert.equal(
      pricing.findPricingRow(scheduledPrices, {
        nightsTier: 1,
        dayType: 'weekday',
        createdOn: '2026-06-01',
      }).adult_price,
      1500,
    );
  });
});

describe('EcoVila Step 3 calendar and assignment core', () => {
  it('treats check-out as available for the next booking and ignores cancelled reservations', () => {
    const reservations = [
      {
        room_id: 'small-8',
        check_in: '2026-05-10',
        check_out: '2026-05-12',
        payment_status: 'paid',
        cancelled_at: null,
      },
      {
        room_id: 'small-7',
        check_in: '2026-05-10',
        check_out: '2026-05-14',
        payment_status: 'cancelled',
        cancelled_at: '2026-05-09T10:00:00Z',
      },
    ];

    assert.equal(
      calendar.isRoomAvailable({
        roomId: 'small-8',
        reservations,
        checkIn: '2026-05-12',
        checkOut: '2026-05-13',
      }),
      true,
    );
    assert.equal(
      calendar.isRoomAvailable({
        roomId: 'small-8',
        reservations,
        checkIn: '2026-05-11',
        checkOut: '2026-05-13',
      }),
      false,
    );
    assert.equal(
      calendar.isRoomAvailable({
        roomId: 'small-7',
        reservations,
        checkIn: '2026-05-11',
        checkOut: '2026-05-13',
      }),
      true,
    );
  });

  it('returns per-type availability based on the selected party size and unit count', () => {
    const reservations = rooms
      .filter((room) => room.type === 'large')
      .map((room) => ({
        room_id: room.id,
        check_in: '2026-05-20',
        check_out: '2026-05-22',
        payment_status: 'paid',
        cancelled_at: null,
      }));

    const availability = calendar.getAvailabilityByType({
      rooms,
      reservations,
      checkIn: '2026-05-20',
      checkOut: '2026-05-22',
      party: { adults: 4, kidsAges: [] },
    });

    assert.equal(availability.small.neededUnits, 2);
    assert.equal(availability.small.availableCount, 8);
    assert.equal(availability.small.isAvailable, true);
    assert.equal(availability.large.neededUnits, 1);
    assert.equal(availability.large.availableCount, 0);
    assert.equal(availability.large.isAvailable, false);
  });

  it('marks a date fully unavailable only when every fitting accommodation type is sold out', () => {
    const allRoomsBooked = rooms.map((room) => ({
      room_id: room.id,
      check_in: '2026-05-25',
      check_out: '2026-05-26',
      payment_status: 'paid',
      cancelled_at: null,
    }));

    assert.deepEqual(
      calendar.getUnavailableDates({
        rooms,
        reservations: allRoomsBooked,
        startDate: '2026-05-25',
        days: 2,
        party: { adults: 2, kidsAges: [] },
      }),
      ['2026-05-25'],
    );
  });

  it('auto-assigns small villas decreasing and large villas or hotel rooms increasing', () => {
    const reservations = [
      {
        room_id: 'small-8',
        check_in: '2026-06-01',
        check_out: '2026-06-03',
        payment_status: 'paid',
        cancelled_at: null,
      },
    ];

    assert.deepEqual(
      calendar.chooseRoomsForAssignment({
        rooms,
        reservations,
        type: 'small',
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        party: { adults: 4, kidsAges: [] },
      }).roomNumbers,
      [7, 6],
    );

    assert.deepEqual(
      calendar.chooseRoomsForAssignment({
        rooms,
        reservations: [],
        type: 'large',
        checkIn: '2026-06-01',
        checkOut: '2026-06-03',
        party: { adults: 4, kidsAges: [] },
      }).roomNumbers,
      [9],
    );
  });
});

describe('EcoVila Step 3 Supabase helper', () => {
  it('creates one Supabase browser client from runtime config and reuses it', () => {
    const calls = [];
    const fakeSupabase = {
      createClient(url, anonKey, options) {
        calls.push({ url, anonKey, options });
        return { url, anonKey };
      },
    };
    const root = {
      EcoVilaSupabaseConfig: {
        url: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
      },
      supabase: fakeSupabase,
    };

    const first = supabaseHelpers.getSupabaseClient({ root });
    const second = supabaseHelpers.getSupabaseClient({ root });

    assert.equal(first, second);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.auth, {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    });
  });

  it('fetches public availability blocks through RPC instead of selecting guest reservations directly', async () => {
    const calls = [];
    const client = {
      rpc(name, params) {
        calls.push({ name, params });
        return Promise.resolve({
          data: [{ room_id: 'small-1', check_in: '2026-07-01', check_out: '2026-07-03' }],
          error: null,
        });
      },
    };

    const blocks = await supabaseHelpers.fetchAvailabilityBlocks(client, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });

    assert.deepEqual(blocks, [{ room_id: 'small-1', check_in: '2026-07-01', check_out: '2026-07-03' }]);
    assert.deepEqual(calls, [
      {
        name: 'get_public_availability_blocks',
        params: { range_start: '2026-07-01', range_end: '2026-07-31' },
      },
    ]);
  });
});
