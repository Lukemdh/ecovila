import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const migrationPath = path.join(
  root,
  'docs/supabase/migrations/20260506210000_supabase_foundation.sql',
);

function readMigration() {
  return fs.readFileSync(migrationPath, 'utf8');
}

function readAllMigrations() {
  return fs
    .readdirSync(path.dirname(migrationPath))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => fs.readFileSync(path.join(path.dirname(migrationPath), file), 'utf8'))
    .join('\n');
}

function availabilityRpcSql(sql) {
  const match = sql.match(
    /create or replace function public\.get_public_availability_blocks[\s\S]*?\$\$;/i,
  );
  return match ? match[0] : '';
}

describe('EcoVila Supabase foundation migration', () => {
  it('creates the required database foundation file', () => {
    assert.ok(fs.existsSync(migrationPath), 'Supabase foundation migration should exist');
  });

  it('creates all Step 2 tables with RLS enabled', () => {
    const sql = readMigration();
    const tables = [
      'rooms',
      'pricing_tiers',
      'holidays',
      'reservations',
      'cancellation_tokens',
    ];

    for (const table of tables) {
      assert.match(
        sql,
        new RegExp(`create table if not exists public\\.${table}\\b`, 'i'),
        `${table} table should be created`,
      );
      assert.match(
        sql,
        new RegExp(`alter table public\\.${table}\\s+enable row level security`, 'i'),
        `${table} should have RLS enabled`,
      );
    }
  });

  it('models the required reservation and pricing business constraints', () => {
    const sql = readMigration();
    const allSql = readAllMigrations();

    assert.match(sql, /type text not null/i, 'rooms.type should be required');
    assert.match(sql, /number integer not null unique/i, 'rooms.number should be unique');
    assert.match(sql, /type in \('small', 'large', 'hotel'\)/i, 'room type should be constrained');
    assert.match(sql, /nights_tier in \(1, 2, 3\)/i, 'pricing tier should be constrained');
    assert.match(sql, /day_type in \('weekday', 'holiday'\)/i, 'day type should be constrained');
    assert.match(allSql, /payment_type in \('cash', 'card', 'office'\)/i, 'payment type should be constrained');
    assert.match(
      sql,
      /payment_status in \('pending', 'paid', 'cancelled'\)/i,
      'payment status should be constrained',
    );
    assert.match(sql, /created_by in \('guest', 'diana'\)/i, 'reservation creator should be constrained');
    assert.match(sql, /check_out > check_in/i, 'reservations should be night-based');
    assert.match(
      allSql,
      /guest_phone ~ '\^\\\+\[0-9\]\{8,15\}\$'/i,
      'guest phone format should allow validated international numbers',
    );
    assert.match(
      sql,
      /token text not null unique default encode\(gen_random_bytes\(32\), 'hex'\)/i,
      'cancellation tokens should default to a secure random value',
    );
    assert.match(
      allSql,
      /holidays_recurring_month_day_unique_idx[\s\S]+extract\(month from date\)[\s\S]+extract\(day from date\)/i,
      'manual holidays should be unique by recurring month and day',
    );
  });

  it('seeds exactly 25 rooms with the correct number ranges and types', () => {
    const sql = readMigration();
    const roomTuples = [...sql.matchAll(/\((\d+), '(small|large|hotel)'\)/g)].map((match) => ({
      number: Number(match[1]),
      type: match[2],
    }));

    assert.equal(roomTuples.length, 25, 'rooms seed should contain 25 room rows');
    assert.deepEqual(
      roomTuples.filter((room) => room.type === 'small').map((room) => room.number),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'small villas should be rooms 1-8',
    );
    assert.deepEqual(
      roomTuples.filter((room) => room.type === 'large').map((room) => room.number),
      [9, 10, 11, 12, 13, 14, 15],
      'large villas should be rooms 9-15',
    );
    assert.deepEqual(
      roomTuples.filter((room) => room.type === 'hotel').map((room) => room.number),
      [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
      'hotel rooms should be rooms 16-25',
    );
  });

  it('seeds the initial six pricing rows from the brief', () => {
    const sql = readMigration();
    const pricingRows = [...sql.matchAll(/\((1|2|3), '(weekday|holiday)', (\d+), (\d+), date '2026-05-06'\)/g)].map(
      (match) => [Number(match[1]), match[2], Number(match[3]), Number(match[4])],
    );

    assert.deepEqual(pricingRows, [
      [1, 'weekday', 1100, 900],
      [1, 'holiday', 1300, 1000],
      [2, 'weekday', 1000, 800],
      [2, 'holiday', 1200, 900],
      [3, 'weekday', 900, 700],
      [3, 'holiday', 1100, 800],
    ]);
  });

  it('adds role-aware policies for public guests, Diana, and Angela', () => {
    const sql = readMigration();

    assert.match(sql, /create or replace function public\.ecovila_app_role\(\)/i);
    assert.match(sql, /auth\.jwt\(\) -> 'app_metadata' ->> 'role'/i);

    for (const table of ['rooms', 'pricing_tiers', 'holidays']) {
      assert.match(
        sql,
        new RegExp(`create policy "Public can read ${table}"`, 'i'),
        `public guests should be able to read ${table}`,
      );
    }

    assert.match(
      sql,
      /create policy "Public can create guest reservations"[\s\S]+on public\.reservations[\s\S]+for insert[\s\S]+to anon, authenticated[\s\S]+created_by = 'guest'[\s\S]+payment_status = 'pending'[\s\S]+adults >= 1/i,
      'public guests should only create pending guest reservations with at least one adult',
    );
    assert.match(
      sql,
      /create policy "Diana can manage reservations"[\s\S]+ecovila_app_role\(\) = 'diana'/i,
      'Diana should be able to manage reservations',
    );
    assert.match(
      sql,
      /create policy "Angela can read reservations"[\s\S]+ecovila_app_role\(\) = 'angela'/i,
      'Angela should have future read-only reservation access',
    );
    assert.doesNotMatch(
      sql,
      /create policy "Public can read reservations"/i,
      'public guests should not be able to select reservations directly',
    );
    assert.match(
      sql,
      /create or replace function public\.get_reservation_by_cancellation_token\(lookup_token text\)/i,
      'cancellation-token lookup function should exist for guest-owned reservation lookup',
    );
  });

  it('adds a public-safe availability RPC without exposing guest reservation details', () => {
    const sql = readAllMigrations();
    const availabilityRpc = availabilityRpcSql(sql);

    assert.match(
      sql,
      /create or replace function public\.get_public_availability_blocks\(range_start date,\s*range_end date\)/i,
      'public availability RPC should exist for booking calendar checks',
    );
    assert.match(sql, /security definer/i, 'availability RPC should read active reservation blocks despite RLS');
    assert.match(
      sql,
      /returns table \(\s*room_id uuid,\s*check_in date,\s*check_out date\s*\)/i,
      'availability RPC should expose only room/date occupancy fields',
    );
    assert.match(
      sql,
      /payment_status in \('pending', 'paid'\)[\s\S]+cancelled_at is null/i,
      'availability RPC should include only active pending or paid reservations',
    );
    assert.match(
      sql,
      /grant execute on function public\.get_public_availability_blocks\(date, date\) to anon, authenticated/i,
      'public users should be able to call the availability RPC',
    );
    assert.doesNotMatch(
      availabilityRpc,
      /guest_first_name/i,
      'availability RPC should not leak guest names',
    );
    assert.doesNotMatch(
      availabilityRpc,
      /guest_phone/i,
      'availability RPC should not leak guest phone numbers',
    );
  });
});
