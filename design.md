# EcoVila Design Language

A living document describing the visual and interaction system used across the EcoVila website and booking platform.

---

## Palette

| Token | Hex | Role |
|-------|-----|------|
| `--paper` | `#F7F4EF` | Page background, warm off-white |
| `--white` | `#FFFFFF` | Card surfaces |
| `--espresso` | `#33261F` | Primary text, filled buttons, headings |
| `--ink` | `#332F2C` | Body text |
| `--cocoa` | `#8B7564` | Subdued accents, icons, botanical motifs |
| `--muted` | `#6E6760` | Secondary text, labels, placeholders |

Accent palette (semantic only — never decorative):

| Semantic | Hex | Usage |
|----------|-----|-------|
| Amber warning | `rgba(192,142,58,0.14)` bg / `#A07720` text | Cash pending badge, timer warning |
| Red critical | `rgba(198,107,61,0.12)` bg / `#7B2E1D` text | Error states, danger buttons |
| Forest success | `rgba(96,108,56,0.12)` bg / `#3a6b2a` text | Confirmed, cancelled-success |

---

## Typography

Two typefaces, always paired:

```css
--heading-font: 'Cormorant Garamond', Georgia, serif;
--body-font:    'Montserrat', system-ui, sans-serif;
```

| Level | Font | Size | Weight |
|-------|------|------|--------|
| Page h1 | Cormorant | `clamp(3.8rem, 6.5vw, 7rem)` | 500 |
| Section h2 | Cormorant | `clamp(2.4rem, 3.4vw, 3.6rem)` | 500 |
| Card title | Cormorant | `clamp(2.2rem, 3vw, 3rem)` | 500 |
| Timer digits | Cormorant | `clamp(4.5rem, 9vw, 6.4rem)` | 500 |
| Body | Montserrat | `0.94rem` | 400 |
| Label / kicker | Montserrat | `0.72rem`, 700, `letter-spacing: 0.07em`, uppercase | — |

Headings use `line-height: 1` or `0.96`. Body uses `line-height: 1.65–1.85`.

---

## Spacing

The system uses a base-8 spatial scale: 8, 16, 24, 32, 40, 48, 64, 80 px. Cards get 36–44 px internal padding (desktop), 20–28 px on mobile. Section inner width is `min(1320px, calc(100vw - 64px))`.

---

## Cards

```css
background: var(--white);
border: 1px solid rgba(51, 47, 44, 0.10–0.14);
box-shadow: 0 20px 60px rgba(51, 38, 31, 0.07);
border-radius: 4px;  /* editorial — almost square corners */
```

Cards use **almost-square corners** (`border-radius: 4px`) to feel editorial and restrained. Only interactive chips (badges, pills) use fully rounded corners.

---

## Botanical Motifs

Thin-stroke SVG branch-and-leaf sprigs are used as decoration, never as information. Properties:

- `stroke-width`: 0.9–1.2 px
- `color`: `rgba(139, 117, 100, 0.5)` (via `currentColor` on the SVG)
- No fill — outline only
- Used in pairs: left sprig + mirrored right sprig (`transform: scaleX(-1)`)
- Typical viewBox: `0 0 52 120` (narrow, tall)

Botanical elements appear:
- Flanking the cash-payment timer on `confirmare.html`
- (Future) section dividers on the landing page

---

## Status Badges

Small pill-shaped badges positioned in the top-right of a card header.

```css
display: inline-flex; align-items: center; gap: 6px;
padding: 5px 12px 5px 8px;
border-radius: 100px;
font-size: 0.74rem; font-weight: 600; letter-spacing: 0.04em;
```

Variants:

| Modifier | Bg | Border | Text |
|----------|----|--------|------|
| `--pending` | `rgba(192,142,58,0.14)` | `rgba(192,142,58,0.32)` | `#7a5a00` |
| `--paid` | `rgba(96,108,56,0.12)` | `rgba(96,108,56,0.28)` | `#3a6b2a` |
| `--error` | `rgba(198,107,61,0.12)` | `rgba(198,107,61,0.28)` | `#8B2D18` |

---

## Buttons

### Primary (`.cf-btn--primary`)
Solid espresso fill. 52 px min-height. 700 weight, uppercase, `letter-spacing: 0.08em`. Hover: darken + lift 1 px.

### Danger filled (`.cf-btn--danger-filled`)
Deep red `#8B2D18`. Used for destructive confirmations only.

### Danger outline (`.cf-btn--danger-outline`)
Transparent bg, `rgba(198,107,61,0.38)` border. Used for the first "cancel" trigger — less alarming than filled.

### Ghost (`.cf-btn--ghost`)
Transparent, `rgba(51,47,44,0.22)` border. Used alongside danger-filled in confirmation dialogs as the "keep" option.

### Editorial link (`.editorial-button`, `.editorial-link`)
Text-only or minimal border, used in navigation and page-level CTAs.

All buttons include `svg` as an inline icon when an action has a visual metaphor (hourglass = extend time; × = cancel/remove).

---

## Info Rows

Stacked rows presenting contextual info (office hours, notes). Built as a group with a shared border:

```css
/* Container */
border: 1px solid rgba(51,47,44,0.10);
border-radius: 10px; overflow: hidden;
background: rgba(51,47,44,0.08); /* 1 px gap colour */

/* Each row */
padding: 13px 16px;
background: rgba(247,237,224,0.6);
display: flex; align-items: center; gap: 12px;
font-size: 0.86rem;
```

Icons in info rows use `--cocoa` colour, 16 px size.

---

## Timer Component

The cash-payment countdown timer is the most prominent element on `confirmare.html`.

Structure:
```
[botanical sprig] [label / digits / hint] [botanical sprig mirrored]
```

CSS states (applied to the wrap element via JS):

| State | Trigger | Bg | Border | Digit colour |
|-------|---------|----|--------|-------------|
| Normal | > 10 min | `rgba(247,237,224,0.7)` | `rgba(139,117,100,0.2)` | `--espresso` |
| Warning `.is-warning` | 3–10 min | amber tint | amber | `#A07720` |
| Critical `.is-critical` | < 3 min | red tint | red | `#8B2D18` |

Digits use Cormorant Garamond at `6–6.4 rem`. A static hint line below the digits reads: *"After expiry, the reservation will be cancelled automatically."*

---

## Form Inputs

```css
min-height: 54px; padding: 14px 16px;
background: rgba(247,237,224,0.42);
border: 1px solid rgba(51,47,44,0.18);
border-radius: 8px; font: inherit; font-size: 0.95rem;
```

Focus: `border-color: var(--espresso)` + `box-shadow: 0 0 0 3px rgba(51,38,31,0.10)`.

---

## Page Structure

```
<header>      sticky glass header (backdrop-filter: blur)
<main>        .checkout-page  →  padding-top ~118px
  .checkout-shell (max-width 1320px, centered)
    .checkout-hero        h1 + lead text
    .checkout-grid        two-column layout (summary | action)
      .co-card.co-summary (left)
      .co-card            (right — payment / confirmation)
<footer>
```

`confirmare.html` and `anulare.html` share `main.css` + `checkout.css` (for shared layout tokens) and additionally load `confirmation.css` for page-specific components.

---

## Motion

- Colour transitions: `200–400 ms ease`
- Button lift: `transform: translateY(-1px)` on hover, `translateY(0)` on active
- Timer colour change: `400 ms ease` (slow enough to not feel alarming)
- Spinner: `0.8 s linear infinite` rotate — used only in loading states

---

## Accessibility

- All icon-only SVGs carry `aria-hidden="true"`
- Countdown digits use `aria-live="polite"` `aria-atomic="true"`
- Status state panels use `hidden` attribute (toggled by JS) — never `display: none` in CSS
- Skip link present on every page
- Focus ring: `3px solid rgba(51,38,31,0.24)`, `outline-offset: 3px`
