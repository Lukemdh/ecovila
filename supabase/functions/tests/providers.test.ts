import { assertEquals } from 'std/assert';

Deno.test('sendEmail skips the provider call when there is no recipient', async () => {
  const { sendEmail } = await import('../_shared/providers.ts');
  let called = false;
  const fetcher = (() => {
    called = true;
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;

  // Empty, whitespace-only, empty-array and array-of-blanks all count as "no
  // recipient" — a walk-in office reservation may carry no email at all.
  const emptyRecipients: Array<string | string[]> = ['', '   ', [], ['', '  ']];
  for (const to of emptyRecipients) {
    const result = await sendEmail({ to, subject: 'x', html: '<p>x</p>' }, { fetcher });
    assertEquals((result as { skipped?: boolean }).skipped, true);
  }

  // The skip happens before any RESEND_* env is read, so a missing recipient is
  // a clean no-op even with no provider configured.
  assertEquals(called, false);
});

Deno.test('sendEmail posts to the provider when a recipient is present', async () => {
  const { sendEmail } = await import('../_shared/providers.ts');
  const originalKey = Deno.env.get('RESEND_API_KEY');
  const originalFrom = Deno.env.get('RESEND_FROM_EMAIL');
  Deno.env.set('RESEND_API_KEY', 'resend-key');
  Deno.env.set('RESEND_FROM_EMAIL', 'rezervari@ecovila.md');

  let capturedTo: unknown;
  const fetcher = ((_endpoint: string | URL | Request, init?: RequestInit) => {
    capturedTo = JSON.parse(String(init?.body || '{}')).to;
    return Promise.resolve(
      new Response(JSON.stringify({ id: 'email_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;

  try {
    const result = await sendEmail(
      { to: 'guest@example.md', subject: 'x', html: '<p>x</p>' },
      { fetcher },
    );
    assertEquals((result as { id?: string }).id, 'email_1');
    assertEquals(capturedTo, 'guest@example.md');
  } finally {
    if (originalKey === undefined) Deno.env.delete('RESEND_API_KEY');
    else Deno.env.set('RESEND_API_KEY', originalKey);
    if (originalFrom === undefined) Deno.env.delete('RESEND_FROM_EMAIL');
    else Deno.env.set('RESEND_FROM_EMAIL', originalFrom);
  }
});
