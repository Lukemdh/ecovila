# EcoVila — Full Project Brief for Claude Code

## What You Are Building

A full-stack booking platform for **EcoVila** — a premium all-inclusive villa complex located in Orheiul Vechi, Moldova. The platform has two distinct parts:

1. **Public website** (`ecovila.md`) — landing page + booking flow for guests
2. **CRM dashboard** (`admin.ecovila.md`) — reservation management tool for staff (Diana)

This is a **vanilla HTML/CSS/JS** project. No frameworks. Use Supabase as the backend.

---

## Tech Stack

| Layer | Tool |
|---|---|
| Frontend | Vanilla HTML, CSS, JS |
| Database + Auth + Realtime | Supabase (Postgres) |
| Serverless functions | Supabase Edge Functions (Deno/TypeScript) |
| SMS notifications | SMS.md API (called from Edge Functions) |
| Email notifications | Resend API (called from Edge Functions) |
| Card payments | Maib ePay (redirect-based integration) |
| Hosting | tophost.md (shared cPanel hosting — static files only, no Node.js) |

**Critical note on hosting:** tophost.md is shared cPanel hosting. There is no Node.js server. All server-side logic (SMS, email, payment callbacks, timer management) MUST run in Supabase Edge Functions, not on the host. The frontend communicates with Supabase directly via the Supabase JS client (`@supabase/supabase-js` loaded from CDN).

---

## Design Direction

Use the `frontend-design` skill before writing any UI code. The aesthetic should reflect the nature of the property:

- **Setting:** Forest, nature, rustic-luxury, calm
- **Feel:** Warm, premium, trustworthy — not generic hotel booking site
- **Propose a color palette** centered around earthy, natural tones (deep greens, warm creams, natural wood tones, stone). Avoid cold blues, flat whites, or anything that looks corporate. The palette should feel like walking into a forest clearing.
- **Typography:** Choose distinctive, characterful fonts — a refined serif or organic display font for headings, a clean but warm body font. Avoid Inter, Roboto, Arial.
- **CRM aesthetic:** Functional, clean, professional. Can share the color palette but prioritize clarity and density of information over beauty.

Logo and photos will be placed in the project folder by the client. Use placeholder paths (`/assets/logo.svg`, `/assets/photos/`) in all code.

---

## Property Details

### Accommodation Types

| Type | Internal ID | Room Numbers | Max Capacity | Min Billing Floor | Auto-assign Direction |
|---|---|---|---|---|---|
| Căsuță Mică (small villa) | `small` | 1–8 (8 rooms) | 2 adults + 2 kids | 2 adults | Decreasing (8 first, 1 last) |
| Căsuță Mare (big villa) | `large` | 9–15 (7 rooms) | 4 adults + 2 kids | 3 adults | Increasing (9 first, 15 last) |
| Cameră în Hotel (hotel room) | `hotel` | 16–25 (10 rooms) | 2 adults + 2 kids | 2 adults | Increasing (16 first, 25 last) |

**Total: 25 rooms.**

Each căsuță mare has 2 separate bedrooms + a living room. The hotel is one building with 10 rooms.

### Extra: Conference Room
Available for business guests. **NOT bookable online.** Guests must call Diana to arrange. The website displays it as a feature ("Planificați un seminar? Contactează-ne pentru ofertă") with a contact CTA at the bottom of the landing page.

---

## Pricing Logic

### Age Definition
- **Adult:** 13 years and older
- **Kid:** 12 years and under

### Minimum Occupancy Billing Rules

These rules apply per accommodation unit, **regardless of how many people actually stay:**

- **Căsuță mică / Cameră în hotel** → always bill minimum 2 adults
  - 1 adult alone → charged as 2 adults
  - 1 adult + 1 kid → kid is charged at adult rate (fills the 2nd adult slot)
- **Căsuță mare** → always bill minimum 3 adults
  - 2 adults + 2 kids → 1 kid charged at adult rate, 1 kid at kid rate
  - 2 adults + 1 kid → kid charged at adult rate (fills the 3rd adult slot)
  - 1 adult + 2 kids → 2 kids charged at adult rate (fills 2nd and 3rd adult slots)
- **Kids-only bookings are not allowed** through the public website. The website must show an error if 0 adults are selected. Diana can override this in the CRM.

### Night-Based Pricing (MDL per person per night)

> **Important:** All bookings are night-based. "1 night" = arrive Day 1, depart Day 2. The total duration determines which price tier applies.

| Tier | Day Type | Adult | Kid |
|---|---|---|---|
| 1 night | Weekday | 1100 | 900 |
| 1 night | Weekend / Holiday | 1300 | 1000 |
| 2 nights | Weekday | 1000 | 800 |
| 2 nights | Weekend / Holiday | 1200 | 900 |
| 3+ nights | Weekday | 900 | 700 |
| 3+ nights | Weekend / Holiday | 1100 | 800 |

**Mixed-stay rule:** The price **tier** (1 / 2 / 3+) is determined by the **total number of nights** in the stay. Within that tier, each individual night is billed at weekday or weekend/holiday rate depending on the next morning: if the next day is Saturday, Sunday, or a manually marked holiday, that night is premium.

Example: 3-night stay, Friday–Monday. Tier = 3+ nights.
- Friday night → holiday rate → adult 1100
- Saturday night → holiday rate → adult 1100
- Sunday night → weekday rate → adult 900
→ Sunday-to-Monday is billed at the standard weekday rate unless Monday is manually marked as a holiday

Example: 3-night stay, Wednesday–Saturday. Tier = 3+ nights.
- Wednesday night → weekday rate → adult 900
- Thursday night → weekday rate → adult 900
- Friday night → holiday rate → adult 1100

Example: if May 1 is manually marked as a holiday:
- April 30 night → holiday rate, because guests wake up on the holiday
- The holiday date itself does not automatically make the following night premium; the following night depends on its own next morning

### Weekends vs Holidays
- **Weekend-rate nights** (Friday-to-Saturday and Saturday-to-Sunday) are always premium rate — hardcoded.
- **Sunday-to-Monday nights** are standard weekday rate unless Monday is manually added as a holiday.
- **Holidays** are stored in a database table (`holidays`) as the free day dates and can be added/removed by Diana from the CRM settings. The night before a holiday is premium.
- **Weekend-rate nights are NOT shown** in Diana's holiday list — only manually added holiday dates appear there.

### Price Table in Database
Prices are stored in a `pricing_tiers` table. Diana can update prices from the CRM with an **effective date**:
- New prices apply to all **future reservations** created on or after the effective date.
- **Existing reservations are never retroactively repriced**, even if the stay is after the effective date.
- Diana can see the currently active prices and any upcoming scheduled price changes.

---

## Database Schema

### Table: `rooms`
```sql
id uuid PRIMARY KEY
number integer UNIQUE NOT NULL  -- 1-25
type text NOT NULL               -- 'small' | 'large' | 'hotel'
is_active boolean DEFAULT true
```

### Table: `pricing_tiers`
```sql
id uuid PRIMARY KEY
nights_tier integer NOT NULL     -- 1, 2, 3 (3 = "3 or more")
day_type text NOT NULL           -- 'weekday' | 'holiday'
adult_price integer NOT NULL     -- MDL
kid_price integer NOT NULL       -- MDL
effective_from date NOT NULL
created_at timestamptz DEFAULT now()
```
*Query: for a given booking date, use the pricing row with the highest `effective_from` that is <= today's date (the date the reservation is being created).*

### Table: `holidays`
```sql
id uuid PRIMARY KEY
date date UNIQUE NOT NULL
label text                       -- e.g. "Ziua Națională"
created_by uuid REFERENCES auth.users
created_at timestamptz DEFAULT now()
```

### Table: `reservations`
```sql
id uuid PRIMARY KEY
room_id uuid REFERENCES rooms(id)
guest_first_name text NOT NULL
guest_last_name text NOT NULL
guest_phone text NOT NULL        -- format: +373XXXXXXXX
guest_email text NOT NULL
check_in date NOT NULL           -- arrival date (check-in 13:00)
check_out date NOT NULL          -- departure date (check-out 10:00)
adults integer NOT NULL
kids_ages integer[]              -- array of ages, e.g. {5, 8}
total_price integer NOT NULL     -- MDL, calculated at booking time
payment_type text NOT NULL       -- 'cash' | 'card'
payment_status text NOT NULL     -- 'pending' | 'paid' | 'cancelled'
room_explicitly_selected boolean DEFAULT false  -- guest chose the room number themselves
conference_room boolean DEFAULT false
notes text                       -- Diana's internal notes (visible at reception)
cash_expires_at timestamptz      -- set for cash payments (30 min from creation, +10 min for Diana's view)
cash_extended boolean DEFAULT false  -- has the guest already used their 1 extension
created_by text DEFAULT 'guest'  -- 'guest' | 'diana'
created_at timestamptz DEFAULT now()
cancelled_at timestamptz
cancellation_reason text
```

### Table: `cancellation_tokens`
```sql
id uuid PRIMARY KEY
reservation_id uuid REFERENCES reservations(id)
token text UNIQUE NOT NULL       -- random secure token
used boolean DEFAULT false
created_at timestamptz DEFAULT now()
```

### RLS Policies
- **Public (anon key):** Can INSERT into `reservations`, SELECT from `rooms`, `pricing_tiers`, `holidays`. Cannot SELECT other guests' reservations directly (only by their own cancellation token). Cannot UPDATE or DELETE anything.
- **Diana (authenticated, role = 'diana'):** Full CRUD on all tables.
- **Angela (authenticated, role = 'angela'):** SELECT only on all tables. (For future implementation.)

---

## Public Website — Pages & Flow

### Domain: `ecovila.md`

### Page 1: Landing Page (`/`)

**Header (sticky):**
- Left: EcoVila logo (links to `#top`)
- Right: Language switcher (RO / RU / EN) — switches all page text. Default = RO.
- No navigation menu. The header is transparent over the hero, turns solid on scroll.

**Hero section:**
- Full-viewport background (photo of property or forest)
- Greeting headline + short tagline (nature, relaxation, all-inclusive)
- Primary CTA button: **"Către rezervări →"** → links to `/rezervari`

**Scrollable showcase sections (in order):**

Each section (1–4) follows the same two-column layout:
- **Left side:** a gallery image box — a fixed-size container showing multiple photos for that section. Can be a simple image carousel/slider, a static grid of 2–3 photos, or a stacked collage — Claude Code should choose what looks best for the aesthetic. The image box takes roughly half the horizontal width on desktop.
- **Right side:** the section title + descriptive text, filling the remaining space up to the right margin.
- **On mobile / narrow viewports:** the image box stacks on top, text goes below it, both full width.

1. **Zona SPA** — photos of the spa facilities. Text: 2 piscine interioare, 1 piscinã exterioarã, jacuzzi, 3 tipuri de saună, salina, cameră rece, piscina rece
2. **All-Inclusive** — photos of food, dining, restaurant area. Text: 3 mese pe zi, deserturi, cafea, ceai, apă dulce — toate incluse
3. **Teritoriu Relaxant** — photos of the forest grounds, outdoor areas. Text: "Ne aflăm în inima pădurii" — nature-forward section
4. **Cazare** — gallery/carousel showcasing the 3 accommodation types (căsuță mică, căsuță mare, cameră în hotel). Cards with photos, names, and brief description of each type. Clicking opens a modal with more details and photos. *(This section may deviate from the two-column layout if a full-width card carousel fits better — Claude Code's judgment.)*
5. **Conference Room section** (bottom of page) — "Planificați un seminar? Contactați-ne pentru ofertă." Show the conference hall. Include phone number for Diana.
6. **Duplicate CTA** — Same "Către rezervări →" button
7. **Footer** — see Legal Requirements section below

---

### Page 2: Booking Page (`/rezervari`)

**Header:** Same as landing (logo + language switcher only).

**Section 1 — Guest & Date Selector (top of page, always visible)**

Left side: **Persons selector**
- "Adulți" counter (min 1, max depends on accommodation — but at this stage just allow up to 10, validation happens when accommodation is shown)
- "Copii" counter (min 0). When a child is added, a small input appears for their age (0–12). Exactly like Booking.com child age selector. Ages are required before proceeding.
- If 0 adults are selected and user tries to proceed → show inline error: "Trebuie să fie cel puțin un adult în rezervare."

Right side: **Date selector**
- Two date inputs: "Check-in" and "Check-out" (clicking opens an inline calendar)
- Calendar shows month view. Dates that have NO availability for ANY room type fitting the selected group size are crossed out / greyed.
- The calendar checks availability **after** the person count is entered. If no persons selected yet, calendar shows general availability.
- Check-in and check-out are on the same calendar — user selects a range.
- Minimum stay: 1 night. Same-day check-in/check-out not allowed.
- Crossed-out dates: a date is fully unavailable if ALL rooms of ALL types that could fit the selected group are occupied for that night.

**Section 2 — Accommodation Cards**

Three cards displayed side by side (or stacked on mobile — but mobile is not the priority):

- **Căsuță Mică** — photo, "Până la 2 adulți + 2 copii", earliest available dates shown, price preview
- **Căsuță Mare** — photo, "Până la 4 adulți + 2 copii", earliest available dates shown, price preview
- **Cameră în Hotel** — photo, "Până la 2 adulți + 2 copii", earliest available dates shown, price preview

**Card states:**
- **Default (no dates selected):** Shows earliest available date for that type and a price preview.
- **Dates + persons selected:** Shows price for the selected stay, and how many units of this type are available. E.g. "2 căsuțe disponibile".
- **Sold out:** Card is greyed out, "Epuizat" badge on top. Below: button **"Vreau așa căsuță"** → opens a modal calendar showing all dates when this accommodation type has availability for the selected group size.
- **Clicking a card (when available):** Opens a modal popup with extended description, photo gallery, amenities list, and a **"Rezervă"** button.

**Accommodation fitting logic:**
- A single căsuță mică or hotel room fits up to 2 adults + 2 kids.
- A single căsuță mare fits up to 4 adults + 2 kids.
- If the group is larger, show multiple units. Example: 4 adults → show "2x Căsuță Mică" or "1x Căsuță Mare".
- Pricing shown on card must apply the minimum billing floor rules (see Pricing Logic above).

**"Vreau să-mi aleg numărul căsuței" button** (below each available card):
- Opens a panel listing all available room numbers for that type during the selected dates.
- User can select one. Selection is shown on the card ("Căsuța #5 selectată").
- If user does NOT select, auto-assignment happens at checkout.

---

### Page 3: Checkout (`/checkout`)

**Summary panel (top):**
- Selected dates (check-in / check-out, number of nights)
- Number of adults + kids (with ages)
- Accommodation type + room number (if explicitly selected, otherwise "Numărul va fi atribuit automat")
- Price breakdown (per night × people, including minimum floor adjustments, weekday vs weekend split if applicable)
- **Total price in MDL**

**Guest details form:**
- Prenume (First name) — required
- Nume (Last name) — required
- Telefon (+373 prefix pre-filled, editable) — required
- Email — required
- GDPR checkbox (required, must be checked to proceed): *"Am citit și sunt de acord cu [Politica de Confidențialitate] și [Termenii și Condițiile]."* Both links open in new tab.

**Payment selection:**
- Two buttons/cards: **"Plată cu cardul"** and **"Plată cash"**

When **"Plată cash"** is selected, a disclaimer appears below:
> *"Rezervarea este valabilă 30 de minute și trebuie achitată la oficiu, str. Aerodromului 3. Dacă termenul expiră, rezervarea va fi anulată automat."*

When **"Rezervă"** is clicked (cash flow):
1. Reservation is created in Supabase with `payment_status = 'pending'`, `cash_expires_at = now() + 30 minutes`.
2. User is redirected to `/confirmare?id=RESERVATION_ID`.
3. SMS + email confirmation sent via Edge Function.
4. Diana's CRM sidebar shows the pending payment immediately (real-time via Supabase subscription).

When **"Rezervă"** is clicked (card flow):
1. Reservation is created in Supabase with `payment_status = 'pending'`.
2. User is redirected to Maib ePay payment page.
3. On successful payment → Maib ePay calls Supabase Edge Function webhook → `payment_status` updated to `'paid'` → SMS + email confirmation sent.
4. On failed/cancelled payment → reservation deleted (or marked cancelled).

---

### Page 4: Confirmation (`/confirmare`)

**For cash (pending payment):**
- Shows: reservation summary, total amount, office address (str. Aerodromului 3), a countdown timer (counting down from 30 minutes — value fetched from `cash_expires_at` in DB, NOT calculated client-side).
- Two buttons:
  - **"Extinde"** — adds 30 minutes once. After used, button is greyed out and hidden. Makes an API call to update `cash_expires_at` and set `cash_extended = true`.
  - **"Anulează"** — cancels the reservation immediately. Shows confirmation prompt first.
- If user returns to this page after expiry: show popup — *"Rezervarea dvs. a fost anulată deoarece a expirat termenul de achitare. Vă rugăm să rezervați din nou."*

**For card (paid):**
- Shows: confirmation message, reservation summary, reminder of check-in time (13:00), no-pets policy reminder.

---

### Page 5: Cancellation (`/anulare`)

Accessed via a unique link sent in the SMS/email confirmation: `/anulare?token=CANCELLATION_TOKEN`

**Flow:**
1. Page loads, fetches reservation by token.
2. Shows: reservation details (dates, accommodation type, room number, total paid).
3. Checks if cancellation is allowed: `check_in - now() >= 72 hours`.
   - If YES → show **"Anulează rezervarea"** button.
   - If NO → show message: *"Rezervarea nu mai poate fi anulată cu mai puțin de 72 de ore înainte de sosire. Contactați-ne la [phone]."*
4. When "Anulează" is clicked → ask for phone number confirmation (must match `guest_phone` on the reservation).
5. On match → reservation cancelled, room freed, cancellation SMS + email sent, token marked as used.

---

## Cash Reservation Timer — Server-Side Logic

**IMPORTANT:** The timer MUST be server-side. Implementation:

1. A Supabase Edge Function runs on a schedule (e.g., every minute via `pg_cron` or Supabase's cron) to check for expired cash reservations (`cash_expires_at < now()` AND `payment_status = 'pending'` AND `payment_type = 'cash'`).
2. Expired reservations are automatically cancelled (status → `'cancelled'`, room freed).
3. Diana sees the reservation as pending in yellow in her CRM with live countdown. Her view has an extra 10-minute buffer — i.e., she sees it as "expired" 10 minutes after the guest's timer runs out, giving her time to manually mark it as paid if the guest is physically present at the office.
4. `cash_expires_at` for Diana's threshold = guest's `cash_expires_at + 10 minutes`.

---

## CRM Dashboard — `admin.ecovila.md`

### Authentication
- Supabase Auth (email + password)
- Diana: one account, full read/write access
- Login page is the entry point of admin.ecovila.md. After login, redirect to dashboard.
- Language: **Romanian only**
- Desktop only — not adapted for mobile

### Layout

**Left sidebar (fixed, ~280px wide):**
Contains all controls. No popups unless explicitly specified. All form fields open inline in the sidebar. The sidebar is the single source of action — nothing opens in a separate page.

**Main content area:**
The reservation calendar.

---

### Sidebar Sections (in order)

#### 1. Pending Cash Payments
Always visible below the main buttons in the sidebar, in a separate „Pending Payments” section. Shows all pending cash reservations across ALL dates (including ones months in the future):

```
📋 Plăți Cash în Așteptare
─────────────────────────
Căsuța 23 · Cash · 2800 MDL
⏱ 24:38 rămase
[Marchează ca Plătit]

Căsuța 7 · Cash · 1900 MDL
⏱ 08:12 rămase
[Marchează ca Plătit]
```

Timers are live (real-time via Supabase subscription). The displayed time is based on Diana's extended threshold (`cash_expires_at + 10 min`). "Marchează ca Plătit" button marks `payment_status = 'paid'`, triggers confirmation SMS+email, removes from pending list.

---

#### 2. Adaugă Rezervare
Form opens inline in sidebar when clicked:

1. **Persoane:** Adults counter + Kids counter (with ages). No restrictions — Diana can set kids-only (0 adults) if needed.
2. **Căsuțe:** Diana selects accommodation units with no restrictions. She can mix and match — e.g., assign 2 small villas to one group. She can add multiple room numbers.
3. **Cameră de conferință:** A toggle switch. If enabled, conference room is added to the booking.
4. **Date:** Calendar date range selector. Shows availability.
5. **Date personale:** First name, last name, phone (+373 pre-filled), email.
6. **Plată:** Cash or Card selector.
7. **Note:** Free text notes for reception (Angela).
8. **Total:** Auto-calculated price shown live as Diana fills in the form, following all pricing rules.
9. **"Adaugă Rezervare"** button → creates reservation.

---

#### 3. Caută Rezervare
Three optional search fields (at least one required):

- **Data** — date picker. Selecting only a date scrolls the main calendar to that date.
- **Nume/Prenume** — text input. Shows a list of all future matching reservations in a results panel.
- **Telefon** — (+373 pre-filled, deletable) text input. Same behavior.

Results shown as cards in sidebar: name, dates, room, status. Clicking a result opens the reservation detail popup.

---

#### 4. Setări (Settings)
Two subsections:

**A. Prețuri**
- Table showing all current active prices (6 rows: 1 night weekday/weekend, 2 nights weekday/weekend, 3+ nights weekday/weekend).
- Diana can edit any price cell.
- Below the table: **"Dată intrare în vigoare"** date picker. Default = today.
- **"Salvează Prețuri"** button — saves new pricing row with effective date.
- Below: shows upcoming scheduled price changes if any exist.
- Note displayed: *"Rezervările existente nu vor fi afectate de modificări de preț."*

**B. Zile de Sărbătoare**
- List of all currently marked holidays (date + label). Weekends not shown here.
- **"Adaugă zi"** form: date picker + label input + "Adaugă" button.
- Each existing entry has a **"Șterge"** button.

---

### Main Content: Reservation Calendar

**Layout:**
- Horizontal scroll (left = earliest date, right = future dates).
- Columns = calendar dates (each column = 1 day). Date shown at top of each column.
- Rows = room numbers 1–25. Room number shown on the left.
- The calendar starts at today's date on load.

**Reservation cards:**
- Each reservation appears as a colored card spanning the columns it occupies (check-in to check-out, exclusive of check-out day).
- Card shows: **guest phone + guest name/surname** (truncated if needed, full visible on hover).
- Multi-night cards stretch across days.

**Card colors:**
- 🟡 **Yellow** — Cash, pending payment (shows countdown timer on card)
- 🟣 **Purple** — Cash, paid
- 🟢 **Green** — Card payment, paid
- ⚪ **Grey** — Cancelled (optionally hidden by default with a toggle)

**Drag & Drop:**
- Diana can drag a card to a different row (different room) or different column (different date), or both.
- **Room change:** moves the reservation to the new room number.
- **Date change:** shifts the entire stay by the number of days dragged.
- **Swap logic:** If Diana drags card from room 4 to room 6's slot (and room 6 already has a reservation for those dates), the two reservations **swap room numbers**. Both reservations' room assignments are exchanged.
- **Special rule:** If either reservation involved has `room_explicitly_selected = true` (guest picked the room themselves), Diana is shown a confirmation popup before the swap executes. She must type **"schimba"** to confirm.
- **Type change (e.g., small villa to large villa):** If dragging changes the accommodation type (e.g., room 5 → room 10), a popup appears: *"Introduceți numărul de persoane (adulți / copii)"* and the system recalculates the total price.

**Clicking a reservation card:**
Opens a popup with:
- **Dates** — editable date range. System validates that the number of people still fits; if not, shows warning. Diana can proceed anyway.
- **Persoane** — adults + kids (with ages). Diana CAN exceed capacity limits.
- **Nume / Prenume** — editable text fields.
- **Telefon** — editable.
- **Note** — free text, visible to reception.
- **Tip plată** — read-only display (cash/card + status).
- **Preț total** — recalculated live if people or dates change. Shown prominently.
- **"Salvează Modificări"** button.
- At the very bottom: red **"Șterge Rezervarea"** button. Clicking reveals a text input — Diana must type **"sterge"** to confirm deletion. On confirm: reservation is cancelled, room freed, cancellation SMS + email sent to guest.

---

## SMS & Email Notifications

### Infrastructure
All notifications are triggered via **Supabase Edge Functions**. The frontend never calls SMS.md or Resend directly (API keys must not be exposed in client-side code).

### SMS Provider: SMS.md
- HTTP API
- Sender name: "EcoVila" (register as sender name with SMS.md)
- Language: match guest's selected language at booking time

### Email Provider: Resend
- Branded HTML emails
- From: `rezervari@ecovila.md`

### Notification Triggers & Content

#### 1. Booking Confirmation (immediate, on reservation creation)
**SMS:**
```
EcoVila: Rezervarea dvs. a fost confirmată!
Căsuța #{room_number}, {check_in} – {check_out}
Total: {total_price} MDL ({payment_type})
Anulare (72h+): {cancellation_link}
```
**Email:** Full HTML confirmation with all details, cancellation policy reminder, check-in instructions (13:00), house rules summary.

#### 2. Cash Payment Reminder (send at T-5 minutes before expiry, if still pending)
**SMS:**
```
EcoVila: Rezervarea dvs. expiră în 5 minute.
Achitați la str. Aerodromului 3 sau extindeți pe site: {confirmation_link}
```

#### 3. Cash Reservation Cancelled (auto-expiry)
**SMS:**
```
EcoVila: Rezervarea dvs. a fost anulată deoarece termenul de achitare a expirat.
Puteți rezerva din nou pe ecovila.md
```

#### 4. Cancellation Confirmation (when guest cancels via link or Diana cancels)
**SMS:**
```
EcoVila: Rezervarea dvs. ({check_in} – {check_out}, Căsuța #{room}) a fost anulată.
```
**Email:** Cancellation summary.

#### 5. 24h Arrival Reminder
**SMS (sent at ~10:00 the day before check-in):**
```
EcoVila: Vă așteptăm mâine! Check-in de la 13:00.
Vă rugăm să rețineți: accesul cu animale de companie nu este permis pe teritoriul complexului.
Adresa: [address]. Ne vedem mâine!
```

---

## Cancellation Policy

### Guest-initiated (via cancellation link):
- **More than 72 hours before check-in:** Allowed. Room freed immediately. Cancellation SMS + email sent.
- **Less than 72 hours before check-in:** NOT allowed via website. Message shown: *"Rezervarea nu mai poate fi anulată online. Contactați-ne la [phone]."*

### Diana-initiated (from CRM):
- Can cancel any reservation at any time with no restriction.
- Must type "sterge" to confirm.
- Cancellation SMS + email always sent to guest on Diana-initiated cancellations.

### Refund policy (display in T&C and on cancellation page):
- Cancellation 72h+ before arrival → full refund
- Less than 72h → no refund (guest must call Diana)

---

## Legal Requirements (Moldova)

### Compliance with:
- **Legea nr. 133/2011** privind protecția datelor cu caracter personal
- **Legea nr. 195/2024** (enters into force **23 August 2026** — build fully compliant from day one; this is Moldova's GDPR equivalent)
- **Legea nr. 105/2003** privind protecția consumatorilor

### Required elements on website:

#### Footer (every page):
- **Company legal name** (to be filled by client)
- **IDNO** (fiscal code — to be filled by client)
- **Adresa sediului** (registered address — to be filled by client)
- **Telefon:** (to be filled by client)
- **Email:** rezervari@ecovila.md
- Links: [Politica de Confidențialitate] | [Termeni și Condiții] | © 2026 EcoVila

#### Booking form (checkout page):
- Required checkbox (must be ticked to submit): *"Am citit și sunt de acord cu [Politica de Confidențialitate] și [Termenii și Condițiile]."*
- Both links open in new tab.

#### Cookie consent banner:
- Shown on first visit to any public page.
- Two buttons: **"Accept"** and **"Refuz"** (or "Accept doar esențiale").
- Consent stored in localStorage. No tracking cookies set before consent.
- Under Legea 195/2024, consent must be freely given, specific, informed, and unambiguous.

#### Privacy Policy page (`/politica-confidentialitate`):
Must include:
- What data is collected (name, phone, email, booking details)
- Purpose of processing (reservation management, notifications)
- Data retention period (e.g., 3 years after stay completion)
- Guest rights: access, rectification, deletion, portability
- Contact for data requests: (company email)
- Third-party processors: Supabase (hosting/database), Resend (email), SMS.md (SMS), Maib (payments)
- Note that data is NOT sold or shared with third parties beyond processors listed above
- Legal basis: contract performance + consent

#### Terms & Conditions page (`/termeni-conditii`):
Must include:
- Booking and payment terms
- Cancellation policy (72h rule, refund conditions)
- Check-in / check-out times (13:00 / 10:00)
- House rules: no pets, no outside food/drinks on premises, access only for paying guests
- Pricing disclaimer (prices in MDL, all-inclusive)
- Force majeure clause
- Applicable law: Republic of Moldova
- Dispute resolution contact

---

## Multilingual Support

The public website supports **3 languages: Romanian (RO), Russian (RU), English (EN).**

Implementation approach:
- All UI strings stored in a JS translation object per language: `translations.ro`, `translations.ru`, `translations.en`.
- A `setLanguage(lang)` function swaps all `data-i18n` attribute elements.
- Language preference stored in `localStorage`.
- Default language: **RO**.
- Language switcher in header (visible on all public pages).

The CRM (admin.ecovila.md) is **Romanian only** — no language switcher needed.

---

## File / Page Structure

```
ecovila.md (tophost.md hosting)
├── index.html              ← Landing page
├── rezervari.html          ← Booking page
├── checkout.html           ← Checkout
├── confirmare.html         ← Post-booking confirmation (cash countdown)
├── anulare.html            ← Cancellation page (via token link)
├── politica-confidentialitate.html
├── termeni-conditii.html
├── css/
│   ├── main.css
│   ├── booking.css
│   └── crm.css
├── js/
│   ├── supabase.js         ← Supabase client init
│   ├── translations.js     ← i18n strings for all 3 languages
│   ├── booking.js          ← Booking flow logic
│   ├── pricing.js          ← All pricing calculations
│   ├── calendar.js         ← Availability calendar
│   └── checkout.js         ← Checkout + payment flow
├── assets/
│   ├── logo.svg
│   └── photos/             ← Client will populate
└── admin/                  ← Or separate subdomain admin.ecovila.md
    ├── index.html          ← Login page
    ├── dashboard.html      ← CRM main dashboard
    └── js/
        ├── crm-calendar.js ← Drag-drop calendar
        ├── crm-sidebar.js  ← All sidebar logic
        └── crm-settings.js ← Pricing + holidays management

Supabase Edge Functions (deployed to Supabase, NOT tophost):
├── send-sms/               ← SMS.md integration
├── send-email/             ← Resend integration
├── expire-cash-reservations/ ← Cron: cancel expired cash bookings
├── maib-webhook/           ← Maib ePay payment callback
└── send-reminders/         ← Cron: 24h arrival reminders + 5min cash warning
```

---

## Key Business Rules Summary (Quick Reference)

1. Only paying guests allowed on premises — enforced by reception, not website
2. No pets — displayed in rules, T&C, and arrival reminder SMS
3. No outside food/drinks — displayed in T&C
4. Conference room: website shows it as a feature, booking only via phone (Diana)
5. Kids-only reservations not allowed on website; Diana can override in CRM
6. Cash payments: 30 min timer (server-side), 1 extension available to guest, Diana sees +10 min extra
7. Card payments: handled via Maib ePay redirect; Edge Function webhook confirms payment
8. Room auto-assign: căsuță mică decreasing (8→1), căsuță mare + hotel increasing
9. If guest explicitly chose room number: Diana sees warning + must type "schimba" before any room swap in CRM
10. Pricing is locked at booking creation time — price changes never affect existing reservations
11. Cancellation: guest can cancel 72h+ before arrival; under 72h only Diana can cancel
12. All SMS/email via Edge Functions (never from browser — API keys stay server-side)
13. CRM is desktop-only, Romanian-only, Supabase Auth protected
14. Legal compliance: Legea 195/2024 (Moldova GDPR, in force Aug 23 2026), full privacy policy, cookie consent, T&C required
