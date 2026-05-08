import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function footerMarkup(html) {
  const match = html.match(/<footer[\s\S]*?<\/footer>/);
  return match ? match[0] : '';
}

describe('EcoVila Step 4 booking page', () => {
  it('creates the booking page files and loads shared booking dependencies', () => {
    for (const file of ['rezervari.html', 'css/booking.css', 'js/booking.js']) {
      assert.ok(exists(file), `${file} should exist`);
    }

    const html = read('rezervari.html');

    for (const script of [
      'js/translations.js',
      'js/pricing.js',
      'js/calendar.js',
      'js/supabase.js',
      'js/main.js',
      'js/booking.js',
    ]) {
      assert.match(html, new RegExp(`src="${script}"`), `${script} should be loaded`);
    }

    assert.match(html, /css\/main\.css/, 'booking page should use the shared public design system');
    assert.match(html, /css\/booking\.css/, 'booking page should load booking styles');
  });

  it('uses the alternate logo artwork in the footer', () => {
    const html = read('rezervari.html');
    const footer = footerMarkup(html);

    assert.match(footer, /src="\/assets\/logoNT\.png"/, 'booking footer should use the alternate PNG logo');
  });

  it('renders guest selectors, a date range calendar, accommodation cards, and room selection UI hooks', () => {
    const html = read('rezervari.html');

    for (const hook of [
      'data-booking-app',
      'data-adults-value',
      'data-kids-value',
      'data-child-ages',
      'data-calendar-grid',
      'data-check-in',
      'data-check-out',
      'data-stay-card="small"',
      'data-stay-card="large"',
      'data-stay-card="hotel"',
      'data-room-panel',
      'data-soldout-modal',
      'data-booking-modal',
    ]) {
      assert.match(html, new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${hook} should exist`);
    }

    assert.match(html, /data-age-placeholder/, 'child age selector template should exist');
  });

  it('keeps the accommodation availability lead left aligned and separate from the stay summary', () => {
    const html = read('rezervari.html');
    const css = read('css/booking.css');

    assert.match(
      html,
      /class="[^"]*booking-accommodation-lead[^"]*"[^>]*data-i18n="booking\.accommodationLead"/,
      'the accommodation lead should have its own alignment hook',
    );
    assert.match(
      css,
      /\.booking-panel__heading p\.booking-accommodation-lead\s*{[^}]*justify-self:\s*start[^}]*text-align:\s*left/s,
      'the accommodation lead should align left on desktop',
    );
  });

  it('uses a card title multiplier for multi-unit stays instead of availability count copy', () => {
    const js = read('js/booking.js');

    assert.match(js, /function getCardTitle\([^)]*neededUnits[^)]*\)/, 'booking.js should format card titles centrally');
    assert.match(js, /neededUnits\s*>\s*1[\s\S]+`[^`]*x\$\{neededUnits\}`/, 'multi-unit titles should include xN');
    assert.match(js, /getCardTitle\(type,\s*info\.neededUnits\)/, 'renderCards should use the multiplier title');
    assert.doesNotMatch(js, /booking\.availableUnits/, 'selected-date card copy should not show available unit counts');
    assert.doesNotMatch(js, /booking\.unitsNeeded/, 'selected-date card copy should not show needed unit counts');
  });

  it('opens details from the accommodation card itself and removes card summary/detail-button clutter', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');

    assert.doesNotMatch(html, /data-card-summary/, 'reservation cards should not render accommodation summary paragraphs');
    assert.doesNotMatch(html, /data-card-details/, 'reservation cards should not need a separate details button');
    assert.doesNotMatch(js, /data-card-summary/, 'booking.js should not render removed summary hooks');
    assert.match(js, /card\.addEventListener\('click'[\s\S]+openDetails\(type\)/, 'clicking the card should open details');
    assert.match(js, /target\.closest\('button, a, select, input, textarea'\)/, 'card clicks should ignore nested controls');
  });

  it('puts a direct reserve CTA on each accommodation card and demotes room choice to secondary text', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.equal((html.match(/data-card-reserve/g) || []).length, 3, 'each accommodation card should have a direct reserve button');
    assert.equal((html.match(/booking-room-choice/g) || []).length, 3, 'each accommodation card should render room choice as secondary text');
    assert.match(
      html,
      /data-card-reserve[\s\S]+data-i18n="booking\.reserve"[\s\S]+data-card-room[\s\S]+booking\.chooseRoomNumber/,
      'the reserve CTA should appear before the room-number choice',
    );
    assert.match(
      js,
      /card\.querySelector\('\[data-card-reserve\]'\)\.addEventListener\('click',\s*\(\)\s*=>\s*reserveType\(type\)\)/,
      'card reserve buttons should use the checkout handoff',
    );
    assert.match(
      css,
      /\.booking-room-choice\s*{[^}]*color:\s*rgba\([^)]*0\.[0-9]+[^}]*font-size:\s*0\.[0-9]+rem/s,
      'room-number choice should be visually smaller and faded',
    );
    assert.match(
      css,
      /\.booking-stay-card__actions\s*{[^}]*align-items:\s*center/s,
      'card actions should be centered within each accommodation card',
    );
    assert.match(
      css,
      /\.booking-stay-card__actions \.editorial-button\s*{[^}]*min-width:\s*12[0-9]px/s,
      'the card reserve CTA should be slightly wider than its text',
    );
  });

  it('renders room picker buttons as larger standalone numbers', () => {
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.match(
      js,
      /button\.textContent\s*=\s*String\(number\)/,
      'room picker buttons should show only the room number',
    );
    assert.match(
      js,
      /button\.setAttribute\('aria-label',\s*t\('booking\.roomNumber',\s*\{\s*number\s*\}\)\)/,
      'room picker buttons should keep the translated accessible label',
    );
    assert.match(
      css,
      /\.room-number-grid button\s*{[^}]*font-size:\s*clamp\([^}]*line-height:\s*1/s,
      'room picker numbers should be sized to fill the button better',
    );
    assert.match(
      css,
      /\.room-number-grid button\s*{[^}]*display:\s*grid[^}]*place-items:\s*center/s,
      'room picker numbers should be centered in the button box',
    );
    assert.match(
      css,
      /\.room-number-grid button\s*{[^}]*font-family:\s*var\(--body-font\)/s,
      'room picker numbers should use the body font for steadier numeric centering',
    );
  });

  it('uses a gallery-style accommodation details modal with bathroom and facility sections, without feature chips', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');
    const translations = read('js/translations.js');

    for (const hook of [
      'data-booking-modal-gallery',
      'data-booking-modal-thumbnails',
      'data-booking-modal-bathroom',
      'data-booking-modal-facilities',
    ]) {
      assert.match(html, new RegExp(hook), `${hook} should exist`);
      assert.match(js, new RegExp(hook), `${hook} should be populated by booking.js`);
    }

    assert.doesNotMatch(html, /data-booking-modal-features/, 'details modal should not render feature chip hooks');
    assert.doesNotMatch(js, /booking-modal-features/, 'booking.js should not populate removed feature chips');
    assert.doesNotMatch(js, /accommodation\.\$\{type\}\.features/, 'feature chip translations should not be read');
    assert.doesNotMatch(translations, /accommodation\.(small|large|hotel)\.features/, 'unused feature chip translations should be removed');
    assert.match(translations, /Featuring free toiletries, this villa includes a private bathroom/, 'small villa description should match supplied details');
    assert.match(translations, /Featuring 2 bedrooms and a living room/, 'large villa description should match supplied details');
    assert.match(translations, /All-Inclusive food and drinks/, 'shared facilities should include the supplied all-inclusive item');
  });

  it('localizes accommodation details, bathroom lists, and facilities in every public language', () => {
    const translations = read('js/translations.js');

    assert.match(translations, /'accommodation\.small\.details': 'Această vilă include articole de toaletă gratuite/, 'Romanian small villa details should be localized');
    assert.match(translations, /'accommodation\.large\.details': 'Această vilă spațioasă are 2 dormitoare și un living/, 'Romanian large villa details should be localized');
    assert.match(translations, /'accommodation\.hotel\.details': 'Această cameră include articole de toaletă gratuite/, 'Romanian hotel room details should be localized');
    assert.match(translations, /'accommodation\.shared\.bathroom': \['Articole de toaletă gratuite', 'Duș'/, 'Romanian bathroom list should be localized');
    assert.match(translations, /'accommodation\.shared\.facilities': \['Mâncare și băuturi all-inclusive', 'Acces nelimitat la SPA înainte de 22:00'/, 'Romanian facilities list should be localized');
    assert.match(translations, /'booking\.inBathroom': 'În baie:'/, 'Romanian bathroom heading should be localized');
    assert.match(translations, /'booking\.facilities': 'Facilități:'/, 'Romanian facilities heading should be localized');

    assert.match(translations, /'accommodation\.small\.details': 'Эта вилла включает бесплатные туалетные принадлежности/, 'Russian small villa details should be localized');
    assert.match(translations, /'accommodation\.large\.details': 'Эта просторная вилла с 2 спальнями и гостиной/, 'Russian large villa details should be localized');
    assert.match(translations, /'accommodation\.hotel\.details': 'Этот номер включает бесплатные туалетные принадлежности/, 'Russian hotel room details should be localized');
    assert.match(translations, /'accommodation\.shared\.bathroom': \['Бесплатные туалетные принадлежности', 'Душ'/, 'Russian bathroom list should be localized');
    assert.match(translations, /'accommodation\.shared\.facilities': \['Питание и напитки all-inclusive', 'Безлимитный доступ в SPA до 22:00'/, 'Russian facilities list should be localized');
    assert.match(translations, /'booking\.inBathroom': 'В ванной:'/, 'Russian bathroom heading should be localized');
    assert.match(translations, /'booking\.facilities': 'Удобства:'/, 'Russian facilities heading should be localized');
  });

  it('requires guests to choose both check-in and check-out in the sold-out availability modal', () => {
    const js = read('js/booking.js');

    assert.match(js, /soldoutCheckIn:\s*''/, 'sold-out chooser should track a pending check-in');
    assert.match(js, /function selectSoldoutDate/, 'sold-out date clicks should go through a range-selection function');
    assert.match(js, /state\.soldoutCheckIn\s*=\s*date[\s\S]+state\.checkOut\s*=\s*date/, 'sold-out chooser should set checkout only after a second date');
    assert.doesNotMatch(js, /const stayNights = getStayNights\(\) \|\| 1/, 'sold-out chooser should not auto-create a one-night stay');
  });

  it('keeps sold-out checkout options visually available without marking every valid date as selected', () => {
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.doesNotMatch(
      js,
      /checkoutAvailable[\s\S]{0,220}classList\.toggle\(\s*'is-in-range'/,
      'valid checkout dates should not all receive the selected range class after check-in',
    );
    assert.doesNotMatch(
      css,
      /\.soldout-calendar button\.is-selected,\s*\.soldout-calendar button\.is-in-range/,
      'sold-out selected styling should not apply to every checkout option',
    );
  });

  it('uses range-aware date selection so sold-out check-in dates can still be checkout dates', () => {
    const js = read('js/booking.js');

    assert.match(
      js,
      /calendar\.getDateSelectionState\(\{[\s\S]+checkIn:\s*state\.checkIn,[\s\S]+checkOut:\s*state\.checkOut/,
      'calendar rendering should pass the current selected range into date selectability checks',
    );
    assert.doesNotMatch(
      js,
      /const unavailable = !isPast && calendar\.isDateFullyUnavailable\(/,
      'calendar rendering should not disable checkout dates only because their own night is sold out',
    );
  });

  it('allows public child age choices from 1 to 18 while keeping the pricing categories private', () => {
    const html = read('rezervari.html');
    const pricing = read('js/pricing.js');
    const brief = read('ECOVILA_PROJECT_BRIEF.md');

    assert.match(html, /<option value="1">1<\/option>/, 'child age selector should start at age 1');
    assert.match(html, /<option value="18">18<\/option>/, 'child age selector should include age 18');
    assert.doesNotMatch(html, /0-3.*free/i, 'public booking UI should not explain hidden age pricing logic');

    assert.match(pricing, /freeChildAges/, 'pricing should track children aged 0-3 separately');
    assert.match(pricing, /teenAges/, 'pricing should track children aged 13+ separately');
    assert.match(brief, /Guests choose child ages from 1-18/i, 'brief should document the public selector range');
    assert.match(brief, /0-3 years.*free/i, 'brief should document the private free-child pricing rule');
    assert.match(brief, /13\+.*adult price/i, 'brief should document teen adult pricing');
  });

  it('implements booking flow logic without creating reservations before checkout', () => {
    const js = read('js/booking.js');

    for (const symbol of [
      'EcoVilaPricing',
      'EcoVilaCalendar',
      'EcoVilaSupabase',
      'fetchRooms',
      'fetchPricingTiers',
      'fetchHolidays',
      'fetchAvailabilityBlocks',
      'calculateStayPrice',
      'chooseRoomsForAssignment',
      'ecovila_booking_selection',
    ]) {
      assert.match(js, new RegExp(symbol), `${symbol} should be used in booking.js`);
    }

    assert.doesNotMatch(js, /\.from\('reservations'\)\.insert/, 'booking page should not insert reservations');
    assert.doesNotMatch(js, /\.insert\(/, 'booking page should not create checkout records yet');
    assert.match(js, /checkout\.html/, 'booking page should hand off to checkout');
  });

  it('temporarily sells out Căsuță Mică from May 7 through May 11, leaves one small cottage free on May 20, and sells out every accommodation from May 27 through May 30', () => {
    const js = read('js/booking.js');

    assert.match(js, /TEST_SOLD_OUT_RANGES/, 'booking.js should support multiple temporary test blackouts');
    assert.match(js, /type:\s*'small'/, 'one test blackout should target Căsuță Mică only');
    assert.match(js, /checkIn:\s*'2026-05-07'/, 'the small-cottage blackout should start on May 7, 2026');
    assert.match(js, /checkOut:\s*'2026-05-12'/, 'the small-cottage blackout should include May 11 as a booked night');
    assert.match(js, /checkIn:\s*'2026-05-20'/, 'the partial small-cottage blackout should start on May 20, 2026');
    assert.match(js, /checkOut:\s*'2026-05-21'/, 'the partial small-cottage blackout should cover only the May 20 night');
    assert.match(
      js,
      /roomNumbers:\s*Object\.freeze\(\[\s*1,\s*2,\s*3,\s*4,\s*5,\s*6,\s*7\s*\]\)/,
      'the May 20 test blackout should reserve seven small cottages and leave one free',
    );
    assert.match(js, /checkIn:\s*'2026-05-27'/, 'the full-site blackout should start on May 27, 2026');
    assert.match(js, /checkOut:\s*'2026-05-31'/, 'the full-site blackout should include May 30 as a booked night');
    assert.match(
      js,
      /Object\.freeze\(\{\s*checkIn:\s*'2026-05-27',\s*checkOut:\s*'2026-05-31',\s*\}\)/,
      'the May 27-30 test blackout should target every accommodation type',
    );
    assert.match(
      js,
      /flatMap\(\(range\)[\s\S]+rangeRoomNumbers[\s\S]+rangeRoomNumbers\.has\(Number\(room\.number\)\)[\s\S]+room_id: room\.id/,
      'the test blackout should optionally generate blocks for configured room numbers only',
    );
    assert.match(
      js,
      /withTestingSoldOutBlocks\(normalizeAvailabilityBlocks\(blocks\),\s*state\.rooms\)/,
      'the test blackout should be merged into fetched availability blocks',
    );
  });

  it('adds translation keys for Step 4 in all public languages', () => {
    const translations = read('js/translations.js');

    for (const lang of ['ro', 'ru', 'en']) {
      const langBlock = translations.match(new RegExp(`${lang}:\\s*{[\\s\\S]*?\\n  }[,\\n]`));
      assert.ok(langBlock, `${lang} translation block should exist`);

      for (const key of [
        'booking.title',
        'booking.adults',
        'booking.children',
        'booking.childAge',
        'booking.checkIn',
        'booking.checkOut',
        'booking.availableUnits',
        'booking.soldOut',
        'booking.wantThisType',
        'booking.chooseRoomNumber',
        'booking.reserve',
      ]) {
        assert.match(langBlock[0], new RegExp(`['"]${key}['"]`), `${lang}.${key} should exist`);
      }
    }
  });

  it('defines a dedicated booking layout without broken local assets', () => {
    const html = read('rezervari.html');
    const css = read('css/booking.css');
    const combined = `${html}\n${css}`;

    for (const selector of [
      '.booking-shell',
      '.booking-panel',
      '.guest-control',
      '.calendar-grid',
      '.booking-stay-card',
      '.room-number-grid',
      '.booking-modal',
    ]) {
      assert.match(css, new RegExp(selector.replace('.', '\\.')), `${selector} styles should exist`);
    }

    const assetReferences = [...combined.matchAll(/["'(]\/?(assets\/[^"')]+)["')]/g)].map(
      (match) => match[1],
    );

    for (const asset of assetReferences) {
      assert.ok(exists(asset), `${asset} should exist`);
    }
  });

  it('keeps hidden booking controls hidden even when styled classes define display', () => {
    const css = `${read('css/main.css')}\n${read('css/booking.css')}`;

    assert.match(
      css,
      /\[hidden\]\s*{[^}]*display:\s*none\s*!important/i,
      'a global hidden rule should override styled button and badge display rules',
    );
  });
});
