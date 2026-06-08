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
  it('normalizes selected child ages into free children, child-fee children, and adult-fee children', () => {
    const party = pricing.normalizeParty({ adults: 2, kidsAges: [2, 5, 12, 17] });

    assert.deepEqual(party, {
      adults: 2,
      kidsAges: [2, 5, 12, 17],
      freeChildAges: [2],
      chargeableKidAges: [5],
      teenAges: [12, 17],
      kids: 4,
      freeKids: 1,
      chargeableKids: 1,
      teensAsAdults: 2,
      overflowKids: 0,
      effectiveAdults: 2,
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
      pricing.validateParty({ adults: 1, kidsAges: [1, 17] }).valid,
      true,
      'public child age selector should allow ages 1-17',
    );
    assert.equal(
      pricing.validateParty({ adults: 1, kidsAges: [18] }).valid,
      false,
      'age 18 should be entered as an adult, not as a child',
    );
    assert.equal(
      pricing.validateParty({ adults: 1, kidsAges: [0] }).valid,
      false,
      'child ages should start at 1',
    );
  });

  it('calculates room units needed for groups larger than one accommodation unit', () => {
    assert.equal(pricing.getUnitsNeeded('small', { adults: 4, kidsAges: [] }), 2);
    assert.equal(pricing.getUnitsNeeded('large', { adults: 4, kidsAges: [5, 8] }), 1);
    assert.equal(pricing.getUnitsNeeded('hotel', { adults: 2, kidsAges: [3, 7, 9] }), 2);
    assert.equal(
      pricing.getUnitsNeeded('small', { adults: 2, kidsAges: [12, 17] }),
      1,
      'children aged 12-17 should still fit in child capacity',
    );
    assert.equal(
      pricing.getUnitsNeeded('hotel', { adults: 2, kidsAges: [12, 17] }),
      1,
      'hotel rooms should also allow two adults and two 12-17 year old children',
    );
    assert.equal(
      pricing.getUnitsNeeded('large', { adults: 1, kidsAges: [2, 5, 9, 10] }),
      1,
      'a large villa can use open adult slots for the oldest children while keeping one actual adult',
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

    assert.deepEqual(pricing.calculateBillableGuests('large', { adults: 1, kidsAges: [2, 5, 9, 10] }), {
      actualAdults: 1,
      actualKids: 4,
      capacityKids: 4,
      freeKids: 1,
      chargeableKids: 3,
      teensAsAdults: 0,
      billableAdults: 3,
      billableKids: 1,
      kidsChargedAsAdults: 2,
      emptyAdultSlots: 0,
      units: 1,
      minimumAdults: 3,
    });
  });

  it('keeps ages 1-3 free, bills ages 4-11 as children, and bills ages 12-17 as adult fee without adult classification', () => {
    assert.deepEqual(pricing.calculateBillableGuests('small', { adults: 2, kidsAges: [12, 17] }), {
      actualAdults: 2,
      actualKids: 2,
      capacityKids: 2,
      freeKids: 0,
      chargeableKids: 0,
      teensAsAdults: 2,
      billableAdults: 4,
      billableKids: 0,
      kidsChargedAsAdults: 2,
      emptyAdultSlots: 0,
      units: 1,
      minimumAdults: 2,
    });

    const billable = pricing.calculateBillableGuests('large', {
      adults: 2,
      kidsAges: [3, 11, 12],
    });

    assert.deepEqual(billable, {
      actualAdults: 2,
      actualKids: 3,
      capacityKids: 3,
      freeKids: 1,
      chargeableKids: 1,
      teensAsAdults: 1,
      billableAdults: 3,
      billableKids: 1,
      kidsChargedAsAdults: 1,
      emptyAdultSlots: 0,
      units: 1,
      minimumAdults: 3,
    });

    const quote = pricing.calculateStayPrice({
      roomType: 'large',
      adults: 2,
      kidsAges: [3, 11, 12],
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

  it('treats manual holidays as recurring day and month dates across years', () => {
    const quote = pricing.calculateStayPrice({
      roomType: 'small',
      adults: 2,
      kidsAges: [],
      checkIn: '2027-05-13',
      checkOut: '2027-05-14',
      pricingTiers,
      holidays: [{ date: '2026-05-14', label: 'Zi de test' }],
      createdOn: '2026-05-07',
    });

    assert.equal(quote.total, 2600);
    assert.deepEqual(quote.nightlyBreakdown.map((night) => night.dayType), ['holiday']);
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

  it('selects the pricing row by the night being booked, not the booking date', () => {
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
        stayDate: '2026-05-31',
      }).adult_price,
      1100,
    );
    assert.equal(
      pricing.findPricingRow(scheduledPrices, {
        nightsTier: 1,
        dayType: 'weekday',
        stayDate: '2026-06-01',
      }).adult_price,
      1500,
    );
  });

  it('applies a future scheduled price to a stay booked before it takes effect', () => {
    const scheduledPrices = pricingTiers.concat([
      { nights_tier: 1, day_type: 'weekday', adult_price: 1500, kid_price: 1200, effective_from: '2026-10-01' },
      { nights_tier: 1, day_type: 'holiday', adult_price: 1700, kid_price: 1300, effective_from: '2026-10-01' },
    ]);

    // Booking made now (June) for a night before Oct 1 keeps the old price.
    const beforeSwitch = pricing.calculateStayPrice({
      roomType: 'small',
      adults: 2,
      kidsAges: [],
      checkIn: '2026-09-28',
      checkOut: '2026-09-29',
      pricingTiers: scheduledPrices,
      holidays: [],
      createdOn: '2026-06-04',
    });
    assert.equal(beforeSwitch.total, 2200);

    // Booking made now (June) for a night on/after Oct 1 gets the new price.
    const afterSwitch = pricing.calculateStayPrice({
      roomType: 'small',
      adults: 2,
      kidsAges: [],
      checkIn: '2026-10-05',
      checkOut: '2026-10-06',
      pricingTiers: scheduledPrices,
      holidays: [],
      createdOn: '2026-06-04',
    });
    assert.equal(afterSwitch.total, 3000);
  });

  it('falls back to the earliest published price for nights before any schedule', () => {
    assert.equal(
      pricing.findPricingRow(pricingTiers, {
        nightsTier: 1,
        dayType: 'weekday',
        stayDate: '2026-04-30',
      }).adult_price,
      1100,
    );
  });

  it('uses the newest same-date price row when CRM saves the same effective date again', () => {
    const duplicateSameDatePrices = [
      {
        nights_tier: 1,
        day_type: 'weekday',
        adult_price: 1100,
        kid_price: 900,
        effective_from: '2026-05-08',
        created_at: '2026-05-08T09:00:00.000Z',
      },
      {
        nights_tier: 1,
        day_type: 'weekday',
        adult_price: 1300,
        kid_price: 600,
        effective_from: '2026-05-08',
        created_at: '2026-05-08T10:00:00.000Z',
      },
    ];

    assert.deepEqual(
      pricing.findPricingRow(duplicateSameDatePrices, {
        nightsTier: 1,
        dayType: 'weekday',
        createdOn: '2026-05-09',
      }),
      duplicateSameDatePrices[1],
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

  it('allows a sold-out date as checkout when the previous night is available', () => {
    const allRoomsBooked = rooms.map((room) => ({
      room_id: room.id,
      check_in: '2026-05-27',
      check_out: '2026-05-31',
      payment_status: 'paid',
      cancelled_at: null,
    }));
    const party = { adults: 2, kidsAges: [] };

    assert.deepEqual(
      calendar.getDateSelectionState({
        rooms,
        reservations: allRoomsBooked,
        date: '2026-05-27',
        party,
      }),
      {
        isSelectable: false,
        isUnavailable: true,
      },
    );
    assert.deepEqual(
      calendar.getDateSelectionState({
        rooms,
        reservations: allRoomsBooked,
        date: '2026-05-27',
        checkIn: '2026-05-26',
        checkOut: '',
        party,
      }),
      {
        isSelectable: true,
        isUnavailable: false,
      },
    );
    assert.deepEqual(
      calendar.getDateSelectionState({
        rooms,
        reservations: allRoomsBooked,
        date: '2026-05-28',
        checkIn: '2026-05-26',
        checkOut: '',
        party,
      }),
      {
        isSelectable: false,
        isUnavailable: true,
      },
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

  it('passes a custom auth storage adapter into the Supabase browser client', () => {
    const calls = [];
    const authStorage = {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    };
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

    supabaseHelpers.getSupabaseClient({ root, authStorage });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.auth.storage, authStorage);
    assert.equal(calls[0].options.auth.persistSession, true);
    assert.equal(calls[0].options.auth.autoRefreshToken, true);
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

  it('upserts pricing rows by tier, day type, and effective date', async () => {
    const calls = [];
    const client = {
      from(table) {
        calls.push({ method: 'from', table });
        return {
          upsert(rows, options) {
            calls.push({ method: 'upsert', rows, options });
            return {
              select() {
                calls.push({ method: 'select' });
                return Promise.resolve({ data: rows, error: null });
              },
            };
          },
        };
      },
    };
    const rows = [
      {
        nights_tier: 1,
        day_type: 'weekday',
        adult_price: 1100,
        kid_price: 850,
        effective_from: '2026-06-01',
      },
    ];

    const saved = await supabaseHelpers.insertPricingRows(client, rows);

    assert.deepEqual(saved, rows);
    assert.deepEqual(calls, [
      { method: 'from', table: 'pricing_tiers' },
      {
        method: 'upsert',
        rows,
        options: { onConflict: 'nights_tier,day_type,effective_from' },
      },
      { method: 'select' },
    ]);
  });
});
