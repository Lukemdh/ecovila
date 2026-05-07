# EcoVila Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Step 1 public landing page for EcoVila as a polished static experience.

**Architecture:** A vanilla static site with focused files: HTML for structure, CSS for the Organic visual system, translation JS for localized content, and landing JS for browser interactions. Placeholder assets live in the same folder paths that the client will later replace.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Node built-in test runner for structural tests.

---

### Task 1: Structural Test

**Files:**
- Create: `tests/landing.test.mjs`

- [ ] Write a Node test that fails until the landing page, CSS, JS, logo, approved photo folders, placeholders, CTAs, language switcher, cookie banner, and accommodation modal hooks exist.
- [ ] Run `node --test tests/landing.test.mjs` and confirm it fails because the landing-page files are not present.

### Task 2: Landing Page

**Files:**
- Create: `index.html`
- Create: `css/main.css`
- Create: `js/translations.js`
- Create: `js/main.js`
- Create: `assets/logo.svg`
- Create placeholder SVG files under each `assets/photos/...` folder.

- [ ] Add semantic landing-page sections from the project brief.
- [ ] Add Organic design tokens and responsive layout.
- [ ] Add RO/RU/EN translation behavior.
- [ ] Add header scroll, accommodation modal, and cookie consent behavior.
- [ ] Run the structural test and fix any gaps.

### Task 3: Verification

**Files:**
- Read: all Step 1 files.

- [ ] Run `node --test tests/landing.test.mjs`.
- [ ] Serve the site locally with `python3 -m http.server 4173`.
- [ ] Inspect the page in a browser at desktop and mobile widths.
- [ ] Check for broken local assets and overlapping text.
