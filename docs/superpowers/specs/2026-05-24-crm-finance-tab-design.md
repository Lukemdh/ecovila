# CRM Finance Tab Design

## Purpose

Add a Finance tab to the EcoVila CRM for owner-level monthly revenue and performance reporting.

This tab is not an accounting tool. It should help the owner understand how much commercial revenue EcoVila produced, where that money came from, and how efficiently the property performed over a selected period.

## Navigation

The Finance tab lives immediately after Dashboard in the CRM top navigation:

```text
Dashboard | Finance | Situația zilnică | Ștergare | Poze | Prețuri
```

The tab is available inside the existing authenticated CRM shell and follows the same desktop-only CRM behavior as the other operational panels.

## Reporting Controls

The Finance panel header uses the same date-navigation rhythm as the Ștergare tab:

- `Înapoi`
- a clickable date/range label
- `Înainte`

The default range is the current calendar month.

Clicking the date label opens a range calendar adapted from the CRM `Adaugă rezervare` date picker. The Finance version reuses the same familiar multi-day selection behavior and visual language, but it must not apply room availability rules. Every date is selectable because this is a reporting range, not a booking flow.

Displayed ranges are inclusive for the owner. For example, `1 mai - 31 mai` means the whole month of May. Internally, queries use `range_start` and an exclusive `range_end` equal to the day after the displayed end date.

`Înapoi` and `Înainte` move by the same range length that is currently selected:

- for a full month, move to the previous or next full month
- for a custom range, shift the range backward or forward by its own day count

## Revenue Mode Switch

Below the header, Finance has a two-option segmented switch:

- `Nopți în perioadă`
- `Încasări`

### Nopți în perioadă

This mode measures stay performance inside the selected period.

If a reservation overlaps the range, only the nights inside the range contribute to revenue and occupied-room-night metrics. A booking from May 30 to June 2 contributes two nights to May when the selected range ends on May 31, and one night to June when the selected range starts on June 1.

When a reservation spans multiple nights, its `total_price` is distributed evenly across its booked nights for reporting. The first implementation does not need to reconstruct historical weekday, holiday, or tier pricing after the booking was made.

### Încasări

This mode measures money recognized during the selected period.

A reservation counts in full when its `paid_at` timestamp falls inside the selected range. This mode does not infer payment date from booking creation date except for legacy paid rows during the initial data backfill.

## Metrics

The first Finance version showed summary metrics only.

Follow-up note (2026-06-08): when the selected range is exactly one day and the active
mode is `Încasări`, the Finance tab also shows a compact detail list of villas whose
reservation rows were created (`created_at`) during that selected day. This list is
separate from the `paid_at` collections totals, so the revenue cards still mean money
recognized on the payment date.

Primary metrics:

- `Total comercial`: cash plus online revenue, excluding `din oficiu`
- `Cash`
- `Online`
- `Din oficiu`: shown as a separate visual group by default
- `Nopți ocupate`
- `Rezervări plătite`
- `Valoare medie rezervare`

`Rezervări plătite` follows the active mode. In `Nopți în perioadă`, it counts distinct paid, non-cancelled commercial reservations that contribute at least one night to the selected range. In `Încasări`, it counts distinct paid, non-cancelled commercial reservations with `paid_at` inside the selected range.

`Valoare medie rezervare` is `Total comercial / Rezervări plătite` for the active mode. `Din oficiu` is excluded from this average.

`Nopți ocupate` includes paid, non-cancelled commercial and `office` reservations because `din oficiu` stays affect occupancy even though they are reported outside commercial revenue.

Revenue by room type:

- `Căsuță mică`
- `Căsuță mare`
- `Hotel`

## Revenue Source Rules

Commercial revenue includes only paid, non-cancelled reservations with payment type:

- `cash`
- `card`

Online payments are reported as one combined bucket. MIA and standard card payments do not need separate reporting in this version.

`din oficiu` reservations use the existing internal `office` payment type. They are displayed separately by default because they affect occupancy and operational performance, but they should not inflate commercial money-in totals.

Cancelled reservations are excluded from all revenue totals and occupied-night totals.

Expired cash reservations and failed Maib payments are intentionally not tracked in this tab.

## Data Model

Add `paid_at timestamptz` to `public.reservations`.

`paid_at` is set when a reservation becomes financially recognized:

- Maib webhook marks online reservations as `paid`
- Diana marks cash reservations as paid through the CRM
- CRM-created `office` reservations are inserted as paid and receive `paid_at` immediately

For existing paid reservations, backfill `paid_at` from `created_at` so historical reports have deterministic data. This backfill is an approximation only for legacy data; new reporting accuracy depends on writing `paid_at` at the actual payment transition.

When a reservation is cancelled, the existing cancellation fields remain the source of cancellation state. The Finance tab excludes rows where `cancelled_at` is not null or `payment_status = 'cancelled'`.

## Data Fetching

The Finance module should fetch reservation rows for the selected range and mode:

- `Nopți în perioadă`: rows where `check_out > range_start` and `check_in < range_end`
- `Încasări`: rows where `paid_at >= range_start` and `paid_at < range_end`

The query must include:

- reservation id and booking group id
- room id and joined room type
- check-in and check-out dates
- total price
- payment type and payment status
- paid_at
- cancelled_at

The Finance module can compute the first-version aggregates client-side from these rows, matching the existing CRM JavaScript pattern.

## Components

- `admin/dashboard.html`: add the Finance tab button, Finance panel markup, date controls, range calendar hooks, segmented mode switch, metric cards, and room-type breakdown area.
- `admin/js/crm-app.js`: initialize the Finance module and place the tab after Dashboard.
- `admin/js/crm-finance.js`: own Finance state, range navigation, range calendar behavior, data loading, aggregation, formatting, and rendering.
- `js/supabase.js`: add a helper to fetch finance reservations by selected range and mode.
- `css/crm.css`: add Finance panel layout and reuse existing CRM visual patterns for date controls, segmented controls, and metric cards.
- `supabase/migrations/*`: add `paid_at`, backfill existing paid rows, and update payment transition code paths.
- Supabase Edge Functions: update Maib and cash confirmation flows so payment transitions write `paid_at`.

## Error Handling

If Finance data cannot be loaded, the tab uses the existing CRM alert mechanism.

If the selected range is incomplete, the previous valid range remains active. The calendar should not apply an empty or inverted range.

If a reservation has missing or malformed dates, it is skipped from range-split calculations rather than breaking the whole panel.

If a paid reservation has no `paid_at` after the migration, it is excluded from `Încasări` mode and can be found by database inspection; the UI should not silently substitute `created_at` after the backfill has run.

## Testing

Add or extend tests for:

- Finance tab appears immediately after Dashboard
- Finance date controls default to the current month
- date label opens a multi-day range calendar without availability restrictions
- `Înapoi` and `Înainte` shift month and custom ranges correctly
- mode switch toggles between `Nopți în perioadă` and `Încasări`
- night-based mode splits cross-range reservations by overlapping nights
- paid-at mode counts full reservations by `paid_at`
- commercial totals exclude `office`
- `din oficiu` is displayed separately
- online revenue combines MIA/card under one Online bucket
- cancelled reservations are excluded
- `paid_at` is written by Maib webhook, CRM cash confirmation, and CRM office reservation creation
- legacy paid rows are backfilled from `created_at`

## Non-Goals

- No expense tracking
- No salaries, utilities, supplier costs, or profit/loss accounting
- No cash-expired or Maib-failed tracking
- No MIA versus card split in the first version
- No general booking-level table for multi-day or `Nopți în perioadă` reports
- No public website changes except where shared data helpers require tests

## Expected Outcome

The owner can open Finance, choose a month or custom range, switch between stay performance and actual collections, and quickly understand:

- how much commercial revenue was produced
- how much came from cash versus online payments
- how much `din oficiu` value exists separately
- how many occupied room-nights were produced
- how average booking value and room-type revenue performed
