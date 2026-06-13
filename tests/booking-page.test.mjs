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
      'data-child-age-overlay',
      'data-child-age-confirm',
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

  it('prompts for child ages in an overlay that reopens after child count changes', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.match(html, /data-child-age-overlay/, 'booking page should render a child-age overlay');
    assert.match(html, /data-child-age-confirm[\s\S]+booking\.confirm/, 'child-age overlay should have a confirm button');
    assert.match(js, /childAgeOverlayOpen:\s*false/, 'booking state should track the child-age overlay');
    assert.match(js, /function showChildAgeOverlay/, 'booking.js should expose a child-age overlay opener');
    assert.match(
      js,
      /counter === 'children'[\s\S]+showChildAgeOverlay\(\)/,
      'changing the child count should reopen the age overlay',
    );
    assert.match(
      js,
      /\[data-child-age-confirm\][\s\S]+confirmChildAges/,
      'the confirm button should hide the child-age overlay through booking.js',
    );
    assert.match(
      css,
      /\.child-age-overlay\s*{[^}]*position:\s*absolute/s,
      'child-age prompt should be styled as an overlay on the guest section',
    );
  });

  it('opens the calendar from the date card without date prices and closes after checkout selection', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.match(html, /data-date-picker-shell/, 'date picker should have a shell that can receive open state');
    assert.match(html, /data-focus-calendar/, 'date summary cards should open the calendar');
    assert.match(html, /data-calendar-clear/, 'calendar should render a clear action in its footer');
    assert.match(html, /data-calendar-apply/, 'calendar should render an apply action in its footer');
    assert.doesNotMatch(html, /data-type-prompt/, 'the selector row should not render a separate accommodation prompt card');
    assert.match(js, /calendarOpen:\s*false/, 'booking state should track whether the calendar is open');
    assert.match(js, /function openCalendar/, 'booking.js should open the calendar from the date summary');
    assert.match(js, /function closeCalendar/, 'booking.js should centralize calendar closing');
    assert.doesNotMatch(js, /getCalendarDatePrice/, 'calendar cells should not calculate or render price previews');
    assert.doesNotMatch(js, /calendar-day__price/, 'calendar day buttons should not render price elements');
    assert.match(
      js,
      /state\.checkOut\s*=\s*date[\s\S]+state\.calendarOpen\s*=\s*false/,
      'selecting a checkout date should hide the calendar',
    );
    assert.match(
      css,
      /\.date-picker:not\(\.is-calendar-open\) \.calendar\s*{[^}]*display:\s*none/s,
      'closed calendar state should be hidden in CSS',
    );
    assert.match(
      css,
      /@media \(max-width: 700px\)[\s\S]+\.calendar__header h2\s*{[^}]*font-size:\s*0\.[0-9]+rem/s,
      'calendar month text should stay compact on mobile',
    );
  });

  it('closes the calendar on outside click and keeps the popup inside the viewport', () => {
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.match(
      js,
      /document\.addEventListener\('click'[\s\S]+state\.calendarOpen[\s\S]+closest\('\[data-date-picker-shell\]'\)[\s\S]+closeCalendar\(\)/,
      'clicking outside the date picker should close the open calendar',
    );
    assert.match(
      css,
      /\.date-picker\s*{[^}]*position:\s*static/s,
      'calendar should be positioned against the selector panel instead of the narrow date field',
    );
    assert.match(
      css,
      /\.calendar\s*{[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\)[^}]*width:\s*min\(540px,\s*calc\(100vw - 32px\)\)/s,
      'calendar should be centered and clamped to the viewport width',
    );
    assert.match(css, /\.calendar__footer\s*{[^}]*display:\s*flex/s, 'calendar should have a Booking-style footer row');
    assert.match(css, /\.calendar__apply\s*{[^}]*background:\s*var\(--booking-green\)/s, 'calendar apply action should use the green CTA treatment');
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

  it('selects accommodation from the details modal without redirecting to checkout', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');

    assert.match(
      html,
      /data-booking-modal-reserve[\s\S]+data-i18n="booking\.select"/,
      'details modal CTA should use Selectează copy',
    );
    assert.match(
      js,
      /\[data-booking-modal-reserve\][\s\S]+selectType\(state\.activeModalType[\s\S]+closeAllModals\(\)/,
      'details modal CTA should select the type and close the popup',
    );
    assert.match(js, /checkout\.html/, 'checkout handoff should remain available for the booking flow');
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
      'the select CTA should appear before the room-number choice',
    );
    assert.match(
      js,
      /data-card-reserve[\s\S]+?if \(state\.selectedType === type\) \{\s*continueToCheckout\(\);\s*\} else \{\s*selectType\(type\);/,
      'the card primary button should select a type, then continue to checkout once selected',
    );
    assert.match(
      css,
      /\.booking-room-choice\s*{[^}]*color:\s*var\(--booking-green-dark\)[^}]*font-size:\s*1\.0[0-9]rem/s,
      'room-number choice should read as the green text link from the reservation mockup',
    );
    assert.match(
      css,
      /\.booking-stay-card__actions\s*{[^}]*align-items:\s*center/s,
      'card actions should be centered within each accommodation card',
    );
    assert.match(
      css,
      /\.booking-stay-card__actions \.editorial-button\s*{[^}]*min-width:\s*12[0-9]px/s,
      'the card select CTA should be slightly wider than its text',
    );
  });

  it('adds the all-inclusive, SPA, and Wi-Fi amenity chips to each accommodation card', () => {
    const html = read('rezervari.html');
    const css = read('css/booking.css');

    assert.equal((html.match(/booking-amenities/g) || []).length, 3, 'each accommodation card should render amenity chips');

    for (const label of ['All-Inclusive', 'Access SPA', 'Wi-Fi']) {
      assert.equal((html.match(new RegExp(label, 'g')) || []).length, 3, `${label} should appear on every accommodation card`);
    }

    assert.match(css, /\.booking-amenities\s*{[^}]*grid-template-columns:\s*repeat\(3/s, 'amenity chips should sit in a three-chip row');
  });

  it('keeps the child-age overlay quiet while guests are choosing ages', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');

    assert.doesNotMatch(html, /booking\.childAgePrompt/, 'child-age popup should not render explanatory prompt text');
    assert.match(
      js,
      /state\.childAgeOverlayOpen[\s\S]+errorElement\.hidden = true/,
      'missing-age errors should be hidden while the child-age overlay is open',
    );
  });

  it('reveals room-number selection only after an accommodation type is selected and summarizes choices on the same button', () => {
    const js = read('js/booking.js');
    const css = read('css/booking.css');

    assert.match(js, /selectedType:\s*''/, 'booking state should track the selected accommodation type');
    assert.match(js, /function selectType/, 'booking.js should have a type-selection handler');
    assert.match(
      js,
      /roomButton\.hidden\s*=\s*state\.selectedType !== type/,
      'room choice should be hidden until its accommodation card is selected',
    );
    assert.match(
      js,
      /roomButton\.textContent\s*=\s*selectedNumbers\.length[\s\S]+booking\.roomSelected/,
      'selected room numbers should replace the room-choice button text',
    );
    assert.match(
      js,
      /closeAllModals\(\);[\s\S]+renderCards\(\);/,
      'selecting a room number should close the room picker and refresh the cards',
    );
    assert.match(
      css,
      /\.booking-room-choice:not\(\[hidden\]\)\s*{[^}]*animation:/s,
      'room-number choice should animate when it appears',
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

  it('uses a swipeable 3:2 gallery stage that fits both portrait and landscape photos', () => {
    const js = read('js/booking.js');
    const gallery = read('js/gallery.js');
    const css = read('css/booking.css');

    assert.match(css, /\.booking-stay-card img\s*{[^}]*aspect-ratio:\s*3 \/ 2/s, 'card photos should use a 3:2 crop box');
    assert.match(css, /\.ev-gallery__stage\s*{[^}]*aspect-ratio:\s*3 \/ 2/s, 'details gallery should use a 3:2 media stage');
    assert.match(css, /\.ev-gallery__viewport\s*{[^}]*scroll-snap-type:\s*x mandatory/s, 'gallery viewport should snap-scroll horizontally so photos can be swiped');
    assert.match(css, /\.ev-gallery__photo\s*{[^}]*object-fit:\s*contain/s, 'photos should be contained so portrait and landscape images are never cropped');
    assert.match(css, /\.ev-gallery__backdrop\s*{[^}]*object-fit:\s*cover[^}]*filter:[^}]*blur/s, 'a blurred cover backdrop should fill the letterboxed space');
    assert.match(gallery, /openLightbox/, 'gallery.js should provide a photo-only fullscreen lightbox');
    assert.match(css, /\.ev-lightbox__slide img\s*{[^}]*object-fit:\s*contain/s, 'lightbox photos should be fully contained in the viewport');
    assert.match(js, /function markImageOrientation/, 'booking.js should mark loaded card images by orientation');
    assert.match(js, /naturalHeight\s*>\s*naturalWidth/, 'orientation marking should detect portrait images from natural dimensions');
    assert.match(js, /dataset\.orientation/, 'orientation marking should expose image orientation to CSS and browser checks');
  });

  it('marks booking photo previews and modal images for lazy asynchronous loading', () => {
    const html = read('rezervari.html');
    const gallery = read('js/gallery.js');
    const photoTags = Array.from(
      html.matchAll(/<img[^>]+data-card-image[^>]*>/g),
      (match) => match[0],
    );

    assert.ok(photoTags.length >= 3, 'booking page should expose card photo tags');

    for (const tag of photoTags) {
      assert.match(tag, /loading="lazy"/, `${tag} should lazy-load`);
      assert.match(tag, /decoding="async"/, `${tag} should decode asynchronously`);
    }

    assert.match(gallery, /loading = index === state\.index \? 'eager' : 'lazy'/, 'modal gallery should lazy-load non-active slides');
    assert.match(gallery, /decoding: 'async'/, 'modal gallery images should decode asynchronously');
  });

  it('removes vertical guide-line backgrounds from the reservation experience', () => {
    const css = read('css/booking.css');
    const bookingPageBlock = css.match(/\.booking-page\s*{[^}]*}/s)?.[0] || '';

    assert.doesNotMatch(
      bookingPageBlock,
      /linear-gradient\(90deg/,
      'booking page background should not draw vertical guide lines',
    );
  });

  it('uses a gallery-style accommodation details modal with bathroom and facility sections, without feature chips', () => {
    const html = read('rezervari.html');
    const js = read('js/booking.js');
    const translations = read('js/translations.js');

    for (const hook of [
      'data-booking-modal-gallery',
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

  it('allows public child age choices from 1 to 17 while keeping the pricing categories private', () => {
    const html = read('rezervari.html');
    const pricing = read('js/pricing.js');
    const brief = read('docs/ECOVILA_PROJECT_BRIEF.md');

    assert.match(html, /<option value="1">1<\/option>/, 'child age selector should start at age 1');
    assert.match(html, /<option value="17">17<\/option>/, 'child age selector should include age 17');
    assert.doesNotMatch(html, /<option value="18">18<\/option>/, 'age 18 should not be selectable as a child');
    assert.doesNotMatch(html, /0-3.*free/i, 'public booking UI should not explain hidden age pricing logic');

    assert.match(pricing, /freeChildAges/, 'pricing should track children aged 1-3 separately');
    assert.match(pricing, /teenAges/, 'pricing should track children aged 12-17 separately');
    assert.match(brief, /Guests choose child ages from 1-17/i, 'brief should document the public selector range');
    assert.match(brief, /1-3 years.*free/i, 'brief should document the private free-child pricing rule');
    assert.match(brief, /12-17 years.*adult price/i, 'brief should document adult-fee child pricing');
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

  it('ships without test blackout scaffolding and uses real availability only', () => {
    const js = read('js/booking.js');

    assert.doesNotMatch(js, /TEST_SOLD_OUT_RANGES/, 'test blackout ranges must not ship to production');
    assert.doesNotMatch(js, /withTestingSoldOutBlocks|createTestingSoldOutBlocks/, 'test blackout helpers must not ship to production');
    assert.match(
      js,
      /state\.reservations = normalizeAvailabilityBlocks\(blocks\)/,
      'fetched availability blocks should be used directly',
    );
  });

  it('blocks checkout instead of booking on fallback prices when the pricing load fails', () => {
    const js = read('js/booking.js');

    assert.match(
      js,
      /if \(!pricingTiers\.length\) \{\s*throw new Error/,
      'an empty pricing_tiers load should be treated as a failure',
    );
    assert.match(
      js,
      /state\.pricingTiers = \[\];\s*state\.loadError = t\('booking\.loadError'\)/,
      'a failed load should clear pricing and surface an error',
    );
    assert.match(
      js,
      /if \(state\.loading \|\| state\.loadError \|\| !state\.pricingTiers\.length\) \{/,
      'reserveType should refuse to hand off to checkout without live pricing',
    );
  });

  it('loads holidays without a date range because they are recurring month-day rules', () => {
    const js = read('js/booking.js');

    assert.match(js, /supabaseHelpers\.fetchHolidays\(client\)/, 'holidays should be fetched in full');
    assert.doesNotMatch(
      js,
      /fetchHolidays\(client,\s*\{/,
      'holiday fetches must not be limited to the visible date window',
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
        'booking.calendarClear',
        'booking.calendarApply',
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
