# EcoVila CRM Step 9 Design

## Scope

Step 9 builds the first complete CRM for `admin.ecovila.md` as a static vanilla HTML/CSS/JS admin app under `admin/`. It includes Supabase Auth login, a desktop-only dashboard shell, reservation management, the daily reception view, photo management with draft publishing, and pricing/holiday settings.

The CRM is Romanian-only. For this phase, Diana and Angela both see all CRM tabs and have the same level of access.

## Top-Level Structure

The authenticated admin app has a persistent top tab bar in this order:

- `Dashboard`
- `Situația zilnică`
- `Poze`
- `Prețuri`

`admin/index.html` is the login page. `admin/dashboard.html` is the authenticated app shell. The app checks the Supabase session on load, redirects unauthenticated users back to login, and provides sign-out from the CRM header.

The app remains desktop-only. On narrow screens it can show a blocking message telling staff to use a desktop device rather than adapting all workflows to mobile.

## Visual Direction

The CRM should be functional, dense, and calm. It can share EcoVila's earthy palette, but priority goes to scanning, repeated daily use, predictable controls, and readable operational data.

The admin UI uses a compact top navigation, restrained surfaces, 1 px borders, clear status colors, and tabular numerics for dates, prices, countdowns, and phone numbers. Cards must be practical rather than decorative.

## Dashboard Tab

The `Dashboard` tab contains the original reservation-management CRM scope.

### Sidebar

The fixed left sidebar contains:

- pending cash payments across all dates
- `Adaugă rezervare`
- `Caută rezervare`

Settings are not in this sidebar; pricing and holidays move to the `Prețuri` tab.

Pending cash payments show the room, cash amount, live Diana countdown based on `cash_expires_at + 10 minutes`, and a `Marchează ca plătit` action. Marking paid updates `payment_status = 'paid'`, clears cash expiry fields where appropriate, removes the row from pending payments, and triggers the existing confirmation notification path.

### Calendar

The main calendar has rows for rooms 1-25 and date columns from today forward. It scrolls horizontally.

Reservation cards must be large enough to show a Moldovan phone number like `+37368983660` and a name like `Popescu Alexandru` by default. The calendar should widen columns and scroll horizontally instead of wrapping, clipping, or letting text escape card borders. Multi-night cards span the occupied nights from `check_in` through the night before `check_out`.

Card colors:

- yellow: pending cash, with countdown
- purple: paid cash
- green: paid card
- grey: cancelled, hidden by default unless a toggle is enabled

Cards show guest name and phone by default. Hover can show extra details, but the core name and phone must already be visible.

### Reservation Actions

Diana or Angela can:

- drag a reservation to another room
- drag a reservation to another date
- drag to another room and date at once
- swap reservations when dropping onto an occupied slot
- open reservation details by clicking a card
- edit dates, people, guest details, phone, notes, and total price
- cancel/delete after typing `sterge`

If either reservation in a swap has `room_explicitly_selected = true`, the staff member must type `schimba` before the swap is applied.

If a drag changes the accommodation type, the CRM prompts for the people count and recalculates the total price using the shared pricing logic. Staff can override capacity limits, matching the business rule that CRM bookings are not restricted like public bookings.

## Situația Zilnică Tab

This tab is optimized for reception work. It opens on today's date.

At the top:

- previous-day arrow
- current selected date
- next-day arrow
- clicking the date opens a calendar picker for fast jumping

The content is split left-to-right:

- `Se cazează azi`
- `Pleacă azi`

Both sections list villas/rooms from 1 to 25. Each card represents one reservation row/room and shows:

- accommodation label and room number, for example `Căsuța mică #3`
- guest first and last name
- guest phone number

Check-in cards have a `S-a cazat` button. Clicking it moves the card to the bottom of the section and changes the border from yellow to green.

Check-out cards have an `A plecat` button. Clicking it opens a popup with `Adaugă un feedback clientului` and an optional textbox. Submitting moves the card to the bottom of the section and changes the border from yellow to green.

These states are shared operational state saved in Supabase so refreshes and multiple staff devices stay consistent. They are not stored on the `reservations` table and are not used as guest history. The future problematic-client table and Diana warning notifications are explicitly out of scope for Step 9.

## Poze Tab

The `Poze` tab manages website photo sections:

- `Landing`
- `Căsuță Mică`
- `Căsuță Mare`
- `Hotel`
- `SPA`
- `Teritoriu`
- `Restaurant/Mâncare`
- `Teren de joacă`

Photos are uploaded to Supabase Storage. Metadata in Postgres stores section, order, draft/published state, storage path, alt text, and timestamps.

Diana or Angela can add, remove, replace, and reorder photos inside each section. Changes are draft-only until staff clicks `Publică pozele`. The public website reads only published photos. The first published photo in a section is the main/cover image for that section.

Step 9 should provide the Supabase photo foundation and public helper for reading published photos. Existing public pages should use published Supabase photos where they already have matching photo slots; sections not yet represented in the public UI remain data-ready for later wiring.

## Prețuri Tab

The `Prețuri` tab contains the settings area from the original CRM brief.

Pricing subsection:

- table showing the active 6 price rows
- editable adult and kid price cells
- `Dată intrare în vigoare` picker, defaulting to today
- `Salvează prețuri` action
- upcoming scheduled price changes
- note that existing reservations are not affected by price changes

Holiday subsection:

- list of manually marked holidays with date and label
- add holiday form with date and label
- delete holiday button for each manual holiday

Weekends are not shown in the holiday list.

## Supabase Data Model

### Access

For this phase, admin RLS policies should allow both roles:

```sql
public.ecovila_app_role() in ('diana', 'angela')
```

to manage CRM data. This applies to reservations, rooms, pricing tiers, holidays, cancellation tokens where needed, notification events where needed, photo metadata, and daily operational state.

The existing public guest policies remain restricted. Public guests must not gain direct access to guest reservation details or admin-only tables.

The `reservations.created_by` constraint should support staff-created reservations by both roles by allowing `angela` in addition to the existing `guest` and `diana` values. Existing `guest` behavior remains intact and tests cover the expanded constraint.

### Photos

Add a public Supabase Storage bucket named `ecovila-photos`. The bucket is public for reads, while uploads, updates, and deletes are limited to authenticated users with CRM roles. Storage policies must grant SELECT/INSERT/UPDATE/DELETE as required for upload, upsert, replace, and deletion flows.

Add these photo metadata tables:

- `crm_photo_sections`
- `crm_photos`

`crm_photo_sections` stores the fixed section slugs, labels, and display order.

`crm_photos` stores:

- id
- section slug or section id
- storage path
- alt text
- sort order
- status: `draft` or `published`
- created by
- created at
- updated at
- published at

Publishing is handled by a `publish_crm_photos()` Postgres RPC so replacing the published set with the current draft set happens atomically. The RPC uses CRM-role checks and is executable only by authenticated users. The public website queries only `status = 'published'`, ordered by section and `sort_order`.

### Daily Operational State

Add a table for shared reception state named `crm_daily_statuses`.

It stores:

- reservation id
- service date
- checked-in state and timestamp
- checked-out state and timestamp
- optional checkout note for this operational flow
- updated by
- updated at

Use a unique key on reservation id and service date. This table is for daily operations only and must not drive future problematic-client warnings.

## Frontend Modules

Expected files:

- `admin/index.html`
- `admin/dashboard.html`
- `css/crm.css`
- `admin/js/crm-auth.js`
- `admin/js/crm-app.js`
- `admin/js/crm-dashboard.js`
- `admin/js/crm-calendar.js`
- `admin/js/crm-sidebar.js`
- `admin/js/crm-daily.js`
- `admin/js/crm-photos.js`
- `admin/js/crm-pricing.js`
- shared additions to `js/supabase.js` for CRM queries and public photo reads

The admin modules should keep each tab understandable:

- auth/session logic in one place
- tab switching and shared state in one app shell
- dashboard reservation calendar separate from sidebar forms
- daily reception state separate from reservation editing
- photo upload/publish logic separate from pricing/holidays

## Data Flow

On admin load:

1. create the Supabase client from existing public config
2. verify session
3. load current user role from app metadata
4. load shared CRM data needed by the active tab
5. subscribe to reservation changes for dashboard and pending cash updates

Dashboard:

1. fetch rooms and active reservation range
2. render a wide horizontal calendar
3. update local countdowns every second
4. apply reservation edits through Supabase updates
5. refresh affected rows after changes

Daily:

1. select today's date by default
2. fetch reservations where `check_in = selectedDate` or `check_out = selectedDate`
3. fetch daily operational status rows for those reservations
4. write status rows on `S-a cazat` and `A plecat`
5. re-sort pending cards before completed cards, preserving room-number order inside each group

Photos:

1. fetch photo sections and draft photo rows
2. upload files to Storage
3. create draft metadata rows
4. reorder draft rows by updating sort order
5. publish draft set to become the public published set
6. public pages query published rows only

Prețuri:

1. fetch all pricing rows and holidays
2. compute active price rows from effective dates
3. insert new pricing rows for the selected effective date
4. insert/delete manual holiday rows

## Error Handling

Login errors are shown inline. Missing Supabase config shows an admin-facing setup message.

Supabase read/write failures are shown as compact error banners in the active tab. Destructive actions require typed confirmations. Upload failures leave draft metadata unchanged and show the failed filename. Publish failures leave the previously published set intact.

If realtime subscriptions fail, the app continues with manual refresh and visible stale-state messaging. Cash countdown display is client-side for presentation only; the server-side expiry flow remains authoritative.

## Testing

Add focused Node tests for:

- admin files and tab labels exist
- CRM CSS preserves desktop-only layout and wide dashboard calendar constraints
- Dashboard reservation cards include visible phone and full name slots
- daily tab has check-in/check-out sections and writes to a Supabase-backed status model
- photo sections, draft/publish semantics, and first-photo-as-main behavior are represented
- pricing tab owns pricing and holiday settings
- Supabase migrations add RLS-protected photo and daily-state tables
- public policies do not expose reservation guest details

Existing booking, checkout, pricing, and Edge Function tests must continue to pass.

## Out of Scope

- Step 8 legal pages
- production provider account setup
- Maib production credentials
- SMS.md and Resend production secrets
- permanent guest feedback history
- problematic-client detection or Diana warning notifications
- mobile CRM adaptation
- advanced role separation between Diana and Angela
