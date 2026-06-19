Deno.test('complaint category validation accepts the four buttons and rejects others', async () => {
  const { assertValidComplaintCategory, isComplaintCategory } = await import(
    '../_shared/complaints.ts'
  );

  for (const category of ['casuta', 'facilitati', 'personal', 'altceva']) {
    if (!isComplaintCategory(category)) {
      throw new Error(`${category} should be a valid category`);
    }
    if (assertValidComplaintCategory(category) !== category) {
      throw new Error(`${category} should pass assertion unchanged`);
    }
  }

  for (const bad of ['', 'food', 'CASUTA', null, undefined]) {
    let threw = false;
    try {
      assertValidComplaintCategory(bad);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`${String(bad)} should be rejected`);
    }
  }
});

Deno.test('complaint description trims and enforces the 1..2000 bound', async () => {
  const { normalizeComplaintDescription } = await import('../_shared/complaints.ts');

  if (normalizeComplaintDescription('  hello  ') !== 'hello') {
    throw new Error('description should be trimmed');
  }

  for (const bad of ['', '   ', 'a'.repeat(2001)]) {
    let threw = false;
    try {
      normalizeComplaintDescription(bad);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error('out-of-bound description should be rejected');
    }
  }

  if (normalizeComplaintDescription('a'.repeat(2000)).length !== 2000) {
    throw new Error('exactly 2000 chars should be allowed');
  }
});

Deno.test('complaint language normalizes to ro/ru/en', async () => {
  const { normalizeComplaintLanguage } = await import('../_shared/complaints.ts');

  if (normalizeComplaintLanguage('RU') !== 'ru') {
    throw new Error('RU should normalize to ru');
  }
  if (normalizeComplaintLanguage('en') !== 'en') {
    throw new Error('en should pass through');
  }
  for (const fallback of ['', 'fr', null, undefined]) {
    if (normalizeComplaintLanguage(fallback) !== 'ro') {
      throw new Error('unknown languages should fall back to ro');
    }
  }
});

Deno.test('complaint code hash is deterministic and cannot be redeemed as a reservation code', async () => {
  const { hashComplaintCode, hashComplaintSessionToken } = await import('../_shared/complaints.ts');
  const { hashLookupCode } = await import('../_shared/reservationManage.ts');

  const a = await hashComplaintCode('login-1', '1234', 'secret');
  const b = await hashComplaintCode('login-1', '1234', 'secret');
  const c = await hashComplaintCode('login-1', '4321', 'secret');

  if (a !== b) {
    throw new Error('same complaint code should hash deterministically');
  }
  if (a === c) {
    throw new Error('different codes should hash differently');
  }
  if (a.includes('1234')) {
    throw new Error('hash should not contain the plaintext code');
  }

  // Cross-redeem safety: the same loginId+code+secret must NOT match the
  // reservation lookup hash, so a complaint code can never satisfy
  // reservation-lookup-verify even though the storage table is shared.
  const reservationHash = await hashLookupCode('login-1', '1234', 'secret');
  if (a === reservationHash) {
    throw new Error('complaint code hash must differ from the reservation lookup hash');
  }

  const tokenA = await hashComplaintSessionToken('token-x', 'secret');
  const tokenB = await hashComplaintSessionToken('token-x', 'secret');
  if (tokenA !== tokenB) {
    throw new Error('session token should hash deterministically');
  }
  if (tokenA.includes('token-x')) {
    throw new Error('session hash should not contain the plaintext token');
  }
});

Deno.test('check-in welcome SMS is localized, links the complaints page, and stays within limits', async () => {
  const { composeCheckinWelcome } = await import('../_shared/notifications.ts');

  const base = {
    id: '1',
    check_in: '2026-06-19',
    check_out: '2026-06-20',
    total_price: 0,
    payment_type: 'cash',
    guest_email: '',
    guest_phone: '+37360000000',
    guest_first_name: 'Ana',
    guest_last_name: 'Pop',
  };

  const limits: Record<string, number> = { ro: 160, ru: 140, en: 160 };
  const messages = new Set<string>();

  for (const language of ['ro', 'ru', 'en']) {
    const message = composeCheckinWelcome({ ...base, guest_language: language });

    if (message.sms.to !== base.guest_phone) {
      throw new Error('welcome SMS should target the guest phone');
    }
    if (message.email.to !== '') {
      throw new Error('welcome notification must be SMS-only (empty email recipient)');
    }
    if (!message.sms.message.includes('ecovila.md/complaints')) {
      throw new Error(`${language} welcome SMS must link the complaints page`);
    }
    if (message.sms.message.length > limits[language]) {
      throw new Error(
        `${language} welcome SMS is ${message.sms.message.length} chars, over ${limits[language]}`,
      );
    }
    messages.add(message.sms.message);
  }

  if (messages.size !== 3) {
    throw new Error('each language should produce a distinct welcome SMS');
  }
});
