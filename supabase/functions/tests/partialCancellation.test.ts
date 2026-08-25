// Partial cancellation (ADR-104). Staff drop SOME villas of a booking and return
// a manually typed amount, so the guest must be told what is gone, what stands,
// and how much came back — never the plain "your reservation is cancelled".
// These also pin the dedup-owner rule that keeps a mixed group (live rows next to
// cancelled ones) from re-sending scheduled notifications.
import { assert, assertEquals } from 'std/assert';
import {
  buildCancellationEmail,
  buildPartialCancellationEmail,
  cancellationConfirmationSms,
  partialCancellationSms,
  resolveStableGroupOwnerIds,
} from '../_shared/notifications.ts';
import type { SupabaseClient } from '../_shared/supabaseAdmin.ts';

Deno.test('partial cancellation email names what was dropped, what stands and the refund', () => {
  const email = buildPartialCancellationEmail({
    lang: 'ro',
    firstName: 'Vera',
    cancelledCopy: 'Căsuță mică',
    remainingCopy: '2× Căsuță mare',
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 850,
    withheldCommission: 12,
    manageUrl: 'https://ecovila.md/rezervari.html#reservation-lookup-title',
    siteUrl: 'https://ecovila.md',
  });

  // The subject must not read as a cancellation: the guest is still coming.
  assert(!email.subject.toLowerCase().includes('anulat'), email.subject);
  assert(email.html.includes('Căsuță mică'));
  assert(email.html.includes('2× Căsuță mare'));
  assert(email.text.includes('Rămâne rezervat: 2× Căsuță mare'));
  assert(email.text.includes('Sumă restituită: 850 MDL'));
  assert(email.text.includes('Comision de procesare reținut: 12 MDL'));
  // The refund note only earns its place when money actually moved.
  assert(email.text.includes('1–5 zile lucrătoare'));
});

Deno.test('partial cancellation email drops the refund row when nothing was returned', () => {
  const email = buildPartialCancellationEmail({
    lang: 'en',
    firstName: 'Ana',
    cancelledCopy: 'Hotel room',
    remainingCopy: 'Small cabin',
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 0,
    manageUrl: 'https://ecovila.md/rezervari.html',
    siteUrl: 'https://ecovila.md',
  });

  assert(!email.text.includes('Refunded:'), email.text);
  assert(!email.text.includes('business days'), email.text);
  assert(email.text.includes('Still booked: Small cabin'));
});

// GSM-7 basic set + extension. A character outside it (U+00A0 from the email
// money formatter is the easy mistake) promotes the whole message to UCS-2 and
// its 70-character segments, so a one-segment RO/EN SMS silently becomes three.
const GSM7 = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
  '^{}\\[~]|€';

function nonGsm7(message: string) {
  return [...message].filter((character) => !GSM7.includes(character));
}

Deno.test('partial cancellation SMS stays in one segment and says the booking stands', () => {
  const limits: Record<string, number> = { ro: 160, ru: 140, en: 160 };

  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, '0');
    for (const language of ['ro', 'ru', 'en']) {
      const message = partialCancellationSms({
        cancelledCount: 1,
        totalCount: 3,
        checkIn: `2026-${mm}-28`,
        checkOut: `2026-${mm}-30`,
        refundAmount: 12200,
        withheldCommission: 171,
        language,
      });
      if (message.length > limits[language]) {
        throw new Error(
          `${language} partial-cancel SMS is ${message.length} chars (month ${mm}), over ${
            limits[language]
          }: ${message}`,
        );
      }
    }
  }

  // RO/EN must stay GSM-7: a single diacritic doubles the cost of the message.
  const ro = partialCancellationSms({
    cancelledCount: 1,
    totalCount: 2,
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 850,
    withheldCommission: 12,
    language: 'ro',
  });
  assertEquals(nonGsm7(ro), [], `RO partial-cancel SMS leaves GSM-7: ${ro}`);
  assert(ro.includes('1 din 2'));
  assert(ro.includes('Restituire: 850 MDL'));
  assert(ro.includes('comision 12 MDL'));

  // A grouped amount is where GSM-7 gets lost: the email money formatter joins
  // thousands with a non-breaking space.
  const grouped = partialCancellationSms({
    cancelledCount: 1,
    totalCount: 3,
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 12200,
    withheldCommission: 171,
    language: 'en',
  });
  assertEquals(nonGsm7(grouped), [], `EN partial-cancel SMS leaves GSM-7: ${grouped}`);
  assert(grouped.includes('12 200 MDL'), grouped);

  // No refund, no refund sentence — the guest must not go looking for money.
  const noRefund = partialCancellationSms({
    cancelledCount: 1,
    totalCount: 2,
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 0,
    language: 'ro',
  });
  assertEquals(noRefund.includes('Restituire'), false, noRefund);
});

Deno.test('partial cancellation SMS falls back to Romanian for an unknown language', () => {
  const message = partialCancellationSms({
    cancelledCount: 1,
    totalCount: 2,
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    language: 'fr',
  });
  assert(message.startsWith('Am anulat'), message);
});

// A booking group's notification owner is the lowest reservation id. Schedulers
// query only paid, non-cancelled rows, so cancelling the current owner would
// promote the next villa and send the guest the same reminder twice.
function ownerClient(rows: Array<{ id: string; booking_group_id: string | null }>) {
  return {
    from(table: string) {
      assertEquals(table, 'reservations');
      return {
        select() {
          return {
            in(column: string, values: unknown[]) {
              assertEquals(column, 'booking_group_id');
              return Promise.resolve({
                data: rows.filter((row) => values.includes(row.booking_group_id)),
                error: null,
              });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

Deno.test('the notification owner survives the cancellation of its own villa', async () => {
  const client = ownerClient([
    { id: 'a-first', booking_group_id: 'grp' },
    { id: 'b-second', booking_group_id: 'grp' },
  ]);

  // Only the second villa is still live — the scheduler never sees 'a-first'.
  const owners = await resolveStableGroupOwnerIds(client, [
    { id: 'b-second', booking_group_id: 'grp' },
  ]);

  assertEquals(owners.get('grp'), 'a-first');
});

Deno.test('an ungrouped reservation owns its own notifications', async () => {
  const owners = await resolveStableGroupOwnerIds(ownerClient([]), [
    { id: 'solo', booking_group_id: null },
  ]);

  assertEquals(owners.get('solo'), 'solo');
});

Deno.test('a full cancellation that returned money names the sum', () => {
  // Staff can tick every villa: that is a full cancellation which still paid out
  // a hand-typed amount, and the plain cancellation copy has no refund line.
  const withRefund = buildCancellationEmail({
    lang: 'ro',
    firstName: 'Vera',
    fullName: 'Vera Munteanu',
    roomCopy: '2× Căsuță mică',
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 850,
    withheldCommission: 12,
    siteUrl: 'https://ecovila.md',
  });
  assert(withRefund.text.includes('Sumă restituită: 850 MDL'), withRefund.text);
  assert(
    withRefund.text.includes('Comision de procesare reținut: 12 MDL'),
    withRefund.text,
  );
  assert(withRefund.text.includes('1–5 zile lucrătoare'));
  // Nothing is left of this booking, so the partial copy's "the rest of your
  // booking stays paid" line must not come along with the refund note.
  assertEquals(withRefund.text.includes('rămâne achitat integral'), false, withRefund.text);

  // Every other caller omits the amount and the email is byte-for-byte the old one.
  const plain = buildCancellationEmail({
    lang: 'ro',
    firstName: 'Vera',
    fullName: 'Vera Munteanu',
    roomCopy: '2× Căsuță mică',
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    siteUrl: 'https://ecovila.md',
  });
  assertEquals(plain.text.includes('Sumă restituită'), false);
  assertEquals(plain.text.includes('Despre restituire'), false);
});

Deno.test('the cancellation SMS keeps its closing line unless money was returned', () => {
  const plain = cancellationConfirmationSms({
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    language: 'ro',
  });
  assert(plain.endsWith('. Speram sa ne mai vedem in curand!'), plain);
  assert(plain.startsWith('Rezervarea dvs este anulata: '), plain);

  const refunded = cancellationConfirmationSms({
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 12200,
    withheldCommission: 171,
    language: 'ro',
  });
  assert(refunded.includes('Restituit: 12 200 MDL'), refunded);
  assert(refunded.includes('comision 171 MDL'), refunded);
  assert(refunded.length <= 160, `${refunded.length} chars: ${refunded}`);
  assertEquals(nonGsm7(refunded), [], `RO cancellation SMS leaves GSM-7: ${refunded}`);

  const ru = cancellationConfirmationSms({
    checkIn: '2026-08-20',
    checkOut: '2026-08-23',
    refundAmount: 12200,
    withheldCommission: 171,
    language: 'ru',
  });
  assert(ru.length <= 140, `${ru.length} chars: ${ru}`);
});

Deno.test('scheduled cancellation notices never call pending money refunded', () => {
  const emailLabels = {
    ro: 'Restituire programată',
    ru: 'Возврат запланирован',
    en: 'Scheduled refund',
  };
  const smsLabels = {
    ro: 'Restituire programata',
    ru: 'Возврат запланирован',
    en: 'Scheduled refund',
  };
  for (const language of ['ro', 'ru', 'en'] as const) {
    const email = buildCancellationEmail({
      lang: language,
      firstName: 'Ana',
      fullName: 'Ana Lungu',
      roomCopy: 'EcoVila',
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      refundAmount: 2170,
      withheldCommission: 30,
      refundStatus: 'scheduled',
      refundEta: '2026-08-28T18:30:00.000Z',
      siteUrl: 'https://ecovila.md',
    });
    assert(email.text.includes(`${emailLabels[language]}: 2 170 MDL`), email.text);
    assert(email.text.includes('28'), email.text);
    assertEquals(email.text.includes('1–5'), false, email.text);

    const sms = cancellationConfirmationSms({
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      refundAmount: 2170,
      withheldCommission: 30,
      refundStatus: 'scheduled',
      refundEta: '2026-08-28T18:30:00.000Z',
      language,
    });
    assert(sms.includes(`${smsLabels[language]}: 2 170 MDL`), sms);
    assert(sms.includes('28.08'), sms);
    assert(sms.length <= (language === 'ru' ? 140 : 160), `${sms.length}: ${sms}`);
    if (language !== 'ru') {
      assertEquals(nonGsm7(sms), [], `${language} scheduled SMS leaves GSM-7: ${sms}`);
    }
  }
});

Deno.test('processing cancellation notices describe retryable money as in progress', () => {
  const labels = {
    ro: 'Restituire în curs',
    ru: 'Возврат в процессе',
    en: 'Refund in progress',
  };
  for (const language of ['ro', 'ru', 'en'] as const) {
    const email = buildCancellationEmail({
      lang: language,
      firstName: 'Ana',
      fullName: 'Ana Lungu',
      roomCopy: 'EcoVila',
      checkIn: '2026-09-10',
      checkOut: '2026-09-12',
      refundAmount: 493,
      withheldCommission: 7,
      refundStatus: 'processing',
      siteUrl: 'https://ecovila.md',
    });
    assert(email.text.includes(`${labels[language]}: 493 MDL`), email.text);
    assertEquals(email.text.includes('1–5'), false, email.text);
  }
});
