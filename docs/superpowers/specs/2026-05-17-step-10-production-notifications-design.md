# EcoVila Step 10 Production Notifications Design

## Scope

Step 10 becomes the production-readiness phase for EcoVila notifications and scheduled background work.

It includes:

- wiring the real SMS.md and Resend credentials into Supabase secrets
- validating the existing SMS and email Edge Function paths against live providers
- configuring the scheduled invocations for cash-expiry handling and reminders
- adding the minimum operational visibility needed to tell successful sends, failed sends, and already-sent reminder events apart
- updating the project brief so Maib ePay moves to Step 11 and tophost deployment moves to Step 12

Step 10 does **not** include Maib ePay production rollout or static-site deployment.

## Roadmap Update

The project brief should be revised so the final phases read as:

1. **Step 10: Production Notifications & Scheduling**
   - SMS.md
   - Resend
   - Supabase cron/schedules
   - notification production secrets
   - live verification and operational hardening
2. **Step 11: Maib ePay**
   - card-payment production secrets
   - callback configuration
   - signature verification against real Maib samples
3. **Step 12: tophost Deployment**
   - static frontend deployment
   - domain/subdomain cutover
   - final public-site verification

While editing the brief, the stale quick-reference cancellation wording should be normalized from the older `72h` language to the currently implemented `7 calendar days` policy so the roadmap no longer contradicts the live behavior.

## Production Secret Boundary

Step 10 owns these Supabase Edge Function secrets:

- `SMSMD_API_TOKEN`
- `SMSMD_FROM`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `ECOVILA_CRON_SECRET`
- `ECOVILA_SITE_URL`

Step 11 owns:

- `MAIB_SIGNATURE_KEY`

Provider credentials must be stored only in Supabase secret storage or equivalent deployment tooling. They must never be committed into repository files, documentation, tests, or browser-visible JavaScript.

## Existing Foundation

The repository already contains the Step 7 Edge Function workspace and shared provider abstraction under `supabase/functions/`, including:

- `send-sms`
- `send-email`
- `expire-cash-reservations`
- `send-reminders`
- provider wrappers in `_shared/providers.ts`
- durable reminder idempotency via `notification_events`

Step 10 should build on that foundation rather than replacing it.

## Notification Flows in Scope

The production notification backbone must support:

- booking confirmation
- 5-minute cash-payment warning
- automatic cash-expiry cancellation notice
- guest/staff-triggered cancellation confirmation
- 24-hour arrival reminder

The live verification path should use controlled test reservations and designated test contact details only, so production-provider checks do not send accidental messages to real guests.

## Operational Hardening

Step 10 should add only the visibility needed to support real operations without expanding into a full monitoring platform.

The system should make it possible to distinguish:

- a notification that was sent successfully
- a notification that failed at the provider boundary
- a scheduled notification that is eligible for retry, has been retried, or was abandoned after the allowed attempts
- a reminder that was intentionally skipped because it was already sent
- a scheduled function invocation that was rejected because its cron secret was missing or invalid

Where the current implementation is already sufficient, keep it. Where it is too opaque, prefer small targeted additions such as structured logging, clearer provider error propagation, or durable status fields tied to existing notification events.

## Scheduled Jobs

Step 10 configures production invocations for:

- `expire-cash-reservations`
- `send-reminders`

Both scheduled paths remain server-side and authenticate with `ECOVILA_CRON_SECRET`, supplied through the existing secret-gated mechanism.

Verification should prove four things:

1. the deployed function can be reached by the scheduler
2. unauthorized requests are rejected
3. authorized requests perform the expected reservation/reminder side effects
4. duplicate reminder sends remain prevented once delivery has succeeded
5. failed scheduled sends retry at most 3 total attempts, with stale `reserved` attempts becoming retryable after 3 minutes
6. events are marked `abandoned` after the third failed attempt so support can distinguish exhaustion from a transient failure

## Provider Prerequisites

Real production sends still depend on provider-account setup outside the repository:

- the `ecovila.md` domain must be verified in Resend before using `rezervari@ecovila.md`
- the `EcoVila` sender name must be approved in SMS.md before using it as `SMSMD_FROM`

These are Step 10 readiness requirements, not reasons to move the notification work into a later step.

## Testing and Verification

Step 10 is complete only when there is evidence at three layers.

### Repository-level verification

- automated tests reflect the new roadmap split
- browser-visible code still contains no private provider secrets
- any new hardening behavior is covered by focused tests, including the 3-attempt retry policy and the 3-minute stale-reservation timeout

### Function-level verification

- direct invocations prove the notification and cron paths work with the configured secrets
- unauthorized cron calls are rejected
- provider failures remain visible and diagnosable

### Production-level verification

- one real SMS path succeeds against SMS.md
- one real email path succeeds against Resend
- one scheduled-job path runs successfully against deployed functions

## Expected File Areas

Likely touched during implementation:

- `docs/ECOVILA_PROJECT_BRIEF.md`
- `tests/edge-functions.test.mjs`
- any new Step 10-focused tests if needed
- targeted files under `supabase/functions/`
- deployment or setup documentation if a small operator checklist is needed

No browser-side secret files should be added.

## Out of Scope

- Maib ePay production rollout
- `MAIB_SIGNATURE_KEY` configuration
- tophost deployment
- public-domain cutover
- broad observability infrastructure
- redesigning the existing notification architecture
