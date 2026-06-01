# CRM Add Reservation Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the CRM add-reservation workflow with child age buckets, exact-room range availability, office reservations, and live totals.

**Architecture:** Keep the CRM add flow inside the existing sidebar, but move its business decisions onto shared pricing and availability helpers. Add small pure helpers to `admin/js/crm-sidebar.js` for bucket normalization, exact-room validation, and quoting, load pricing/holiday data into dashboard state, and extend the data model with an internal `office` payment type rendered as `din oficiu`.

**Tech Stack:** Vanilla HTML/CSS/JS, shared EcoVila pricing/calendar modules, Supabase/Postgres migration, Node built-in test runner.

---

## File Structure

- `tests/admin-crm.test.mjs`: CRM contract tests for the add form, office reservation rows, exact-room helpers, and total calculation.
- `tests/supabase-foundation.test.mjs`: reservation payment-type constraint coverage.
- `admin/dashboard.html`: CRM add-form markup and script dependency order.
- `admin/js/crm-sidebar.js`: add-form pure helpers, dynamic child-bucket rendering, date picker state, group-level mixed-room quote updates, and office reservation creation.
- `admin/js/crm-dashboard.js`: dashboard state loading for pricing tiers/holidays and readable payment labels.
- `css/crm.css`: child-bucket controls and CRM date-range calendar styling.
- `js/calendar.js`: shared selected-room range availability helper.
- `supabase/migrations/20260517190000_office_reservations.sql`: migration expanding allowed payment types to include `office`.

## Task 1: Add failing CRM and migration tests

**Files:**
- Modify: `tests/admin-crm.test.mjs`
- Modify: `tests/supabase-foundation.test.mjs`

- [ ] **Step 1: Add failing CRM tests**

Add tests that assert:

```js
it('renders the staff add form with age buckets, a range calendar, and no payment selector', () => {
  const dashboard = read('admin/dashboard.html');
  assert.match(dashboard, /data-add-child-buckets/);
  assert.match(dashboard, /data-add-date-picker/);
  assert.match(dashboard, /data-add-calendar-grid/);
  assert.doesNotMatch(dashboard, /data-add-payment-type/);
});

it('maps CRM child buckets, validates exact rooms, and totals mixed room selections', () => {
  const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js', {
    EcoVilaPricing: require('../js/pricing.js'),
    EcoVilaCalendar: require('../js/calendar.js'),
  });
  assert.deepEqual(sidebar.bucketValuesToAges(['0-3', '4-11', '12+']), [3, 4, 12]);
  assert.equal(sidebar.areSelectedRoomsAvailable({ rooms, reservations, roomNumbers: [3, 11], checkIn, checkOut }), false);
  assert.equal(sidebar.calculateStaffTotal({ ...validQuoteInput }).total, 6400);
});

it('creates din oficiu staff rows as paid office reservations', () => {
  const rows = sidebar.buildStaffReservationRows(/* valid form */);
  assert.equal(rows[0].payment_type, 'office');
  assert.equal(rows[0].payment_status, 'paid');
  assert.equal(rows[0].cash_expires_at, null);
});

it('renders din oficiu as a CRM detail payment label', () => {
  const dashboardJs = read('admin/js/crm-dashboard.js');
  assert.match(dashboardJs, /office:\s*'din oficiu'/);
});
```

Use concrete fixtures inside the test file for rooms, reservations, pricing tiers, and holidays so the tests exercise pure functions without browser setup.

- [ ] **Step 2: Add the failing migration assertion**

Update `tests/supabase-foundation.test.mjs` so the payment type constraint expects:

```js
/payment_type in \('cash', 'card', 'office'\)/i
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
node --test tests/admin-crm.test.mjs tests/supabase-foundation.test.mjs
```

Expected: FAIL because the add form still has the payment selector, the sidebar helpers do not exist, and the migration does not allow `office` yet.

## Task 2: Add the `office` payment type migration

**Files:**
- Create: `supabase/migrations/20260517190000_office_reservations.sql`

- [ ] **Step 1: Write the migration**

Create a migration that drops the current reservation payment-type check constraint and recreates it with:

```sql
alter table public.reservations
  drop constraint if exists reservations_payment_type_check;

alter table public.reservations
  add constraint reservations_payment_type_check
  check (payment_type in ('cash', 'card', 'office'));
```

- [ ] **Step 2: Run the focused migration test**

Run:

```bash
node --test tests/supabase-foundation.test.mjs
```

Expected: PASS for the payment-type assertion.

## Task 3: Add shared exact-room availability support

**Files:**
- Modify: `js/calendar.js`
- Modify: `tests/admin-crm.test.mjs`

- [ ] **Step 1: Extend the failing test with exact-room behavior**

Use fixtures where one selected room conflicts during the requested stay and another is free. Assert that the helper returns false unless every selected room is available.

- [ ] **Step 2: Run the exact-room test and verify it fails**

Run:

```bash
node --test tests/admin-crm.test.mjs --test-name-pattern="exact rooms"
```

Expected: FAIL because the shared helper does not exist yet.

- [ ] **Step 3: Add the minimal helper**

Add to `js/calendar.js`:

```js
function areRoomsAvailable(input) {
  return (input.roomIds || []).every((roomId) => isRoomAvailable({
    roomId,
    reservations: input.reservations || [],
    checkIn: input.checkIn,
    checkOut: input.checkOut,
  }));
}
```

Export it with the existing calendar API.

- [ ] **Step 4: Re-run the exact-room test**

Run the same focused command.

Expected: PASS.

## Task 4: Replace the CRM add-form markup and styling

**Files:**
- Modify: `admin/dashboard.html`
- Modify: `css/crm.css`
- Modify: `tests/admin-crm.test.mjs`

- [ ] **Step 1: Confirm the markup test is failing**

Run:

```bash
node --test tests/admin-crm.test.mjs --test-name-pattern="add form"
```

Expected: FAIL on missing age-bucket/calendar hooks and existing payment selector.

- [ ] **Step 2: Replace the old controls**

In `admin/dashboard.html`:

- remove the `data-add-kids-ages` text input
- add `<div data-add-child-buckets></div>`
- replace native date inputs with date-summary buttons and CRM calendar hooks:
  - `data-add-date-picker`
  - `data-add-date-summary`
  - `data-add-check-in-label`
  - `data-add-check-out-label`
  - `data-add-calendar-grid`
  - `data-add-calendar-prev`
  - `data-add-calendar-next`
  - `data-add-calendar-clear`
  - `data-add-calendar-apply`
- remove the `data-add-payment-type` field
- load `../js/calendar.js` before the CRM modules.

- [ ] **Step 3: Add matching Organic CRM styles**

Extend `css/crm.css` with compact bucket pills and an anchored sidebar calendar that use the existing CRM palette, borders, radius, and typography. Keep the existing CRM visual direction; do not introduce a new design system.

- [ ] **Step 4: Re-run the markup test**

Run the same focused command.

Expected: PASS.

## Task 5: Implement CRM add-form helpers and office row creation

**Files:**
- Modify: `admin/js/crm-sidebar.js`
- Modify: `tests/admin-crm.test.mjs`

- [ ] **Step 1: Run the helper tests and verify they fail**

Run:

```bash
node --test tests/admin-crm.test.mjs --test-name-pattern="maps CRM child buckets|din oficiu staff rows"
```

Expected: FAIL because helpers still do not exist and rows still use cash/card.

- [ ] **Step 2: Implement pure helpers**

Add functions in `crm-sidebar.js` for:

```js
function bucketValuesToAges(values) {
  const mapping = { '0-3': 3, '4-11': 4, '12+': 12 };
  return (values || []).map((value) => mapping[value]).filter((age) => Number.isInteger(age));
}

function selectedRoomsFromNumbers(rooms, roomNumbers) { /* exact known-room lookup */ }
function areSelectedRoomsAvailable(input) { /* call shared calendar.areRoomsAvailable */ }
function calculateStaffTotal(input) { /* quote one guest group across selected rooms with combined minimum adult floors */ }
```

- [ ] **Step 3: Switch created rows to office reservations**

Change `buildStaffReservationRows()` so it uses bucket-derived ages, `payment_type: 'office'`, `payment_status: 'paid'`, and `cash_expires_at: null`.

- [ ] **Step 4: Export the new helpers**

Expose the pure helpers in the returned API so Node tests can exercise them directly.

- [ ] **Step 5: Re-run the helper tests**

Run the same focused command.

Expected: PASS.

## Task 6: Wire live add-form state, date picker, and totals

**Files:**
- Modify: `admin/js/crm-sidebar.js`
- Modify: `admin/js/crm-dashboard.js`
- Modify: `tests/admin-crm.test.mjs`

- [ ] **Step 1: Add/confirm failing contract tests**

Assert that:

- dashboard loading fetches pricing tiers and holidays into state
- the add form initializes child bucket rendering
- the add calendar reads exact-room availability
- total updates use `calculateStaffTotal`

- [ ] **Step 2: Run the focused contract tests and verify they fail**

Run:

```bash
node --test tests/admin-crm.test.mjs --test-name-pattern="pricing tiers|child buckets|calendar|total"
```

Expected: FAIL because dashboard state and browser wiring are not in place.

- [ ] **Step 3: Extend dashboard data loading**

In `crm-dashboard.js`, load `fetchPricingTiers()` and `fetchHolidays()` alongside rooms/reservations and store them on state for the sidebar quote flow.

- [ ] **Step 4: Wire sidebar form state**

In `crm-sidebar.js`, add local state and event handlers that:

- keep bucket count aligned with the numeric child count
- render one radio row per child
- open/close the CRM calendar
- select check-in then check-out
- disable dates/ranges where exact selected rooms are unavailable
- clear stale checkout dates when upstream form inputs invalidate the range
- recompute and render `data-add-total` on each relevant change

- [ ] **Step 5: Strengthen submit validation**

Before insert, reject unknown rooms, incomplete buckets, missing date ranges, and unavailable selected rooms with CRM alerts. Use the computed total dataset for persisted rows only after the quote is valid.

- [ ] **Step 6: Re-run the focused tests**

Run the same focused command.

Expected: PASS.

## Task 7: Render readable payment labels in CRM details

**Files:**
- Modify: `admin/js/crm-dashboard.js`
- Modify: `tests/admin-crm.test.mjs`

- [ ] **Step 1: Run the payment-label test and verify it fails**

Run:

```bash
node --test tests/admin-crm.test.mjs --test-name-pattern="payment label"
```

Expected: FAIL because details currently print raw payment values.

- [ ] **Step 2: Implement the label map**

Add:

```js
const PAYMENT_LABELS = {
  office: 'din oficiu',
  cash: 'cash',
  card: 'card',
};
```

Use the label in `openReservation()` when rendering `data-edit-payment`.

- [ ] **Step 3: Re-run the payment-label test**

Expected: PASS.

## Task 8: Full verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
node --test tests/*.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run visual verification in the local app**

Open the CRM dashboard in the in-app browser if a local URL is available, or verify the rendered markup manually if auth prevents a live page preview. Check:

- child buckets render one row per child
- check-in/check-out controls no longer overlap
- date range stays open while choosing both endpoints
- payment selector is absent
- total updates when room/date/guest selections are valid

- [ ] **Step 3: Review git diff for scope**

Run:

```bash
git diff --stat
git diff -- admin/dashboard.html admin/js/crm-sidebar.js admin/js/crm-dashboard.js css/crm.css js/calendar.js tests/admin-crm.test.mjs tests/supabase-foundation.test.mjs supabase/migrations/20260517190000_office_reservations.sql
```

Expected: only the scoped CRM/date/pricing files plus docs are changed by this task.
