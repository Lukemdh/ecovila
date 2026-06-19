import { assertEquals, assertThrows } from 'std/assert';
import { buildReservationRows, hasValidPhoneLength } from '../_shared/reservations.ts';

Deno.test('hasValidPhoneLength enforces country-specific phone lengths', () => {
  // Moldova (+373) carries 8 national digits.
  assertEquals(hasValidPhoneLength('+37360123456'), true);
  assertEquals(hasValidPhoneLength('+373601234567'), false); // 9 digits
  assertEquals(hasValidPhoneLength('+3736012345'), false); // 7 digits

  // Romania (+40) and Ukraine (+380) carry 9 national digits.
  assertEquals(hasValidPhoneLength('+40721234567'), true);
  assertEquals(hasValidPhoneLength('+4072123456'), false); // 8 digits
  assertEquals(hasValidPhoneLength('+380501234567'), true);
  assertEquals(hasValidPhoneLength('+38050123456'), false); // 8 digits

  // Any other country keeps the generic E.164 length (8–15 digits).
  assertEquals(hasValidPhoneLength('+15551234567'), true);
  assertEquals(hasValidPhoneLength('+1555123'), false);
});

function foreignReservation(guestPhone: string) {
  return {
    id: 'reservation-phone',
    booking_group_id: '00000000-0000-4000-8000-000000000003',
    room_id: 'room-a',
    guest_first_name: 'Elena',
    guest_last_name: 'Popescu',
    guest_phone: guestPhone,
    guest_email: 'elena@example.ro',
    check_in: '2026-06-01',
    check_out: '2026-06-03',
    adults: 2,
    kids_ages: [],
    total_price: 5200,
    payment_type: 'card' as const,
  };
}

Deno.test('buildReservationRows rejects wrong-length +373/+40/+380 numbers', () => {
  const now = new Date('2026-05-08T07:00:00.000Z');

  for (const badPhone of ['+373601234567', '+4072123456', '+38050123456']) {
    assertThrows(
      () => buildReservationRows([foreignReservation(badPhone)], { now }),
      'Guest phone must use a valid international format.',
    );
  }
});

Deno.test('buildReservationRows accepts a valid Ukrainian +380 number', () => {
  const rows = buildReservationRows(
    [foreignReservation('+380501234567')],
    { now: new Date('2026-05-08T07:00:00.000Z') },
  );

  assertEquals(rows[0].guest_phone, '+380501234567');
});
