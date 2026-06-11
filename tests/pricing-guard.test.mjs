import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('Server-side reservation pricing guard', () => {
  it('keeps the Edge Function pricing module byte-identical to the browser module', () => {
    assert.equal(
      read('supabase/functions/_shared/pricing.js'),
      read('js/pricing.js'),
      'supabase/functions/_shared/pricing.js must be an exact copy of js/pricing.js — re-run: cp js/pricing.js supabase/functions/_shared/pricing.js',
    );
  });

  it('recomputes and enforces the price inside create-reservation', () => {
    const guard = read('supabase/functions/_shared/pricingGuard.ts');
    const createReservation = read('supabase/functions/create-reservation/index.ts');

    assert.match(
      createReservation,
      /priceGuard:\s*\(rows\)\s*=>\s*verifyReservationGroupPricing\(client,\s*rows\)/,
      'create-reservation must run the server-side pricing guard',
    );
    assert.match(guard, /calculateStayPrice/, 'guard must recompute the stay price');
    assert.match(
      guard,
      /clientTotal\s*!==\s*expectedTotal/,
      'guard must compare client total against the recomputed total',
    );
    assert.doesNotMatch(
      guard,
      /\.gte\('date'|\.lte\('date'/,
      'guard must load all holidays because they are recurring month-day rules',
    );
  });

  it('revokes the direct anon insert path on reservations', () => {
    const migration = read(
      'supabase/migrations/20260611120000_revoke_public_reservation_insert.sql',
    );

    assert.match(
      migration,
      /drop policy if exists "Public can create guest reservations" on public\.reservations/,
      'the public insert policy must be dropped',
    );
    assert.match(
      migration,
      /revoke insert on public\.reservations from anon/,
      'anon must lose the reservations insert grant',
    );
  });
});
