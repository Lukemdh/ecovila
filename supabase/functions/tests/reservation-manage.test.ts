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
