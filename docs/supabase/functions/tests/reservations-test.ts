Deno.test('buildReservationRows normalizes cash reservations with a server-side expiry', async () => {
  const { buildReservationRows } = await import('../_shared/reservations.ts');
  const rows = buildReservationRows(
    [
      {
        id: 'reservation-a',
        booking_group_id: '00000000-0000-4000-8000-000000000001',
        room_id: 'room-a',
        guest_first_name: ' Ana ',
        guest_last_name: ' Munteanu ',
        guest_phone: '060123456',
        guest_email: 'ANA@EXAMPLE.MD',
        check_in: '2026-06-01',
        check_out: '2026-06-03',
        adults: 2,
        kids_ages: [5],
        total_price: 5200,
        payment_type: 'cash',
        room_explicitly_selected: true,
      },
    ],
    { now: new Date('2026-05-08T07:00:00.000Z') },
  );

  assertEquals(rows, [
    {
      id: 'reservation-a',
      booking_group_id: '00000000-0000-4000-8000-000000000001',
      room_id: 'room-a',
      guest_first_name: 'Ana',
      guest_last_name: 'Munteanu',
      guest_phone: '+37360123456',
      guest_email: 'ana@example.md',
      check_in: '2026-06-01',
      check_out: '2026-06-03',
      adults: 2,
      kids_ages: [5],
      total_price: 5200,
      payment_type: 'cash',
      payment_status: 'pending',
      room_explicitly_selected: true,
      conference_room: false,
      notes: null,
      cash_expires_at: '2026-05-08T07:30:00.000Z',
      cash_extended: false,
      created_by: 'guest',
    },
  ]);
});

Deno.test('buildReservationRows rejects unsafe guest-created reservation fields', async () => {
  const { buildReservationRows } = await import('../_shared/reservations.ts');

  assertThrows(
    () => buildReservationRows([{ payment_type: 'cash', payment_status: 'paid' }]),
    'Only pending guest reservations can be created publicly.',
  );
  assertThrows(
    () => buildReservationRows([{ payment_type: 'cash', adults: 0 }]),
    'At least one adult is required for public reservations.',
  );
  assertThrows(
    () => buildReservationRows([{ payment_type: 'cash', notes: 'VIP' }]),
    'Public reservations cannot include private notes.',
  );
});

Deno.test('buildCancellationTokenRows creates one secure token row per reservation', async () => {
  const { buildCancellationTokenRows } = await import('../_shared/reservations.ts');
  const tokenRows = buildCancellationTokenRows(
    [{ id: 'reservation-a' }, { id: 'reservation-b' }],
    () => 'a'.repeat(64),
  );

  assertEquals(tokenRows, [
    { reservation_id: 'reservation-a', token: 'a'.repeat(64) },
    { reservation_id: 'reservation-b', token: 'a'.repeat(64) },
  ]);
});

Deno.test('composeBookingConfirmation includes cancellation and confirmation links', async () => {
  const { composeBookingConfirmation } = await import('../_shared/notifications.ts');
  const message = composeBookingConfirmation(
    {
      id: 'reservation-a',
      room_number: 8,
      check_in: '2026-06-01',
      check_out: '2026-06-03',
      total_price: 5200,
      payment_type: 'cash',
      guest_email: 'ana@example.md',
      guest_phone: '+37360123456',
      guest_first_name: 'Ana',
      guest_last_name: 'Munteanu',
    },
    {
      cancellationToken: 'cancel-token',
      siteUrl: 'https://ecovila.md',
    },
  );

  assertEquals(message.sms.to, '+37360123456');
  assertIncludes(message.sms.message, 'Căsuța #8');
  assertIncludes(message.sms.message, 'https://ecovila.md/anulare.html?token=cancel-token');
  assertEquals(message.email.to, 'ana@example.md');
  assertIncludes(message.email.html, 'https://ecovila.md/confirmare.html?id=reservation-a');
});

Deno.test('composeBookingConfirmation uses the 7-day cancellation wording', async () => {
  const { composeBookingConfirmation } = await import('../_shared/notifications.ts');
  const message = composeBookingConfirmation(
    {
      id: 'reservation-a',
      room_number: 8,
      check_in: '2026-06-01',
      check_out: '2026-06-03',
      total_price: 5200,
      payment_type: 'cash',
      guest_email: 'ana@example.md',
      guest_phone: '+37360123456',
      guest_first_name: 'Ana',
      guest_last_name: 'Munteanu',
    },
    {
      cancellationToken: 'cancel-token',
      siteUrl: 'https://ecovila.md',
    },
  );

  assertIncludes(message.sms.message, 'Anulare (7 zile+):');
  assertIncludes(message.email.text, 'Anulare 7 zile+:');
});

Deno.test('reserveNotificationEvent returns false for duplicate rows before dispatch', async () => {
  const { reserveNotificationEvent } = await import('../_shared/notifications.ts');
  const inserts: unknown[] = [];
  const client = {
    from() {
      return {
        insert(payload: unknown) {
          inserts.push(payload);
          return Promise.resolve({ error: { code: '23505' } });
        },
      };
    },
  };

  assertEquals(await reserveNotificationEvent(client, 'reservation-a', 'arrival_24h'), false);
  assertEquals(inserts.length, 1);
});

Deno.test('markNotificationEventSent stores completion timestamps explicitly', async () => {
  const { markNotificationEventSent } = await import('../_shared/notifications.ts');
  let updatePayload: Record<string, unknown> | undefined;
  const providerResponse = {
    sms: { id: 'sms-a' },
    email: { id: 'email-a' },
  };
  const client = {
    from() {
      return {
        update(payload: Record<string, unknown>) {
          updatePayload = payload;
          return {
            eq() {
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
  };

  await markNotificationEventSent(
    client,
    'reservation-a',
    'arrival_24h',
    providerResponse,
  );

  assertEquals(updatePayload?.delivery_status, 'sent');
  assertEquals(updatePayload?.provider_response, providerResponse);
  assertEquals(updatePayload?.completed_at, updatePayload?.sent_at);
  assertEquals(updatePayload?.last_error, null);
});

Deno.test('markNotificationEventFailed stores provider errors for support', async () => {
  const { markNotificationEventFailed } = await import('../_shared/notifications.ts');
  let updatePayload: unknown;
  const client = {
    from() {
      return {
        update(payload: unknown) {
          updatePayload = payload;
          return {
            eq() {
              return {
                eq() {
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
  };

  await markNotificationEventFailed(
    client,
    'reservation-a',
    'arrival_24h',
    new Error('provider unavailable'),
  );

  assertEquals((updatePayload as Record<string, unknown>).delivery_status, 'failed');
  assertEquals((updatePayload as Record<string, unknown>).last_error, 'provider unavailable');
});

Deno.test('verifyMaibSignature follows the documented sorted-result signature algorithm', async () => {
  const { createMaibSignature, verifyMaibSignature } = await import('../_shared/maib.ts');
  const result = {
    payId: 'f16a9006-128a-46bc-8e2a-77a6ee99df75',
    orderId: 'reservation-a',
    status: 'OK',
    statusCode: '000',
    amount: 10.25,
    currency: 'MDL',
  };
  const signature = await createMaibSignature(result, 'signature-key');

  assertEquals(await verifyMaibSignature({ result, signature }, 'signature-key'), true);
  assertEquals(
    await verifyMaibSignature(
      { result: { ...result, status: 'FAILED' }, signature },
      'signature-key',
    ),
    false,
  );
});

function assertEquals(actual: unknown, expected: unknown) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}`);
  }
}

function assertThrows(callback: () => unknown, expectedMessage: string) {
  try {
    callback();
  } catch (error) {
    if (String((error as Error).message) !== expectedMessage) {
      throw new Error(`Expected "${expectedMessage}", received "${(error as Error).message}"`);
    }

    return;
  }

  throw new Error(`Expected callback to throw "${expectedMessage}"`);
}

function assertIncludes(value: string, expected: string) {
  if (!value.includes(expected)) {
    throw new Error(`Expected "${value}" to include "${expected}"`);
  }
}
