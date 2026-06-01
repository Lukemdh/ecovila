# EcoVila Legal Pages Design

## Scope

Step 8 adds the two missing public legal pages required by the project brief:

- `politica-confidentialitate.html`
- `termeni-conditii.html`

The pages complete the existing checkout and footer links without changing the booking flow, CRM, backend schema, or production integrations.

## Source of Truth

The supplied Romanian markdown files are the canonical content source for this step:

- `docs/politica-confidentialitate.md`
- `docs/termeni-conditii.md`

The rendered legal body remains Romanian only. The public site shell may still switch between RO/RU/EN for shared interface text such as footer labels, cookie banner copy, and navigation controls, but legal article text does not change language.

The detailed supplied Terms markdown controls the refund wording for this step. It uses a 7-calendar-day refund window, even though the older project-brief summary mentions 72 hours.

## Implementation Approach

Build two explicit static HTML pages rather than introducing a shared runtime template or browser-side markdown rendering.

This best matches the current vanilla HTML/CSS/JS architecture and static hosting target:

- the legal content is visible in the final HTML without JavaScript
- the pages remain easy to audit and update
- there is no parser dependency or unnecessary client-side fetch path
- only two pages exist, so duplication is cheaper than abstraction

## Public Shell

Each legal page reuses the same public-site structure already present on the landing, booking, checkout, confirmation, and cancellation pages:

- skip link
- sticky header with EcoVila logo
- RO/RU/EN language selector
- reservation CTA in the header
- shared footer with contact details, social links, and useful links
- cookie-consent banner
- existing public JavaScript for header, language, and cookie behavior

Footer links on the rest of the site continue to point to the two root-level legal pages.

## Page Layout

The pages use a dedicated long-form reading layout that stays visually consistent with the current EcoVila design language:

- warm paper background and existing serif/sans-serif typography
- compact hero area with page title and short introductory framing text
- centered article column with comfortable line length
- semantic heading hierarchy that mirrors the markdown sections
- readable spacing for paragraphs and bullet lists
- restrained card or surface treatment so long legal content feels calm rather than decorative

Legal-page-specific styles live in `css/legal.css` so long-form reading styles do not leak into the booking or landing-page CSS.

## Content Structure

### Privacy Policy

`politica-confidentialitate.html` renders the full Romanian privacy-policy markdown, including:

- controller identity
- collected personal data
- purposes and legal bases
- processor sharing
- international transfers
- cookies
- marketing and CCTV
- retention
- data-subject rights
- security and update clauses

### Terms and Conditions

`termeni-conditii.html` renders the full Romanian terms markdown, including:

- provider details
- booking and payment rules
- capacity and room-assignment rules
- check-in/check-out times
- access rules and minor policy
- internal house rules and SPA rules
- cancellation, refunds, no-show, and modification policy
- liability, force majeure, complaints, governing law, and versioning clauses

The HTML should preserve the supplied legal wording except for markup transformations required to represent markdown headings, paragraphs, and lists semantically.

## Multilingual Behavior

Shared site chrome keeps using the existing `data-i18n` translation system and stored language preference.

The legal body is intentionally Romanian only. To avoid implying that translated legal text exists, the pages do not attach `data-i18n` attributes to article headings or paragraphs, and each page includes a short Romanian-only note that the displayed legal version is the Romanian text.

## Accessibility and Semantics

Each page includes:

- a valid skip target
- one visible `<h1>`
- ordered heading levels beneath it
- semantic `<main>` and `<article>` landmarks
- real lists where the markdown uses lists
- visible focus states inherited from the public design system

The long-form layout must remain readable on narrow screens without horizontal scrolling.

## Expected Files

- `politica-confidentialitate.html`
- `termeni-conditii.html`
- `css/legal.css`
- `tests/legal-pages.test.mjs`

No new runtime JavaScript file is required unless verification reveals a small legal-page-specific behavior that cannot be handled by existing public scripts.

## Verification

Automated checks should confirm that:

- both root-level legal HTML files exist
- both pages include the shared public header, footer, and cookie banner hooks
- both pages include their expected canonical headings and key section text
- the legal body is not wired to the multilingual translation map
- existing footer and checkout links still target the correct pages

Manual browser verification should confirm:

- readable desktop typography and line length
- clean mobile stacking and spacing
- consistent header/footer appearance with the rest of the public site
- working language selector for shared chrome
- no broken anchor paths or missing assets

## Out of Scope

- translating the legal body into Russian or English
- rewriting or legally reviewing the supplied Romanian copy
- changing the project-wide footer data placeholders
- changing cancellation logic in the live booking flow
- backend, CRM, deployment, or third-party integration work
