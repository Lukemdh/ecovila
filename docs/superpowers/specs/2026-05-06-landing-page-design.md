# EcoVila Landing Page Design

## Scope

Step 1 builds the public landing page only. It creates the static frontend foundation for `ecovila.md`: landing HTML, shared public CSS, landing interactions, multilingual strings, cookie consent, and a local placeholder asset structure for client photos.

## Experience

The page presents EcoVila as a calm, premium forest retreat in Orheiul Vechi. It starts with a full-viewport hero, then moves through SPA, all-inclusive restaurant, relaxing territory, accommodation options, conference room CTA, duplicate reservation CTA, and legal footer. The header has only the logo and RO/RU/EN switcher.

## Visual Direction

Use the `frontend-design` Organic anchor. Palette: sage, clay, terracotta, ochre, moss, sand, and oat. Typography: Fraunces for headings and Epilogue for body. The signature move is framed clearings: large image panels and accommodation cards with soft grain texture, earthy borders, and calm hover motion.

## Files

- `index.html`: Landing page markup.
- `css/main.css`: Shared public design system and landing styles.
- `js/translations.js`: RO/RU/EN translation object and language helpers.
- `js/main.js`: Header scroll state, language switcher, modal behavior, carousel behavior, and cookie consent.
- `assets/logo.svg`: Replaceable placeholder EcoVila logo.
- `assets/photos/*`: Replaceable placeholder image files under the approved folders.
- `tests/landing.test.mjs`: Structural tests for landing-page requirements.

## Asset Folders

- `assets/photos/small-villa/`
- `assets/photos/large-villa/`
- `assets/photos/hotel/`
- `assets/photos/conference-room/`
- `assets/photos/spa/`
- `assets/photos/territory/`
- `assets/photos/restaurant/`
- `assets/photos/other/`

## Behavior

Language switching updates all `data-i18n` strings and persists to `localStorage`. The accommodation cards open a modal with translated details. The header becomes solid on scroll. Cookie consent appears on first visit and stores the choice in `localStorage`. The CTA points to `rezervari.html`, ready for the next step.

## Out of Scope

Booking logic, Supabase integration, pricing, CRM, real availability, legal-page body content, and payment flows are not part of Step 1.
