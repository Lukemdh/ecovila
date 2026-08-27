import { assertEquals, assertMatch } from 'std/assert';
import { HttpError } from '../_shared/http.ts';
import { reservationAccommodationMoveSms } from '../_shared/notifications.ts';
import { toMoveHttpError } from '../reservation-accommodation-move/index.ts';

const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const MIGRATION_URL = new URL(
  '../../migrations/20260827120000_payment_link_reservation_binding.sql',
  import.meta.url,
);

async function loadMigrationSql() {
  const response = await fetch(MIGRATION_URL);
  if (!response.ok) throw new Error(`Could not load ADR-107 migration: ${response.status}`);
  return await response.text();
}

Deno.test('accommodation-move SMS stays within one segment in all three languages', () => {
  for (const language of ['ro', 'ru', 'en']) {
    const message = reservationAccommodationMoveSms({ language, roomType: 'hotel' });
    const limit = language === 'ru' ? 70 : 160;
    assertEquals(message.length <= limit, true, `${language}: ${message.length}: ${message}`);
    assertMatch(message, /EcoVila/);

    if (language !== 'ru') {
      assertEquals(
        [...message].filter((character) => !GSM7.includes(character)),
        [],
        `${language} accommodation-move SMS must stay GSM-7`,
      );
    }
  }
});

Deno.test('accommodation-move SQLSTATE mapping returns Romanian 409 conflicts', () => {
  const cases = [
    {
      code: '23P01',
      message: 'conflicting key value violates exclusion constraint',
      expected: 'tocmai a fost ocupată',
    },
    {
      code: 'P0002',
      message: 'Reservation is no longer live in the expected source room',
      expected: 'nu mai este activă',
    },
    {
      code: 'P0001',
      message: 'Accommodation difference billing requires a paid reservation',
      expected: 'rezervare achitată',
    },
    {
      code: 'P0001',
      message: 'Accommodation difference billing requires a different room type',
      expected: 'schimbarea tipului de cazare',
    },
    {
      code: 'P0001',
      message: 'Target accommodation is inactive',
      expected: 'nu mai este activă',
    },
    {
      code: 'P0001',
      message: 'A pending reservation change must be resolved before moving accommodation',
      expected: 'modificare de oaspeți în așteptare',
    },
  ];

  for (const testCase of cases) {
    const mapped = toMoveHttpError({ code: testCase.code, message: testCase.message });
    assertEquals(mapped instanceof HttpError, true);
    if (mapped instanceof HttpError) {
      assertEquals(mapped.status, 409);
      assertMatch(mapped.message, new RegExp(testCase.expected));
    }
  }
});

Deno.test('move SQL locks the prior bill and refuses replacement while its provider attempt is live', async () => {
  const sql = await loadMigrationSql();

  assertMatch(
    sql,
    /where l\.id = v_previous_payment_link_id\s+for update;/,
  );
  assertMatch(
    sql,
    /a\.payment_link_id = v_previous_payment_link_id\s+and a\.status in \('creating', 'pending'\)/,
  );
  assertMatch(
    sql,
    /raise exception 'Outstanding accommodation difference payment link is being processed; wait for it to finish or revoke it before issuing a replacement'\s+using errcode = 'P0001'/,
  );
});

Deno.test('reservation repricing SQL trigger is narrow, security-definer, and checks every difference link', async () => {
  const sql = await loadMigrationSql();

  assertMatch(
    sql,
    /function public\.prevent_repricing_with_accommodation_difference\(\)[\s\S]*?security definer[\s\S]*?l\.purpose = 'accommodation_difference'[\s\S]*?l\.reservation_id = old\.id/,
  );
  assertMatch(
    sql,
    /create trigger prevent_repricing_with_accommodation_difference\s+before update of total_price on public\.reservations\s+for each row\s+when \(new\.total_price is distinct from old\.total_price\)/,
  );
});
