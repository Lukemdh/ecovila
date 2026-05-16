import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { isRefundEligible } = require('../../js/anulare.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function latestCancellationRpcSql() {
  const migrationDir = path.join(root, 'docs/supabase/migrations');
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
  it('keeps online cancellation available and explains the 7-day refund split on the page', () => {
    const html = read('anulare.html');

    assert.doesNotMatch(html, /data-anulare-too-late/);
    assert.doesNotMatch(html, /72\s*(de\s*)?ore|72\+/i);
    assert.match(html, /data-anulare-refund-note/);
    assert.match(html, /cel puțin 7 zile calendaristice/i);
    assert.match(html, /mai puțin de 7 zile calendaristice/i);
  });

  it('uses refund eligibility copy instead of a 72-hour client-side cancellation block', () => {
    const js = read('js/anulare.js');

    assert.doesNotMatch(js, /isWithin72Hours/);
    assert.doesNotMatch(js, /showTooLate/);
    assert.doesNotMatch(js, /case 'too_late'/);
    assert.match(js, /isRefundEligible/);
    assert.match(js, /updateRefundNote/);
  });

  it('treats the exact seventh calendar day as refundable in EcoVila time', () => {
    const noonUtcOnMay16 = new Date('2026-05-16T12:00:00Z');

    assert.equal(isRefundEligible('2026-05-23', noonUtcOnMay16), true);
    assert.equal(isRefundEligible('2026-05-22', noonUtcOnMay16), false);
  });

  it('keeps translations aligned with the 7-day refundable and non-refundable messages', () => {
    const translations = read('js/translations.js');

    assert.match(translations, /anulare\.refundEligibleNote/);
    assert.match(translations, /anulare\.refundIneligibleNote/);
    assert.doesNotMatch(translations, /anulare\.tooLateTitle/);
    assert.doesNotMatch(translations, /anulare\.tooLateText/);
    assert.doesNotMatch(translations, /72\+\s*hours|72\+\s*ore|72\+\s*часа/i);
  });

  it('removes the server-side late-cancellation refusal from the latest RPC definition', () => {
    const rpc = latestCancellationRpcSql();

    assert.ok(rpc, 'latest cancel_reservation_by_token RPC should exist');
    assert.doesNotMatch(rpc, /too_late/i);
    assert.doesNotMatch(rpc, /72\s+hours/i);
    assert.match(rpc, /return 'cancelled';/i);
  });
});
