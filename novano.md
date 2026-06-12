# novano

Developed by novano.us
web   https://novano.us
email office@novano.us

---

This file is a drop-in spec for the **novano footer credit easter egg**. Tell any
agent "implement novano.md" and it should reproduce the exact behavior below on the
target website, adapting only the selectors/paths to that site's structure.

## What it is

A small "Developed by novano.us" credit placed directly under the copyright /
"all rights reserved" line in the site footer. The `novano.us` part is a link.

**Link target is always `http://novano.space`** — never `novano.us`. We own
`novano.us` but use the `.space` domain in code because it is a stable domain that
will not change. (We may move the brand to `.com` later; the displayed text stays
`novano.us`, only the visible label, while the href stays `novano.space`.)

## Behavior (the easter egg)

On the **first hover or focus** of the `novano.us` link:

1. The word `novano` lights up (warm amber glow).
2. The `.us` suffix falls away (drops down, rotates, fades out).
3. A lightbulb drops in from above and settles into the spot where `.us` was.
4. The bulb starts **off**, then performs an American halogen-style turn-on:
   it flashes on, off, a dimmer flash, off ("clips"), then slowly ramps up to
   full warm glow.

Once triggered, the animation **always runs to completion** even if the pointer
leaves. The lit state then **persists until the page is reloaded** (the trigger is
one-time; the controlling class is added and never removed). Hovering again does
nothing — it has already fired.

Respect `prefers-reduced-motion`: skip the animations and jump straight to the final
state (`.us` hidden, bulb shown and lit).

## HTML

Place this credit line immediately under the existing copyright line. If the
copyright line is a sibling in a flex row, wrap both in a column so the credit sits
beneath it (see `.footer-rights-col`). The `Developed by` text may be plain or
wired to the site's i18n system (key `footer.developed`).

```html
<div class="footer-rights-col">
  <p class="footer-rights">
    <span>© 2026 YOURBRAND.</span>
    <span>All rights reserved</span>
  </p>
  <p class="footer-credit">
    <span>Developed by</span>
    <a class="novano" href="http://novano.space" target="_blank" rel="noopener noreferrer" aria-label="Developed by novano.us">novano<span class="novano-slot"><span class="novano-tld">.us</span><span class="novano-bulb" aria-hidden="true"><i class="novano-bulb-glass"></i><i class="novano-bulb-cap"></i></span></span></a>
  </p>
</div>
```

Keep `novano`, `.us`, and the bulb on one line with no whitespace between them so
the layout doesn't get stray text-node gaps.

## CSS

```css
.footer-rights-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.2rem;
}

.footer-credit {
  font-size: 0.7rem;
  color: inherit;
  opacity: 0.6;
  display: flex;
  gap: 0.3rem;
  align-items: baseline;
}

.novano {
  position: relative;
  color: inherit;
  text-decoration: none;
  font-weight: 600;
  transition: color 1.6s ease 1.3s, text-shadow 1.6s ease 1.3s;
}

.novano-slot { position: relative; display: inline-block; }
.novano-tld  { display: inline-block; }

/* lightbulb — hidden above the slot until triggered */
.novano-bulb {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 0.7em;
  height: 0.7em;
  opacity: 0;
  transform: translate(-50%, -320%);
  transform-origin: 50% 100%;
  pointer-events: none;
}
.novano-bulb-glass {
  position: absolute;
  left: 50%;
  top: 0;
  width: 0.7em;
  height: 0.7em;
  margin-left: -0.35em;
  border-radius: 50%;
  background: #6b6b6b; /* off */
  box-shadow: none;
}
.novano-bulb-cap {
  position: absolute;
  left: 50%;
  bottom: -0.1em;
  width: 0.34em;
  height: 0.18em;
  margin-left: -0.17em;
  background: linear-gradient(#9a9a9a, #6f6f6f);
  border-radius: 0 0 0.06em 0.06em;
}

/* triggered state — persists until reload (JS never removes .is-lit) */
.novano.is-lit {
  color: #ffcf6b;
  text-shadow: 0 0 6px rgba(255, 190, 80, 0.5);
}
/* Pixar-paced: deliberate timing, anticipation, arc, squash & stretch, settle */
.novano.is-lit .novano-tld {
  animation: novano-tld-fall 1s ease-in-out 0.15s forwards;
}
.novano.is-lit .novano-bulb {
  animation: novano-bulb-drop 1.5s ease-in-out 0.2s forwards;
}
.novano.is-lit .novano-bulb-glass {
  animation: novano-halogen 3.2s ease-in 1.5s forwards;
}

/* anticipation lift, then a slow arcing fall */
@keyframes novano-tld-fall {
  0%   { transform: translate(0, 0) rotate(0);              opacity: 1; }
  22%  { transform: translate(0, -0.2em) rotate(-7deg);     opacity: 1; }
  100% { transform: translate(0.28em, 1.6em) rotate(52deg); opacity: 0; }
}
/* drop with a hold (anticipation), squash on impact, then settling bounces */
@keyframes novano-bulb-drop {
  0%   { transform: translate(-50%, -320%) scaleY(1) scaleX(1);       opacity: 0; }
  12%  { transform: translate(-50%, -320%) scaleY(1) scaleX(1);       opacity: 0; }
  18%  { transform: translate(-50%, -300%) scaleY(1.15) scaleX(0.9);  opacity: 1; }
  46%  { transform: translate(-50%, -8%)   scaleY(1.3) scaleX(0.82);  opacity: 1; }
  55%  { transform: translate(-50%, 0%)    scaleY(0.68) scaleX(1.28); }
  68%  { transform: translate(-50%, -30%)  scaleY(1.14) scaleX(0.9); }
  78%  { transform: translate(-50%, 0%)    scaleY(0.85) scaleX(1.12); }
  88%  { transform: translate(-50%, -11%)  scaleY(1.05) scaleX(0.97); }
  95%  { transform: translate(-50%, 0%)    scaleY(0.96) scaleX(1.03); }
  100% { transform: translate(-50%, 0%)    scaleY(1) scaleX(1);       opacity: 1; }
}
/* American halogen: flash on, off, dim flash, off (clip), dark beat, then slow warm-up to full */
@keyframes novano-halogen {
  0%   { background: #6b6b6b; box-shadow: none; }
  6%   { background: #fff2cc; box-shadow: 0 0 5px 1px rgba(255, 190, 90, 0.85); }
  11%  { background: #6b6b6b; box-shadow: none; }
  18%  { background: #ffe9b0; box-shadow: 0 0 4px 1px rgba(255, 190, 90, 0.55); }
  24%  { background: #6b6b6b; box-shadow: none; }
  34%  { background: #6b6b6b; box-shadow: none; }
  50%  { background: #8a7a55; box-shadow: 0 0 2px rgba(255, 190, 90, 0.3); }
  72%  { background: #e7d49a; box-shadow: 0 0 5px 1px rgba(255, 190, 90, 0.6); }
  100% { background: #fff2cc; box-shadow: 0 0 7px 2px rgba(255, 190, 90, 0.95), 0 0 3px rgba(255, 220, 150, 1); }
}

@media (prefers-reduced-motion: reduce) {
  .novano.is-lit .novano-tld  { animation: none; opacity: 0; }
  .novano.is-lit .novano-bulb { animation: none; opacity: 1; transform: translate(-50%, 0%); }
  .novano.is-lit .novano-bulb-glass {
    animation: none;
    background: #fff2cc;
    box-shadow: 0 0 7px 2px rgba(255, 190, 90, 0.95);
  }
}
```

## JS

```js
// First hover/focus lights the credit and drops the bulb in place of ".us".
// Runs to completion and stays lit until the page reloads.
function initNovano() {
  var link = document.querySelector('.novano');
  if (!link || link.classList.contains('is-lit')) return;

  function light() {
    link.classList.add('is-lit');
    link.removeEventListener('mouseenter', light);
    link.removeEventListener('focus', light);
  }

  link.addEventListener('mouseenter', light);
  link.addEventListener('focus', light);
}
```

Call `initNovano()` once on DOM ready (alongside the site's other init calls).

## Adapting to a framework

- **React/Vue/Svelte:** render the same markup; use a one-time state flag toggled on
  `onMouseEnter`/`onFocus` instead of the class-add JS, and apply the `is-lit` class
  from that flag. Keep the CSS as-is.
- **Scoped/CSS-modules:** keep the class names or remap consistently across HTML/CSS/JS.
- Always keep the href = `http://novano.space` and the visible label = `novano.us`.
