Deno.test('reservation refund eligibility requires at least 20 days or the 2-hour grace window', async () => {
  const { isRefundEligible } = await import('../_shared/reservationManage.ts');

  const now = new Date('2026-05-27T12:00:00.000Z');

  if (!isRefundEligible({ checkIn: '2026-06-16', createdAt: '2026-05-01T12:00:00.000Z', now })) {
    throw new Error('exactly twenty days before check-in should remain refundable');
  }

  if (!isRefundEligible({ checkIn: '2026-06-10', createdAt: '2026-05-27T10:30:00.000Z', now })) {
    throw new Error('bookings created less than two hours ago should be refundable');
  }

  if (isRefundEligible({ checkIn: '2026-06-15', createdAt: '2026-05-27T09:59:59.000Z', now })) {
    throw new Error('outside both refund windows should not be refundable');
  }
});

Deno.test('lookup-code SMS is localized for ro/ru/en and always carries the code', async () => {
  const { composeLookupCodeSms, normalizeSmsLanguage } = await import(
    '../_shared/reservationManage.ts'
  );

  const ro = composeLookupCodeSms('1234', 'ro');
  const ru = composeLookupCodeSms('1234', 'ru');
  const en = composeLookupCodeSms('1234', 'en');

  for (const message of [ro, ru, en]) {
    if (!message.includes('1234')) {
      throw new Error('every lookup-code SMS must include the code');
    }
  }

  if (ro === ru || ro === en || ru === en) {
    throw new Error('each language should produce a distinct lookup-code SMS');
  }

  if (!ru.toLowerCase().includes('код') || !en.toLowerCase().includes('code')) {
    throw new Error('ru/en lookup-code SMS should be translated');
  }

  // Unknown / missing language falls back to Romanian (the default).
  if (composeLookupCodeSms('1234') !== ro || composeLookupCodeSms('1234', 'fr') !== ro) {
    throw new Error('lookup-code SMS should default to ro');
  }

  if (normalizeSmsLanguage('RU') !== 'ru' || normalizeSmsLanguage('') !== 'ro') {
    throw new Error('normalizeSmsLanguage should map known languages and default to ro');
  }
});

Deno.test('reservation manage hashing does not expose plaintext codes or tokens', async () => {
  const { hashLookupCode, hashManageToken, normalizeLookupCode } = await import(
    '../_shared/reservationManage.ts'
  );

  const codeHash = await hashLookupCode('lookup-a', '1234', 'secret-a');
  const repeatedCodeHash = await hashLookupCode('lookup-a', '1234', 'secret-a');
  const differentCodeHash = await hashLookupCode('lookup-a', '4321', 'secret-a');
  const tokenHash = await hashManageToken('token-a', 'secret-a');

  if (codeHash !== repeatedCodeHash) {
    throw new Error('same lookup code input should hash deterministically');
  }

  if (codeHash === differentCodeHash) {
    throw new Error('different lookup codes should produce different hashes');
  }

  if (codeHash.includes('1234') || tokenHash.includes('token-a')) {
    throw new Error('hashes should not include plaintext secrets');
  }

  if (normalizeLookupCode(' 12 34 ') !== '1234') {
    throw new Error('lookup codes should normalize to four digits');
  }
});

Deno.test('reservation manage token rows keep plaintext out of storage', async () => {
  const { buildManageTokenRow } = await import('../_shared/reservationManage.ts');

  const result = await buildManageTokenRow('+37360123456', {
    token: 'manage-token-a',
    secret: 'secret-a',
    now: new Date('2026-06-01T08:00:00.000Z'),
  });

  if (result.token !== 'manage-token-a') {
    throw new Error('plaintext manage token should be returned only to the caller');
  }

  if (result.row.token_hash.includes('manage-token-a')) {
    throw new Error('stored manage token row should not include plaintext token');
  }

  if (result.row.phone !== '+37360123456') {
    throw new Error('manage token row should store the normalized guest phone');
  }

  if (result.row.expires_at !== '2026-06-01T08:30:00.000Z') {
    throw new Error('checkout manage tokens should use the standard 30-minute TTL');
  }
});

Deno.test('a bad lookup phone is a 400, not a server fault', async () => {
  const { assertValidPhone } = await import('../_shared/reservationManage.ts');
  const { HttpError, errorResponse } = await import('../_shared/http.ts');

  // Staff/guest local formats are normalized, not rejected.
  if (assertValidPhone(' +373 60 123 456 ') !== '+37360123456') {
    throw new Error('spacing and punctuation should be normalized away');
  }

  for (const bad of ['', 'invalid', '060123456', '+60843453', '+0123456789']) {
    let thrown: unknown;
    try {
      assertValidPhone(bad);
    } catch (error) {
      thrown = error;
    }

    // Typing a bad number is the caller's mistake. errorResponse maps anything
    // untyped to 500, which used to file guest typos as server faults.
    if (!(thrown instanceof HttpError) || thrown.status !== 400) {
      throw new Error(`${bad || '(empty)'} should be rejected with HttpError(400)`);
    }

    const response = errorResponse(thrown);
    if (response.status !== 400) {
      throw new Error('errorResponse should carry the 400 through');
    }
    if ((await response.json()).error !== 'Invalid phone number.') {
      throw new Error('the guest-facing message must survive unchanged');
    }
  }
});
