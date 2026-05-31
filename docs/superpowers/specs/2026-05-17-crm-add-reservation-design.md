# CRM Add Reservation Improvements Design

## Goal

Improve the CRM `Adaugă rezervare` workflow so Diana can create staff reservations with explicit child-age pricing buckets, an availability-aware date-range calendar, no payment selector, and a live total that matches the selected stay.

## Scope

This change is limited to the CRM add-reservation flow and the shared data model needed to represent staff-created reservations as `din oficiu` bookings. It does not redesign the public reservation flow, change the existing checkout flow, or turn the CRM sidebar into a full public-style booking wizard.

## Chosen Approach

Reuse the existing shared pricing and availability rules inside the CRM while keeping Diana's compact sidebar workflow intact.

The public reservation flow already has the correct date-range behavior and the shared pricing module already contains the guest billing rules. The CRM should reuse those primitives rather than re-implementing a second pricing engine or broadening the add flow into a separate wizard.

## Form Behavior

### Child age buckets

The add form keeps the numeric `Copii` field. When the count is greater than zero, the old free-text `Vârste copii` field is replaced by one rendered row per child with three mutually exclusive choices:

- `0-3`
- `4-11`
- `12+`

The UI stores bucket choices, while the pricing layer receives representative ages that preserve the existing business rules:

- `0-3` maps to a free child age
- `4-11` maps to a child-priced age
- `12+` maps to an adult-priced child age

This keeps the interface simple for Diana while continuing to use the existing shared pricing engine.

### Dates

The two native date inputs in the add form are replaced by a single date-summary control and an inline popup date-range calendar modeled on the public reservations page.

Diana selects check-in first and check-out second. The calendar stays open while a range is being chosen and exposes explicit clear/apply actions. Date availability is derived from the exact room numbers selected in the CRM form, not merely from any room of the same accommodation type.

### Payment

The create form no longer shows a payment selector. CRM-created reservations use a real third reservation payment type stored internally as `office` and rendered in Romanian as `din oficiu`.

`din oficiu`, `cash`, and `card` remain visible in CRM reservation details. New `office` reservations are created as already settled operationally, so they do not enter the pending-cash countdown list.

### Total

`Total` becomes a live quote that recomputes when any pricing input changes:

- adults
- child bucket selections
- room numbers
- check-in/check-out range

Selected rooms are priced as one guest group spanning several rooms, using current shared pricing tiers and holidays from Supabase. For mixed-room bookings, the adult minimums of the selected rooms are combined once across the group, then the group is billed once per night; the same guests are not duplicated per villa.

If the form is incomplete or invalid, total remains `0 MDL` until a valid quote can be computed. Invalid states include missing dates, missing room numbers, unknown room numbers, missing child buckets, mixed unavailable rooms, or unavailable date ranges.

## Availability Rules

The CRM date-range picker validates the exact selected rooms across the entire range. A day or checkout range is selectable only when every selected room is available for the requested stay.

This differs intentionally from the public booking calendar, which asks whether some matching room can satisfy the selected party. Staff creation is explicit-room-first because Diana is entering the exact villa numbers.

## Data Model

The reservations table must allow a third payment type:

- `cash`
- `card`
- `office`

`office` is staff-only creation behavior in this UI. It is presented to users of the CRM as `din oficiu` and is stored with `payment_status = 'paid'`, `cash_expires_at = null`.

Existing cash/card behavior remains unchanged.

## Components and Responsibilities

- `admin/dashboard.html`: replace old add-form fields with child-bucket and range-calendar hooks.
- `admin/js/crm-sidebar.js`: own add-form state, child bucket rendering, exact-room availability checks, live total calculation, and staff row creation.
- `admin/js/crm-dashboard.js`: load pricing tiers and holidays into dashboard state and render readable payment labels in reservation details.
- `css/crm.css`: extend the existing Organic CRM visual system for age bucket controls and the sidebar range calendar.
- `js/calendar.js`: expose a small exact-room availability helper if the CRM needs shared range validation beyond the current public type-based helpers.
- `js/supabase.js`: no new query family is required, but dashboard loading must fetch pricing tiers and holidays already available through shared helpers.
- `docs/supabase/migrations/*`: add the `office` value to the reservation payment-type constraint.

## Error Handling

- Submission is blocked if no valid rooms are selected, dates are missing, child buckets are incomplete, or any selected room conflicts with the selected range.
- The form surfaces a clear CRM alert message for invalid submissions.
- Live total falls back to `0 MDL` rather than showing stale values after a selection becomes invalid.
- Unknown room numbers are treated as invalid rather than silently ignored.

## Testing

Add or extend tests for:

- the rendered add form no longer containing the payment selector
- child buckets mapping to pricing ages correctly
- exact selected-room availability checks across date ranges
- live total calculation for one and multiple selected room types
- `office` reservation row creation with paid status and no cash expiry
- CRM reservation detail rendering of `din oficiu`, `cash`, and `card`
- migration support for the third payment type
- date-range calendar hooks and behavior contract

## Non-Goals

- No public booking UI redesign
- No conference-room pricing change; the existing checkbox remains informational unless a separate pricing rule is defined later
- No CRM room-type cards or public-style checkout wizard
- No editing-flow redesign for existing reservations
