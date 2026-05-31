Deno.test('reservation refund eligibility accepts the 7-day window and 2-hour grace window', async () => {
  const { isRefundEligible } = await import('../_shared/reservationManage.ts');

  const now = new Date('2026-05-27T12:00:00.000Z');

  if (!isRefundEligible({ checkIn: '2026-06-03', createdAt: '2026-05-20T12:00:00.000Z', now })) {
    throw new Error('exactly seven days before check-in should be refundable');
  }

  if (!isRefundEligible({ checkIn: '2026-06-10', createdAt: '2026-05-27T10:30:00.000Z', now })) {
    throw new Error('bookings created less than two hours ago should be refundable');
  }

  if (isRefundEligible({ checkIn: '2026-06-10', createdAt: '2026-05-27T09:59:59.000Z', now })) {
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
