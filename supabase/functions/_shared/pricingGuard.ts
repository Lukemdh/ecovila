// Server-side price recomputation for public reservations. The browser quote is
// advisory only: this guard recomputes the stay total from the database state
// (rooms, pricing_tiers, holidays) and rejects any client-sent total that does
// not match, so a tampered localStorage/total_price can never reach MAIB.
import { HttpError } from './http.ts';
import './pricing.js';
import type { ReservationRow } from './reservations.ts';
import type { SupabaseClient, SupabaseQueryResult } from './supabaseAdmin.ts';

type StayQuote = {
  total: number;
};

type PricingApi = {
  ROOM_TYPES: Record<string, unknown>;
  parseISODate(value: string): Date;
  calculateStayPrice(input: {
    roomType: string;
    adults: number;
    kidsAges: number[];
    checkIn: string;
    checkOut: string;
    units: number;
    pricingTiers: PricingTierRow[];
    holidays: HolidayRow[];
  }): StayQuote;
};

export type RoomRow = {
  id: string;
  type: string;
  is_active: boolean;
};

export type PricingTierRow = {
  nights_tier: number;
  day_type: string;
  adult_price: number;
  kid_price: number;
  effective_from: string;
  created_at?: string;
};

export type HolidayRow = {
  date: string;
};

type SelectBuilder<T> = PromiseLike<SupabaseQueryResult<T>> & {
  select(columns: string): SelectBuilder<T>;
  in(column: string, values: unknown[]): SelectBuilder<T>;
  order(column: string, options?: Record<string, unknown>): SelectBuilder<T>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROOMS_PER_BOOKING = 10;
const MAX_STAY_NIGHTS = 365;

export function getPricing(): PricingApi {
  const pricing = (globalThis as { EcoVilaPricing?: PricingApi }).EcoVilaPricing;

  if (!pricing) {
    throw new Error('EcoVila pricing module failed to load.');
  }

  return pricing;
}

export async function verifyReservationGroupPricing(
  client: SupabaseClient,
  rows: ReservationRow[],
): Promise<ReservationRow[]> {
  const pricing = getPricing();
  const first = rows[0];

  if (rows.length > MAX_ROOMS_PER_BOOKING) {
    throw new HttpError(400, 'Too many rooms in a single booking.');
  }

  for (const row of rows) {
    if (
      row.check_in !== first.check_in ||
      row.check_out !== first.check_out ||
      row.adults !== first.adults ||
      JSON.stringify(row.kids_ages) !== JSON.stringify(first.kids_ages) ||
      row.payment_type !== first.payment_type
    ) {
      throw new HttpError(400, 'All rooms in a booking must share the same stay details.');
    }
  }

  const nights = Math.round(
    (pricing.parseISODate(first.check_out).getTime() -
      pricing.parseISODate(first.check_in).getTime()) / DAY_MS,
  );
  if (nights > MAX_STAY_NIGHTS) {
    throw new HttpError(400, 'Stays longer than one year cannot be booked online.');
  }

  const roomIds = rows.map((row) => row.room_id);
  if (new Set(roomIds).size !== roomIds.length) {
    throw new HttpError(400, 'Each room can appear only once in a booking.');
  }

  const rooms = await fetchRooms(client, roomIds);
  const roomType = rooms[0]?.type || '';

  if (rooms.length !== roomIds.length || rooms.some((room) => room.is_active === false)) {
    throw new HttpError(400, 'One or more selected rooms are not available for booking.');
  }

  if (!pricing.ROOM_TYPES[roomType] || rooms.some((room) => room.type !== roomType)) {
    throw new HttpError(400, 'All rooms in a booking must be of the same accommodation type.');
  }

  const [pricingTiers, holidays] = await Promise.all([
    fetchPricingTiers(client),
    fetchHolidays(client),
  ]);

  if (!pricingTiers.length) {
    throw new Error('No pricing tiers are configured.');
  }

  const quote = pricing.calculateStayPrice({
    roomType,
    adults: first.adults,
    kidsAges: first.kids_ages,
    checkIn: first.check_in,
    checkOut: first.check_out,
    units: rows.length,
    pricingTiers,
    holidays,
  });
  const expectedTotal = Math.round(quote.total);
  const clientTotal = rows.reduce((sum, row) => sum + Number(row.total_price || 0), 0);

  if (clientTotal !== expectedTotal) {
    console.error('Reservation price mismatch rejected', {
      expectedTotal,
      clientTotal,
      roomType,
      checkIn: first.check_in,
      checkOut: first.check_out,
      adults: first.adults,
      kidsAges: first.kids_ages,
      units: rows.length,
    });
    throw new HttpError(
      409,
      'Reservation total does not match current pricing. Please refresh the page and try again.',
    );
  }

  const serverParts = splitTotal(expectedTotal, rows.length);

  return rows.map((row, index) => ({
    ...row,
    total_price: serverParts[index],
  }));
}

export function splitTotal(total: number, count: number) {
  const normalizedCount = Math.max(1, count);
  const normalizedTotal = Math.max(0, Math.round(total));
  const base = Math.floor(normalizedTotal / normalizedCount);
  const remainder = normalizedTotal - base * normalizedCount;

  return Array.from(
    { length: normalizedCount },
    (_item, index) => base + (index === 0 ? remainder : 0),
  );
}

export async function fetchRooms(client: SupabaseClient, roomIds: string[]) {
  const { data, error } = await (client.from('rooms') as SelectBuilder<RoomRow[]>)
    .select('id, type, is_active')
    .in('id', roomIds);

  if (error) {
    throw new Error(error.message || 'Could not load rooms for pricing.');
  }

  return data || [];
}

export async function fetchPricingTiers(client: SupabaseClient) {
  const { data, error } = await (client.from('pricing_tiers') as SelectBuilder<PricingTierRow[]>)
    .select('nights_tier, day_type, adult_price, kid_price, effective_from, created_at')
    .order('effective_from', { ascending: true });

  if (error) {
    throw new Error(error.message || 'Could not load pricing tiers.');
  }

  return data || [];
}

export async function fetchHolidays(client: SupabaseClient) {
  // Holidays are recurring month-day rules, so every row applies regardless of
  // the stored year — never filter by date range here.
  const { data, error } = await (client.from('holidays') as SelectBuilder<HolidayRow[]>)
    .select('date')
    .order('date', { ascending: true });

  if (error) {
    throw new Error(error.message || 'Could not load holidays.');
  }

  return data || [];
}
