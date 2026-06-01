import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { isRefundEligible, normalizeInternationalPhone } = require('../js/anulare.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function latestCancellationRpcSql() {
  const migrationDir = path.join(root, 'supabase/migrations');
  const sql = fs
    .readdirSync(migrationDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => fs.readFileSync(path.join(migrationDir, file), 'utf8'))
    .join('\n');

  const matches = [...sql.matchAll(
    /create or replace function public\.cancel_reservation_by_token[\s\S]*?\$\$;/gi,
  )];

  return matches.at(-1)?.[0] || '';
}

describe('EcoVila cancellation policy alignment', () => {
  it('explains the online cancellation window and cash office reimbursement on the page', () => {
    const html = read('anulare.html');

    assert.doesNotMatch(html, /72\s*(de\s*)?ore|72\+/i);
    assert.match(html, /data-anulare-refund-note/);
    assert.match(html, /cel puțin 7 zile calendaristice/i);
    assert.match(html, /mai puțin de 2 ore/i);
    assert.match(html, /cash[\s\S]*oficiu/i);
  });

  it('handles server-side late and cash-office online cancellation refusals', () => {
    const js = read('js/anulare.js');

    assert.doesNotMatch(js, /isWithin72Hours/);
    assert.doesNotMatch(js, /showTooLate/);
    assert.match(js, /case 'too_late'/);
    assert.match(js, /case 'cash_office'/);
    assert.match(js, /isRefundEligible/);
    assert.match(js, /updateRefundNote/);
  });

  it('normalizes international phone numbers for cancellation confirmation', () => {
    assert.equal(normalizeInternationalPhone(' +40 721 234 567 '), '+40721234567');
  });

  it('treats the exact seventh calendar day and fresh bookings as refundable in EcoVila time', () => {
    const noonUtcOnMay16 = new Date('2026-05-16T12:00:00Z');

    assert.equal(isRefundEligible('2026-05-23', noonUtcOnMay16), true);
    assert.equal(isRefundEligible('2026-05-22', noonUtcOnMay16), false);
    assert.equal(
      isRefundEligible('2026-05-30', noonUtcOnMay16, '2026-05-16T10:30:00.000Z'),
      true,
    );
  });

  it('keeps translations aligned with the 7-day refundable and non-refundable messages', () => {
    const translations = read('js/translations.js');

    assert.match(translations, /anulare\.refundEligibleNote/);
    assert.match(translations, /anulare\.refundIneligibleNote/);
    assert.match(translations, /anulare\.tooLateText/);
    assert.match(translations, /anulare\.cashOfficeNote/);
    assert.doesNotMatch(translations, /72\+\s*hours|72\+\s*ore|72\+\s*часа/i);
  });

  it('enforces the online cancellation window and cash-office rule in the latest RPC definition', () => {
    const rpc = latestCancellationRpcSql();

    assert.ok(rpc, 'latest cancel_reservation_by_token RPC should exist');
    assert.doesNotMatch(rpc, /72\s+hours/i);
    assert.match(rpc, /v_payment_type/i);
    assert.match(rpc, /v_created_at/i);
    assert.match(rpc, /return 'cash_office';/i);
    assert.match(rpc, /return 'too_late';/i);
    assert.match(rpc, /now\(\) >= v_created_at/i);
    assert.match(rpc, /interval '2 hours'/i);
    assert.match(rpc, /return 'cancelled';/i);
  });
});
