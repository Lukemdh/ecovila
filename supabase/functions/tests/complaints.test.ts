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

Deno.test('casuta complaints prefix the cabin number into the description', async () => {
  const { normalizeComplaintRoom, composeCasutaDescription, COMPLAINT_DESCRIPTION_MAX } =
    await import('../_shared/complaints.ts');

  if (normalizeComplaintRoom('  5  ') !== '5') {
    throw new Error('room should be trimmed');
  }
  if (normalizeComplaintRoom('  A   2  ') !== 'A 2') {
    throw new Error('internal whitespace should collapse to single spaces');
  }
  if (normalizeComplaintRoom('x'.repeat(60)).length !== 40) {
    throw new Error('room should be capped at 40 chars');
  }
  for (const blank of ['', '   ', null, undefined]) {
    if (normalizeComplaintRoom(blank) !== '') {
      throw new Error('blank room should normalize to an empty string');
    }
  }

  const composed = composeCasutaDescription('5', 'apa caldă nu funcționează');
  if (!composed.startsWith('Căsuța 5 — ')) {
    throw new Error('description should carry the "Căsuța <n> — " prefix');
  }
  if (!composed.includes('apa caldă nu funcționează')) {
    throw new Error('the guest text should follow the prefix');
  }

  const capped = composeCasutaDescription('5', 'x'.repeat(COMPLAINT_DESCRIPTION_MAX));
  if (capped.length > COMPLAINT_DESCRIPTION_MAX) {
    throw new Error('composed description must stay within the 2000-char bound');
  }
});

Deno.test('optional follow-up phone normalizes or drops to null', async () => {
  const { normalizeOptionalPhone } = await import('../_shared/complaints.ts');

  if (normalizeOptionalPhone('+373 600 12 345') !== '+37360012345') {
    throw new Error('a valid phone should have its separators stripped');
  }
  for (const blank of ['', '   ', '+', '+373', 'abc', '12345', null, undefined]) {
    if (normalizeOptionalPhone(blank) !== null) {
      throw new Error(`"${String(blank)}" should normalize to null`);
    }
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
