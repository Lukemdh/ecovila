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

Deno.test('buildReservationRows accepts international guest phone numbers', async () => {
  const { buildReservationRows } = await import('../_shared/reservations.ts');
  const rows = buildReservationRows(
    [
      {
        id: 'reservation-foreign',
        booking_group_id: '00000000-0000-4000-8000-000000000002',
        room_id: 'room-a',
        guest_first_name: 'Elena',
        guest_last_name: 'Popescu',
        guest_phone: '+40 721 234 567',
        guest_email: 'elena@example.ro',
        check_in: '2026-06-01',
        check_out: '2026-06-03',
        adults: 2,
        kids_ages: [],
        total_price: 5200,
        payment_type: 'card',
      },
    ],
    { now: new Date('2026-05-08T07:00:00.000Z') },
  );

  assertEquals(rows[0].guest_phone, '+40721234567');
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

Deno.test('recordNotificationEvent stores non-cron sends as sent lifecycle rows', async () => {
  const { recordNotificationEvent } = await import('../_shared/notifications.ts');
  let insertPayload: Record<string, unknown> | undefined;
  const client = {
    from() {
      return {
        insert(payload: Record<string, unknown>) {
          insertPayload = payload;
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  assertEquals(
    await recordNotificationEvent(client, 'reservation-a', 'booking_confirmation'),
    true,
  );

  assertEquals(insertPayload?.delivery_status, 'sent');
  assertEquals(insertPayload?.attempted_at, insertPayload?.completed_at);
  assertEquals(insertPayload?.completed_at, insertPayload?.sent_at);
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

Deno.test('dispatchScheduledNotificationOnce records the first attempt as sent', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore();
  let dispatchCount = 0;

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => {
        dispatchCount += 1;
        return Promise.resolve(providerResult);
      },
    },
  );

  assertEquals(result.sent, true);
  assertEquals(result.skipped_duplicate, false);
  assertEquals(dispatchCount, 1);
  assertEquals(store.inserts[0].attempt_count, 1);
  assertEquals(store.updates.map((update) => update.delivery_status), ['sent']);
});

Deno.test('dispatchScheduledNotificationOnce retries failed rows while attempts remain', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore({
    delivery_status: 'failed',
    attempt_count: 1,
    attempted_at: '2026-05-17T11:59:00.000Z',
  });

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => Promise.resolve(providerResult),
    },
  );

  assertEquals(result.sent, true);
  assertEquals(store.updates[0].delivery_status, 'reserved');
  assertEquals(store.updates[0].attempt_count, 2);
  assertEquals(store.updates[1].delivery_status, 'sent');
});

Deno.test('dispatchScheduledNotificationOnce retries reserved rows after 3 minutes', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore({
    delivery_status: 'reserved',
    attempt_count: 1,
    attempted_at: '2026-05-17T11:57:00.000Z',
  });

  await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => Promise.resolve(providerResult),
    },
  );

  assertEquals(store.updates[0].delivery_status, 'reserved');
  assertEquals(store.updates[0].attempt_count, 2);
});

Deno.test('dispatchScheduledNotificationOnce keeps a fresh third reserved attempt pending', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore({
    delivery_status: 'reserved',
    attempt_count: 3,
    attempted_at: '2026-05-17T11:58:00.000Z',
  });
  let dispatchCount = 0;

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => {
        dispatchCount += 1;
        return Promise.resolve(providerResult);
      },
    },
  );

  assertEquals(result, { sent: false, skipped_duplicate: false, retry_pending: true });
  assertEquals(dispatchCount, 0);
});

Deno.test('dispatchScheduledNotificationOnce persists stale third reserved attempts as abandoned', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore({
    delivery_status: 'reserved',
    attempt_count: 3,
    attempted_at: '2026-05-17T11:56:00.000Z',
  });
  let dispatchCount = 0;

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => {
        dispatchCount += 1;
        return Promise.resolve(providerResult);
      },
    },
  );

  assertEquals(result, { sent: false, skipped_duplicate: false, abandoned: true });
  assertEquals(dispatchCount, 0);
  assertEquals(store.updates.map((update) => update.delivery_status), ['abandoned']);
});

Deno.test('dispatchScheduledNotificationOnce only dispatches the retry invocation that wins the guarded claim', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore(
    {
      delivery_status: 'failed',
      attempt_count: 1,
      attempted_at: '2026-05-17T11:59:00.000Z',
    },
    {},
    {
      rowBeforeRetryClaim: {
        delivery_status: 'reserved',
        attempt_count: 2,
        attempted_at: '2026-05-17T12:00:00.000Z',
      },
    },
  );
  let dispatchCount = 0;

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => {
        dispatchCount += 1;
        return Promise.resolve(providerResult);
      },
    },
  );

  assertEquals(result, { sent: false, skipped_duplicate: false, retry_pending: true });
  assertEquals(dispatchCount, 0);
});

Deno.test('dispatchScheduledNotificationOnce treats sent rows as terminal duplicates', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore({
    delivery_status: 'sent',
    attempt_count: 1,
    attempted_at: '2026-05-17T11:57:00.000Z',
  });
  let dispatchCount = 0;

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => {
        dispatchCount += 1;
        return Promise.resolve(providerResult);
      },
    },
  );

  assertEquals(result, { sent: false, skipped_duplicate: true });
  assertEquals(dispatchCount, 0);
});

Deno.test('dispatchScheduledNotificationOnce only suppresses sent rows after a concurrent claim', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore(undefined, {}, {
    insertError: { code: '23505' },
    rowAfterInsertError: {
      delivery_status: 'failed',
      attempt_count: 1,
      attempted_at: '2026-05-17T11:59:00.000Z',
    },
  });

  const result = await dispatchScheduledNotificationOnce(
    store.client,
    'reservation-a',
    'arrival_24h',
    scheduledMessage,
    {},
    {
      now: new Date('2026-05-17T12:00:00.000Z'),
      dispatch: () => Promise.resolve(providerResult),
    },
  );

  assertEquals(result.sent, true);
  assertEquals(store.updates[0].delivery_status, 'reserved');
  assertEquals(store.updates[0].attempt_count, 2);
});

Deno.test('dispatchScheduledNotificationOnce abandons the third provider failure', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore({
    delivery_status: 'failed',
    attempt_count: 2,
    attempted_at: '2026-05-17T11:59:00.000Z',
  });

  await assertRejects(
    () =>
      dispatchScheduledNotificationOnce(
        store.client,
        'reservation-a',
        'arrival_24h',
        scheduledMessage,
        {},
        {
          now: new Date('2026-05-17T12:00:00.000Z'),
          dispatch: () => Promise.reject(new Error('provider unavailable')),
        },
      ),
    'provider unavailable',
  );

  assertEquals(store.updates[0].attempt_count, 3);
  assertEquals(store.updates[1].delivery_status, 'abandoned');
  assertEquals(
    store.updates[1].completed_at === '2026-05-17T12:00:00.000Z',
    false,
  );
});

Deno.test('dispatchScheduledNotificationOnce does not rewrite post-send persistence errors as provider failures', async () => {
  const { dispatchScheduledNotificationOnce } = await import('../_shared/notifications.ts');
  const store = createNotificationEventStore(undefined, {
    sent: { message: 'mark sent unavailable' },
  });

  await assertRejects(
    () =>
      dispatchScheduledNotificationOnce(
        store.client,
        'reservation-a',
        'arrival_24h',
        scheduledMessage,
        {},
        {
          now: new Date('2026-05-17T12:00:00.000Z'),
          dispatch: () => Promise.resolve(providerResult),
        },
      ),
    'mark sent unavailable',
  );

  assertEquals(store.updates.map((update) => update.delivery_status), ['sent']);
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

async function assertRejects(callback: () => Promise<unknown>, expectedMessage: string) {
  try {
    await callback();
  } catch (error) {
    if (String((error as Error).message) !== expectedMessage) {
      throw new Error(`Expected "${expectedMessage}", received "${(error as Error).message}"`);
    }

    return;
  }

  throw new Error(`Expected callback to reject with "${expectedMessage}"`);
}

function assertIncludes(value: string, expected: string) {
  if (!value.includes(expected)) {
    throw new Error(`Expected "${value}" to include "${expected}"`);
  }
}

const scheduledMessage = {
  sms: {
    to: '+37360123456',
    message: 'Reminder',
  },
  email: {
    to: 'ana@example.md',
    subject: 'Reminder',
    html: '<p>Reminder</p>',
    text: 'Reminder',
  },
};

const providerResult = {
  sms: { id: 'sms-a' },
  email: { id: 'email-a' },
};

function createNotificationEventStore(
  initialRow?: Record<string, unknown>,
  updateErrors: Partial<Record<string, { message: string }>> = {},
  insertOptions: {
    insertError?: { code: string };
    rowAfterInsertError?: Record<string, unknown>;
    rowBeforeRetryClaim?: Record<string, unknown>;
  } = {},
) {
  let row: Record<string, unknown> | null = initialRow
    ? withNotificationEventIdentity(initialRow)
    : null;
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let simulatedRetryClaimRace = false;

  return {
    inserts,
    updates,
    client: {
      from() {
        return {
          select() {
            return createSelectBuilder(() => row);
          },
          insert(payload: Record<string, unknown>) {
            inserts.push(payload);

            if (insertOptions.insertError) {
              row = insertOptions.rowAfterInsertError
                ? withNotificationEventIdentity(insertOptions.rowAfterInsertError)
                : row;
              return Promise.resolve({ error: insertOptions.insertError });
            }

            row = { ...payload };
            return Promise.resolve({ error: null });
          },
          update(payload: Record<string, unknown>) {
            updates.push(payload);
            return createUpdateBuilder(
              (filters) => {
                if (
                  insertOptions.rowBeforeRetryClaim &&
                  !simulatedRetryClaimRace &&
                  payload.delivery_status === 'reserved' &&
                  Number(payload.attempt_count) > 1
                ) {
                  row = withNotificationEventIdentity(insertOptions.rowBeforeRetryClaim);
                  simulatedRetryClaimRace = true;
                }

                const rowMatches = row &&
                  filters.every(({ column, value }) => row?.[column] === value);

                if (!rowMatches) {
                  return { data: null, error: null };
                }

                const status = String(payload.delivery_status || '');
                const error = updateErrors[status];

                if (!error) {
                  row = { ...row, ...payload };
                }

                return { data: error ? null : row, error: error || null };
              },
            );
          },
        };
      },
    },
  };
}

function withNotificationEventIdentity(row: Record<string, unknown>): Record<string, unknown> {
  return {
    reservation_id: 'reservation-a',
    event_type: 'arrival_24h',
    ...row,
  };
}

function createSelectBuilder(readRow: () => Record<string, unknown> | null) {
  return {
    eq() {
      return this;
    },
    maybeSingle() {
      return Promise.resolve({ data: readRow(), error: null });
    },
  };
}

function createUpdateBuilder(
  resolve: (
    filters: Array<{ column: string; value: unknown }>,
  ) => { data: Record<string, unknown> | null; error: { message: string } | null },
) {
  const filters: Array<{ column: string; value: unknown }> = [];
  const builder = {
    eq(column: string, value: unknown) {
      filters.push({ column, value });
      return builder;
    },
    is(column: string, value: unknown) {
      filters.push({ column, value });
      return builder;
    },
    select() {
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(resolve(filters));
    },
    then(
      onfulfilled?: (
        value: { data: Record<string, unknown> | null; error: { message: string } | null },
      ) => unknown,
      onrejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(resolve(filters)).then(onfulfilled, onrejected);
    },
  };

  return builder;
}
