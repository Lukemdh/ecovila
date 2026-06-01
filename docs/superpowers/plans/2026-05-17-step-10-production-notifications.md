# EcoVila Step 10 Production Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productionize EcoVila notifications by splitting the roadmap, hardening notification delivery/idempotency, wiring live SMS.md and Resend configuration, and verifying scheduled Supabase jobs end to end.

**Architecture:** Keep the existing Supabase Edge Function architecture and static frontend. Tighten the existing notification pipeline instead of replacing it: reserve notification events before dispatch, persist delivery outcomes on those events, keep cron functions secret-gated, and use MCP-first deployment/verification for Supabase changes whenever possible.

**Tech Stack:** Markdown project docs, Node built-in test runner, Deno Edge Functions, Supabase Postgres, Supabase Edge Functions, SMS.md REST API, Resend REST API.

---

## File Structure

- `docs/ECOVILA_PROJECT_BRIEF.md`: split the old Step 10 into Steps 10-12 and normalize cancellation wording to the implemented 7-day policy.
- `tests/edge-functions.test.mjs`: repo-level contract tests for the Step 10 roadmap split, secure secret boundary, and hardened notification-event model.
- `supabase/functions/tests/reservations-test.ts`: Deno unit coverage for booking-confirmation wording and the notification reservation/delivery helpers.
- `supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql`: add delivery lifecycle fields, retry counts, and abandonment state to `notification_events`.
- `supabase/functions/_shared/notifications.ts`: reserve scheduled events before dispatch, retry failed or stale-reserved attempts up to 3 total tries, mark sent/failed/abandoned/skipped outcomes, and update booking confirmation copy from stale 72h wording to 7-day wording while keeping the existing public helper API stable for non-cron callers.
- `supabase/functions/send-reminders/index.ts`: use pre-send reservation results so duplicate cron invocations return `skipped_duplicate` instead of sending again.
- `supabase/functions/expire-cash-reservations/index.ts`: use the same hardened notification lifecycle for expired-cash notices.
- Supabase project configuration via MCP / platform tools: deploy functions, apply migration, configure scheduled invocations where available, and verify live executions.

## Task 1: Step 10 Contract Tests and Roadmap Split

**Files:**
- Modify: `tests/edge-functions.test.mjs`
- Modify: `docs/ECOVILA_PROJECT_BRIEF.md`

- [ ] **Step 1: Write the failing roadmap test**

Add this test to `tests/edge-functions.test.mjs`:

```js
  it('splits the production rollout into notifications, Maib, and tophost steps', () => {
    const brief = read('docs/ECOVILA_PROJECT_BRIEF.md');

    assert.match(brief, /Step 10:\s+\*\*Production Notifications & Scheduling\*\*/i);
    assert.match(brief, /Step 11:\s+\*\*Maib ePay\*\*/i);
    assert.match(brief, /Step 12:\s+\*\*tophost Deployment\*\*/i);
    assert.match(brief, /SMS\.md/i);
    assert.match(brief, /Resend/i);
    assert.match(brief, /Supabase cron\/schedules/i);
    assert.doesNotMatch(
      brief.match(/Step 10:[\s\S]*?(?=Step 11:)/i)?.[0] || '',
      /Maib ePay|tophost\.md/i,
      'Step 10 should not still include Maib or tophost work',
    );
    assert.match(
      brief,
      /Cancellation:\s+guest can cancel at least 7 calendar days before arrival/i,
    );
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test tests/edge-functions.test.mjs
```

Expected: FAIL because the current project brief still has one combined Step 10 and stale quick-reference wording.

- [ ] **Step 3: Rewrite the roadmap section**

Update `docs/ECOVILA_PROJECT_BRIEF.md` so the implementation roadmap becomes:

```md
Step 10: **Production Notifications & Scheduling**
Wire the real notification and scheduling production flow:

* SMS.md
* Resend
* Supabase cron/schedules
* Edge Functions deploy to Supabase

Step 10 also includes the production secrets and provider account work that cannot be completed until the real accounts are ready:

* Add Supabase Edge Function secrets: `SMSMD_API_TOKEN`, `SMSMD_FROM`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `ECOVILA_CRON_SECRET`, and `ECOVILA_SITE_URL`.
* Verify the `ecovila.md` sending domain in Resend and use `rezervari@ecovila.md` as the production sender.
* Register and approve the `EcoVila` sender name in SMS.md.
* Configure scheduled calls for `expire-cash-reservations` and `send-reminders`, passing `ECOVILA_CRON_SECRET` through the `x-ecovila-secret` header or bearer token.

Step 11: **Maib ePay**
Complete card-payment production rollout:

* Add `MAIB_SIGNATURE_KEY`.
* Configure the Maib ePay callback URL to the deployed `maib-webhook` Edge Function.
* Verify the Maib signature payload against production samples.

Step 12: **tophost Deployment**
Deploy the static frontend to tophost.md and complete final public-site verification.
```

Replace the quick-reference line:

```md
11. Cancellation: guest can cancel 72h+ before arrival; under 72h only Diana can cancel
```

with:

```md
11. Cancellation: guest can cancel at least 7 calendar days before arrival for a refund; later cancellations remain possible online but are non-refundable
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node --test tests/edge-functions.test.mjs
```

Expected: PASS for the new roadmap test.

- [ ] **Step 5: Commit**

```bash
git add tests/edge-functions.test.mjs docs/ECOVILA_PROJECT_BRIEF.md
git commit -m "docs: split production rollout steps"
```

## Task 2: Delivery Tracking Migration

**Files:**
- Modify: `tests/edge-functions.test.mjs`
- Create: `supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql`

- [ ] **Step 1: Write the failing delivery-tracking test**

Add this test to `tests/edge-functions.test.mjs`:

```js
  it('tracks notification delivery lifecycle on durable event rows', () => {
    const migrations = fs
      .readdirSync(path.join(root, 'supabase/migrations'))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => read(`supabase/migrations/${file}`))
      .join('\n');

    assert.match(migrations, /add column if not exists delivery_status text/i);
    assert.match(migrations, /delivery_status in \('reserved', 'sent', 'failed'\)/i);
    assert.match(migrations, /add column if not exists attempted_at timestamptz/i);
    assert.match(migrations, /add column if not exists completed_at timestamptz/i);
    assert.match(migrations, /add column if not exists last_error text/i);
    assert.match(migrations, /add column if not exists provider_response jsonb/i);
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test tests/edge-functions.test.mjs
```

Expected: FAIL because the event lifecycle fields do not exist yet.

- [ ] **Step 3: Add the migration**

Create `supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql`:

```sql
set search_path = public, extensions;

alter table public.notification_events
  add column if not exists delivery_status text not null default 'sent',
  add column if not exists attempted_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists last_error text,
  add column if not exists provider_response jsonb not null default '{}'::jsonb;

alter table public.notification_events
  drop constraint if exists notification_events_delivery_status_check;

alter table public.notification_events
  add constraint notification_events_delivery_status_check
  check (delivery_status in ('reserved', 'sent', 'failed'));

update public.notification_events
set
  delivery_status = coalesce(delivery_status, 'sent'),
  attempted_at = coalesce(attempted_at, sent_at),
  completed_at = coalesce(completed_at, sent_at)
where delivery_status is null
   or attempted_at is null
   or completed_at is null;
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node --test tests/edge-functions.test.mjs
```

Expected: PASS for the new delivery-tracking test.

- [ ] **Step 5: Commit**

```bash
git add tests/edge-functions.test.mjs supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql
git commit -m "feat: track notification delivery lifecycle"
```

## Task 3: Notification Idempotency and Copy Tests

**Files:**
- Modify: `supabase/functions/tests/reservations-test.ts`
- Modify: `supabase/functions/_shared/notifications.ts`

- [ ] **Step 1: Write the failing Deno tests**

Append to `supabase/functions/tests/reservations-test.ts`:

```ts
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
```

- [ ] **Step 2: Run the Deno tests to verify they fail**

Run:

```bash
cd supabase/functions && deno test --allow-env tests/reservations-test.ts
```

Expected: FAIL because the new helper functions do not exist yet and booking-confirmation copy still says `72h`.

- [ ] **Step 3: Implement the minimal notification helpers**

Update `supabase/functions/_shared/notifications.ts`:

```ts
export type NotificationDeliveryStatus = 'reserved' | 'sent' | 'failed';

export async function reserveNotificationEvent(
  client: any,
  reservationId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
) {
  const { error } = await client
    .from('notification_events')
    .insert({
      reservation_id: reservationId,
      event_type: eventType,
      delivery_status: 'reserved',
      attempted_at: new Date().toISOString(),
      metadata,
    });

  if (!error) {
    return true;
  }

  if (error.code === '23505') {
    return false;
  }

  throw new Error(error.message || 'Could not reserve notification event.');
}

export async function markNotificationEventSent(
  client: any,
  reservationId: string,
  eventType: string,
  providerResponse: Record<string, unknown> = {},
) {
  const { error } = await client
    .from('notification_events')
    .update({
      delivery_status: 'sent',
      provider_response: providerResponse,
      completed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType);

  if (error) {
    throw new Error(error.message || 'Could not mark notification as sent.');
  }
}

export async function markNotificationEventFailed(
  client: any,
  reservationId: string,
  eventType: string,
  error: unknown,
) {
  const { error: updateError } = await client
    .from('notification_events')
    .update({
      delivery_status: 'failed',
      last_error: error instanceof Error ? error.message : 'Notification failed.',
      completed_at: new Date().toISOString(),
    })
    .eq('reservation_id', reservationId)
    .eq('event_type', eventType);

  if (updateError) {
    throw new Error(updateError.message || 'Could not mark notification as failed.');
  }
}
```

Replace the stale booking confirmation copy:

```ts
`Anulare (72h+): ${cancellationLink}`,
`Anulare 72h+: ${cancellationLink}`,
```

with:

```ts
`Anulare (7 zile+): ${cancellationLink}`,
`Anulare 7 zile+: ${cancellationLink}`,
```

- [ ] **Step 4: Run the Deno tests to verify they pass**

Run:

```bash
cd supabase/functions && deno test --allow-env tests/reservations-test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/tests/reservations-test.ts supabase/functions/_shared/notifications.ts
git commit -m "feat: reserve notification events before dispatch"
```

## Task 4: Harden Scheduled Notification Flows

**Approved refinement on 2026-05-17:** scheduled notifications retry until sent with a cap of **3 total attempts**. Failed rows remain retryable while attempts remain; `reserved` rows become retryable after **3 minutes**; the third failed attempt is marked `abandoned`; only sent rows are terminal duplicate suppressors.

**Files:**
- Modify: `supabase/functions/_shared/notifications.ts`
- Modify: `supabase/functions/send-reminders/index.ts`
- Modify: `supabase/functions/expire-cash-reservations/index.ts`
- Modify: `tests/edge-functions.test.mjs`

- [ ] **Step 1: Write the failing repo-level flow test**

Add this test to `tests/edge-functions.test.mjs`:

```js
  it('reserves scheduled notification events before provider dispatch', () => {
    const notifications = read('supabase/functions/_shared/notifications.ts');
    const reminders = read('supabase/functions/send-reminders/index.ts');
    const expiry = read('supabase/functions/expire-cash-reservations/index.ts');

    assert.match(notifications, /reserveNotificationEvent/);
    assert.match(notifications, /markNotificationEventSent/);
    assert.match(notifications, /markNotificationEventFailed/);
    assert.match(reminders, /skipped_duplicate/);
    assert.match(expiry, /skipped_duplicate/);
    assert.doesNotMatch(
      notifications,
      /dispatchNotification\(message\)[\s\S]*recordNotificationEvent/,
      'dispatch should no longer happen before duplicate reservation succeeds',
    );
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test tests/edge-functions.test.mjs
```

Expected: FAIL because the scheduled flows still dispatch before duplicate detection.

- [ ] **Step 3: Harden the existing dispatch wrapper**

Replace the body of `dispatchAndRecordNotification()` in `supabase/functions/_shared/notifications.ts` with:

```ts
export async function dispatchAndRecordNotification(
  client: any,
  reservationId: string,
  eventType: string,
  message: NotificationMessage,
  metadata: Record<string, unknown> = {},
) {
  const reserved = await reserveNotificationEvent(client, reservationId, eventType, metadata);

  if (!reserved) {
    return { sent: false, skipped_duplicate: true };
  }

  try {
    const result = await dispatchNotification(message);
    await markNotificationEventSent(client, reservationId, eventType, result);
    return { sent: true, skipped_duplicate: false, result };
  } catch (error) {
    await markNotificationEventFailed(client, reservationId, eventType, error);
    throw error;
  }
}
```

- [ ] **Step 4: Update `send-reminders` to use duplicate-aware results**

In `supabase/functions/send-reminders/index.ts`, keep the existing import but replace the call to `dispatchAndRecordNotification()` with:

```ts
      const result = await dispatchAndRecordNotification(
        client,
        reservation.id,
        eventType,
        createMessage(reservation),
      );
      results.push({ reservationId: reservation.id, ...result });
```

- [ ] **Step 5: Update `expire-cash-reservations` the same way**

In `supabase/functions/expire-cash-reservations/index.ts`, keep the existing import but replace the call to `dispatchAndRecordNotification()` with:

```ts
      const result = await dispatchAndRecordNotification(
        client,
        reservation.id,
        'cash_expired',
        composeExpiredCashCancellation(reservation),
      );
      results.push({ reservationId: reservation.id, ...result });
```

- [ ] **Step 6: Run repo and Deno tests**

Run:

```bash
node --test tests/edge-functions.test.mjs
cd supabase/functions && deno test --allow-env tests/reservations-test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/edge-functions.test.mjs supabase/functions/_shared/notifications.ts supabase/functions/send-reminders/index.ts supabase/functions/expire-cash-reservations/index.ts
git commit -m "feat: harden scheduled notification dispatch"
```

## Task 5: MCP-First Supabase Deployment and Live Configuration

**Files / systems:**
- Read: `supabase/functions/*`
- Apply remotely: migration and Edge Function deployments through Supabase MCP where possible
- Configure remotely: Edge Function secrets and schedules through available Supabase tooling

- [ ] **Step 1: Discover the target Supabase project**

Use MCP:

```text
list_projects
get_project
```

Expected: identify the production project ref that matches the existing frontend config.

- [ ] **Step 2: Apply the delivery-tracking migration**

Use MCP `apply_migration` with:

```text
name: step10_notification_delivery_tracking
query: contents of supabase/migrations/20260517120000_step10_notification_delivery_tracking.sql
```

Expected: migration applies successfully to the target project.

- [ ] **Step 3: Deploy the touched Edge Functions**

Use MCP `deploy_edge_function` for:

- `send-reminders`
- `expire-cash-reservations`
- `send-sms`
- `send-email`
- any shared dependency consumers that require redeployment because the shared module changed

Each deploy payload must include:

- the function `index.ts`
- `deno.json`
- `import_map.json`
- every imported shared file used by that function
- the current `verify_jwt` setting from `supabase/config.toml`

Expected: deployed versions are created without requiring the user to manually create functions in the dashboard.

- [ ] **Step 4: Configure Step 10 Edge Function secrets**

The available Supabase MCP toolset does not expose Edge Function secret management. Try the CLI path next so the values still never enter the repository:

```bash
supabase secrets set \
  SMSMD_API_TOKEN='<smsmd-token>' \
  SMSMD_FROM='EcoVila' \
  RESEND_API_KEY='<resend-api-key>' \
  RESEND_FROM_EMAIL='rezervari@ecovila.md' \
  ECOVILA_CRON_SECRET='<generated-random-secret>' \
  ECOVILA_SITE_URL='https://ecovila.md' \
  --project-ref '<project-ref>'
```

Expected: secrets are present in the remote Edge Function environment and never written into committed files. If CLI auth is unavailable, stop and report that one manual dashboard action remains: add these six values under Edge Function secrets.

- [ ] **Step 5: Configure production schedules**

Use MCP `execute_sql` with the following SQL after substituting the real project URL and the generated cron secret:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

select vault.create_secret('https://<project-ref>.supabase.co', 'ecovila_project_url');
select vault.create_secret('<generated-random-secret>', 'ecovila_cron_secret');

select cron.schedule(
  'ecovila-expire-cash-reservations',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ecovila_project_url') || '/functions/v1/expire-cash-reservations',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ecovila-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'ecovila_cron_secret')
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 5000
    );
  $$
);

select cron.schedule(
  'ecovila-send-reminders',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'ecovila_project_url') || '/functions/v1/send-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ecovila-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'ecovila_cron_secret')
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 5000
    );
  $$
);
```

Expected: both scheduled jobs exist and point at the deployed functions.

- [ ] **Step 6: Run Supabase advisors**

Use MCP:

```text
get_advisors(type: security)
get_advisors(type: performance)
```

Expected: review and fix any new actionable findings before calling the rollout complete.

## Task 6: Live Verification

**Files / systems:**
- Read: deployed Edge Function logs
- Use: controlled test reservations and designated test contact details only

- [ ] **Step 1: Verify unauthorized cron calls are rejected**

Invoke each cron function without `ECOVILA_CRON_SECRET`.

Expected:

```json
{ "error": "Invalid function secret." }
```

with HTTP 401.

- [ ] **Step 2: Verify authorized cron calls succeed**

Invoke each cron function with the configured secret.

Expected:

- `expire-cash-reservations` returns JSON with `expired`, `reservationIds`, and `notificationResults`
- `send-reminders` returns JSON with `cashWarnings` and `arrivalReminders`

- [ ] **Step 3: Verify one real SMS path**

Use a controlled test reservation and invoke the appropriate notification path.

Expected: SMS.md accepts the request and the designated test phone receives the message.

- [ ] **Step 4: Verify one real email path**

Use the same controlled reservation and invoke the appropriate notification path.

Expected: Resend accepts the request and the designated test inbox receives the message from `rezervari@ecovila.md`.

- [ ] **Step 5: Verify duplicate suppression**

Invoke the same scheduled reminder path twice for the same qualifying reservation.

Expected:

- first run returns `sent: true`
- second run returns `sent: false, skipped_duplicate: true`
- only one provider delivery is observed

- [ ] **Step 6: Check logs**

Use MCP `get_logs` for:

- `edge-function`
- `postgres`

Expected: no unexplained 5xx errors; intentional 401s from the negative test are understood.

## Task 7: Final Verification

**Files:**
- Read and verify all Step 10 touched files.

- [ ] **Step 1: Run the focused repo tests**

```bash
node --test tests/edge-functions.test.mjs
cd supabase/functions && deno test --allow-env tests/reservations-test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the broader relevant test subset**

```bash
node --test tests/supabase-wiring.test.mjs tests/checkout.test.mjs tests/anulare.test.mjs tests/edge-functions.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Summarize rollout status**

Report:

- what was changed in the repo
- which remote Supabase operations were completed automatically
- whether any provider-account prerequisite remains open
- whether the user must still manually create anything in Supabase
