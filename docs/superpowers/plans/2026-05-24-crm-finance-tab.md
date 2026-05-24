# CRM Finance Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner-level CRM Finance tab with date-range reporting, night/revenue mode switching, `paid_at` payment recognition, and source/type performance metrics.

**Architecture:** Add a focused `admin/js/crm-finance.js` module that computes first-version aggregates client-side from reservation rows fetched through `js/supabase.js`. Add a small `paid_at` migration and update the existing payment transition paths so reports can use actual payment recognition time. Keep UI inside the existing CRM shell and reuse the CRM range-calendar visual language without availability rules.

**Tech Stack:** Vanilla HTML/CSS/JS, Node test runner, Supabase JS/PostgREST helpers, Supabase Edge Functions, SQL migrations.

---

### Task 1: Failing Coverage For Finance Reporting

**Files:**
- Modify: `docs/tests/admin-crm.test.mjs`
- Modify: `docs/tests/edge-functions.test.mjs`
- Modify: `docs/tests/supabase-foundation.test.mjs`

- [x] **Step 1: Add tests for tab wiring, aggregation, and paid_at ownership**

Add tests that assert:

```js
assert.ok(dashboard.indexOf('data-tab="dashboard"') < dashboard.indexOf('data-tab="finance"'));
assert.ok(dashboard.indexOf('data-tab="finance"') < dashboard.indexOf('data-tab="daily"'));
assert.match(dashboard, /data-finance-range-label/);
assert.match(dashboard, /data-finance-mode="nights"/);
assert.match(dashboard, /data-finance-mode="paid"/);
assert.match(dashboard, /data-finance-commercial-total/);
assert.match(dashboard, /data-finance-office-total/);
assert.match(dashboard, /data-finance-room-type="small"/);
```

Load `admin/js/crm-finance.js` in the VM and assert:

```js
const summary = finance.summarizeFinanceRows({
  rows,
  mode: 'nights',
  rangeStart: '2026-05-01',
  rangeEnd: '2026-06-01',
});
assert.equal(summary.commercialTotal, 6000);
assert.equal(summary.onlineTotal, 3000);
assert.equal(summary.cashTotal, 3000);
assert.equal(summary.officeTotal, 1000);
assert.equal(summary.occupiedNights, 7);
```

Add migration/function assertions:

```js
assert.match(migrations, /add column if not exists paid_at timestamptz/i);
assert.match(migrations, /set paid_at = coalesce\(paid_at, created_at\)/i);
assert.match(confirmReservationPayment, /paid_at:\s*now/i);
assert.match(maibWebhook, /paid_at:\s*now/i);
```

- [x] **Step 2: Run tests and verify RED**

Run:

```bash
node --test docs/tests/admin-crm.test.mjs docs/tests/edge-functions.test.mjs docs/tests/supabase-foundation.test.mjs
```

Expected: FAIL because `data-tab="finance"`, `crm-finance.js`, and `paid_at` migration/function updates do not exist yet.

### Task 2: paid_at Data Model And Payment Transitions

**Files:**
- Create: `docs/supabase/migrations/20260524140000_reservation_paid_at.sql`
- Modify: `admin/js/crm-sidebar.js`
- Modify: `docs/supabase/functions/confirm-reservation-payment/index.ts`
- Modify: `docs/supabase/functions/maib-webhook/index.ts`

- [x] **Step 1: Add the migration**

Create SQL:

```sql
alter table public.reservations
  add column if not exists paid_at timestamptz;

update public.reservations
set paid_at = coalesce(paid_at, created_at)
where payment_status = 'paid'
  and paid_at is null;

create index if not exists reservations_paid_at_idx
  on public.reservations (paid_at)
  where payment_status = 'paid'
    and cancelled_at is null;
```

- [x] **Step 2: Stamp staff office rows**

Set `paid_at` in `buildStaffReservationRows()`:

```js
paid_at: (options?.now || new Date()).toISOString(),
```

- [x] **Step 3: Stamp staff cash confirmations**

In `confirm-reservation-payment`, create:

```ts
const now = new Date().toISOString();
```

Update pending rows with:

```ts
{ payment_status: 'paid', cash_expires_at: null, paid_at: now }
```

- [x] **Step 4: Stamp Maib paid callbacks**

In `maib-webhook`, update approved rows with:

```ts
{ payment_status: 'paid', cash_expires_at: null, paid_at: now }
```

- [x] **Step 5: Run focused tests**

Run:

```bash
node --test docs/tests/admin-crm.test.mjs docs/tests/edge-functions.test.mjs docs/tests/supabase-foundation.test.mjs
```

Expected: paid_at assertions pass; Finance UI assertions still fail until the next task.

### Task 3: Finance Data Helper And Aggregation Module

**Files:**
- Modify: `js/supabase.js`
- Create: `admin/js/crm-finance.js`

- [x] **Step 1: Add Supabase finance fetch helper**

Add `fetchFinanceReservations(client, options)` to select:

```text
id, booking_group_id, room_id, check_in, check_out, total_price, payment_type,
payment_status, paid_at, cancelled_at, rooms(id, number, type)
```

For `mode === 'paid'`, filter `paid_at >= rangeStart` and `paid_at < rangeEnd`. Otherwise filter `check_out > rangeStart` and `check_in < rangeEnd`. Export it from `EcoVilaSupabase`.

- [x] **Step 2: Create pure Finance helpers**

In `crm-finance.js`, define and export:

```js
const MODE_NIGHTS = 'nights';
const MODE_PAID = 'paid';
const ROOM_TYPE_LABELS = { small: 'Căsuță mică', large: 'Căsuță mare', hotel: 'Hotel' };
```

Implement:

```js
summarizeFinanceRows({ rows, mode, rangeStart, rangeEnd })
```

Rules:
- skip cancelled/unpaid rows
- commercial revenue is `cash` + `card`
- online revenue is `card`
- office revenue is separate
- night mode prorates `total_price` evenly by overlapping nights
- paid mode counts full rows by `paid_at`
- occupied nights include commercial and office rows
- average booking value is commercial total divided by distinct commercial reservation count

- [x] **Step 3: Run focused tests**

Run:

```bash
node --test docs/tests/admin-crm.test.mjs
```

Expected: aggregation tests pass; HTML/CSS/app wiring assertions still fail until the next task.

### Task 4: Finance UI And CRM Wiring

**Files:**
- Modify: `admin/dashboard.html`
- Modify: `admin/js/crm-app.js`
- Modify: `admin/js/crm-finance.js`
- Modify: `css/crm.css`

- [x] **Step 1: Add tab, panel, and script**

Insert Finance after Dashboard in the nav, add a `data-panel="finance"` panel with:

```html
<button data-finance-prev>Înapoi</button>
<button data-finance-range-label>Mai 2026</button>
<button data-finance-next>Înainte</button>
<button data-finance-mode="nights">Nopți în perioadă</button>
<button data-finance-mode="paid">Încasări</button>
```

Add metric hooks for commercial, cash, online, office, occupied nights, paid bookings, average booking value, and room-type breakdowns. Load `js/crm-finance.js` before `js/crm-app.js`.

- [x] **Step 2: Initialize Finance**

In `crm-app.js`, call:

```js
root.EcoVilaCrmFinance?.init?.(context);
```

Also call `showCurrentMonth()` when the Finance tab becomes active.

- [x] **Step 3: Render controls and data**

In `crm-finance.js`, add state for `rangeStart`, `rangeEnd`, `displayEnd`, `mode`, and calendar visibility. Implement month defaults, range navigation, range calendar selection, loading, summary rendering, and alert handling.

- [x] **Step 4: Add CSS**

Reuse the existing CRM Organic surface and add dense reporting layout classes:

```css
.crm-finance-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.crm-finance-stat { border: 1px solid rgba(68, 50, 38, 0.14); border-radius: 18px; }
.crm-finance-mode { display: inline-grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
```

- [x] **Step 5: Run focused tests**

Run:

```bash
node --test docs/tests/admin-crm.test.mjs docs/tests/supabase-wiring.test.mjs
```

Expected: Finance UI and script wiring tests pass.

### Task 5: Final Verification

**Files:**
- Verify all modified files

- [x] **Step 1: Run full test suite**

Run:

```bash
node --test docs/tests/*.test.mjs
```

Expected: all Node tests pass.

- [x] **Step 2: Run Supabase function tests if Deno is available**

Run:

```bash
cd docs/supabase/functions && deno test --allow-env --config deno.json tests/reservations-test.ts
```

Expected: Deno tests pass, or report if Deno is unavailable.

- [x] **Step 3: Serve and inspect the CRM**

Render a static authenticated preview with local headless Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --screenshot=/tmp/ecovila-finance-preview.png file:///tmp/ecovila-finance-preview.html
```

Verify the Finance tab appears after Dashboard, the panel is readable, and no obvious layout overlap occurs.

- [x] **Step 4: Review git diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended implementation files changed.
