import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const pricing = require('../../js/pricing.js');
const calendar = require('../../js/calendar.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadAdminModule(relativePath, extras = {}) {
  const sandbox = {
    console,
    Date,
    Intl,
    setInterval() {},
    clearInterval() {},
    setTimeout,
    clearTimeout,
    ...extras,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(read(relativePath), sandbox, { filename: relativePath });
  return sandbox;
}

function field(value, extra = {}) {
  return { value, ...extra };
}

function formWithFields(fields) {
  return {
    querySelector(selector) {
      return fields[selector] || null;
    },
    querySelectorAll(selector) {
      const result = fields[selector];
      return Array.isArray(result) ? result : [];
    },
  };
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function allMigrations() {
  return fs
    .readdirSync(path.join(root, 'docs/supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => read(`docs/supabase/migrations/${file}`))
    .join('\n');
}

describe('EcoVila Step 9 CRM', () => {
  it('creates the admin login and dashboard shell with the approved tabs', () => {
    assert.ok(exists('admin/index.html'));
    assert.ok(exists('admin/dashboard.html'));
    assert.ok(exists('css/crm.css'));

    const login = read('admin/index.html');
    const dashboard = read('admin/dashboard.html');

    assert.match(login, /Autentificare CRM/i);
    assert.match(login, /type="text"/i);
    assert.match(login, /type="password"/i);
    assert.match(login, /crm-auth\.js/i);

    for (const label of ['Dashboard', 'Finance', 'Situația zilnică', 'Ștergare', 'Poze', 'Prețuri']) {
      assert.match(dashboard, new RegExp(label, 'i'), `${label} tab should exist`);
    }

    assert.match(dashboard, /data-tab="dashboard"/i);
    assert.match(dashboard, /data-tab="finance"/i);
    assert.match(dashboard, /data-tab="daily"/i);
    assert.match(dashboard, /data-tab="towels"/i);
    assert.match(dashboard, /data-tab="photos"/i);
    assert.match(dashboard, /data-tab="pricing"/i);
    assert.ok(
      dashboard.indexOf('data-tab="dashboard"') < dashboard.indexOf('data-tab="finance"'),
      'Finance tab should sit after Dashboard',
    );
    assert.ok(
      dashboard.indexOf('data-tab="finance"') < dashboard.indexOf('data-tab="daily"'),
      'Finance tab should sit before Situația zilnică',
    );
    assert.ok(
      dashboard.indexOf('data-tab="daily"') < dashboard.indexOf('data-tab="towels"'),
      'Stergare tab should sit after Situația zilnică',
    );
    assert.ok(
      dashboard.indexOf('data-tab="towels"') < dashboard.indexOf('data-tab="photos"'),
      'Stergare tab should sit before Poze',
    );
  });

  it('adds the owner finance tab with reporting controls and metric hooks', () => {
    const dashboard = read('admin/dashboard.html');
    const app = read('admin/js/crm-app.js');
    const helpers = read('js/supabase.js');

    for (const hook of [
      'data-panel="finance"',
      'data-finance-prev',
      'data-finance-range-label',
      'data-finance-next',
      'data-finance-range-calendar',
      'data-finance-calendar-grid',
      'data-finance-mode="nights"',
      'data-finance-mode="paid"',
      'data-finance-commercial-total',
      'data-finance-cash-total',
      'data-finance-online-total',
      'data-finance-office-total',
      'data-finance-occupied-nights',
      'data-finance-paid-bookings',
      'data-finance-average-booking',
      'data-finance-room-type="small"',
      'data-finance-room-type="large"',
      'data-finance-room-type="hotel"',
      'js/crm-finance.js',
    ]) {
      assert.match(dashboard, new RegExp(hook), `${hook} should exist`);
    }

    assert.match(app, /EcoVilaCrmFinance\?\.init\?\.\(context\)/);
    assert.match(app, /EcoVilaCrmFinance\?\.showCurrentMonth\?\.\(\)/);
    assert.match(helpers, /function fetchFinanceReservations/);
  });

  it('summarizes finance rows by overlapping nights and keeps din oficiu separate', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const summary = finance.summarizeFinanceRows({
      mode: 'nights',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-06-01',
      rows: [
        {
          id: 'online-cross-month',
          room_id: 'room-1',
          check_in: '2026-05-30',
          check_out: '2026-06-02',
          total_price: 3000,
          payment_type: 'card',
          payment_status: 'paid',
          paid_at: '2026-05-15T10:00:00.000Z',
          rooms: { type: 'small' },
        },
        {
          id: 'cash-may',
          room_id: 'room-9',
          check_in: '2026-05-10',
          check_out: '2026-05-12',
          total_price: 4000,
          payment_type: 'cash',
          payment_status: 'paid',
          paid_at: '2026-05-10T08:00:00.000Z',
          rooms: { type: 'large' },
        },
        {
          id: 'office-may',
          room_id: 'room-20',
          check_in: '2026-05-20',
          check_out: '2026-05-23',
          total_price: 3000,
          payment_type: 'office',
          payment_status: 'paid',
          paid_at: '2026-05-18T08:00:00.000Z',
          rooms: { type: 'hotel' },
        },
        {
          id: 'cancelled-cash',
          room_id: 'room-2',
          check_in: '2026-05-15',
          check_out: '2026-05-16',
          total_price: 1000,
          payment_type: 'cash',
          payment_status: 'cancelled',
          cancelled_at: '2026-05-14T09:00:00.000Z',
          rooms: { type: 'small' },
        },
      ],
    });

    assert.equal(summary.commercialTotal, 6000);
    assert.equal(summary.cashTotal, 4000);
    assert.equal(summary.onlineTotal, 2000);
    assert.equal(summary.officeTotal, 3000);
    assert.equal(summary.occupiedNights, 7);
    assert.equal(summary.paidBookings, 2);
    assert.equal(summary.averageBookingValue, 3000);
    assert.equal(summary.roomTypeTotals.small, 2000);
    assert.equal(summary.roomTypeTotals.large, 4000);
    assert.equal(summary.roomTypeTotals.hotel, 0);
  });

  it('summarizes finance rows by actual paid_at collections', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const summary = finance.summarizeFinanceRows({
      mode: 'paid',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-06-01',
      rows: [
        {
          id: 'online-paid-may',
          room_id: 'room-16',
          check_in: '2026-06-10',
          check_out: '2026-06-12',
          total_price: 5000,
          payment_type: 'card',
          payment_status: 'paid',
          paid_at: '2026-05-03T10:00:00.000Z',
          rooms: { type: 'hotel' },
        },
        {
          id: 'cash-paid-april',
          room_id: 'room-3',
          check_in: '2026-05-04',
          check_out: '2026-05-05',
          total_price: 1200,
          payment_type: 'cash',
          payment_status: 'paid',
          paid_at: '2026-04-30T10:00:00.000Z',
          rooms: { type: 'small' },
        },
        {
          id: 'mia-paid-may',
          room_id: 'room-4',
          check_in: '2026-06-14',
          check_out: '2026-06-15',
          total_price: 2500,
          payment_type: 'mia',
          payment_status: 'paid',
          paid_at: '2026-05-07T10:00:00.000Z',
          rooms: { type: 'small' },
        },
        {
          id: 'office-paid-may',
          room_id: 'room-12',
          check_in: '2026-05-12',
          check_out: '2026-05-13',
          total_price: 1000,
          payment_type: 'office',
          payment_status: 'paid',
          paid_at: '2026-05-05T10:00:00.000Z',
          rooms: { type: 'large' },
        },
      ],
    });

    assert.equal(summary.commercialTotal, 7500);
    assert.equal(summary.cashTotal, 0);
    assert.equal(summary.onlineTotal, 7500);
    assert.equal(summary.officeTotal, 1000);
    assert.equal(summary.occupiedNights, 4);
    assert.equal(summary.paidBookings, 2);
    assert.equal(summary.averageBookingValue, 3750);
    assert.equal(summary.roomTypeTotals.small, 2500);
    assert.equal(summary.roomTypeTotals.hotel, 5000);
  });

  it('accepts staff usernames as CRM login aliases', () => {
    const login = read('admin/index.html');
    const auth = read('admin/js/crm-auth.js');

    assert.match(login, /Email sau utilizator/i);
    assert.match(login, /type="text"[^>]+autocomplete="username"/i);
    assert.match(auth, /function normalizeCrmLoginIdentifier/);
    assert.match(auth, /STAFF_USERNAME_DOMAIN\s*=\s*'crm\.ecovila\.local'/);
    assert.match(auth, /signInWithPassword\(\{\s*email:\s*normalizeCrmLoginIdentifier\(loginIdentifier\)/s);
  });

  it('keeps tabs usable in the local no-config dashboard and narrow app browser', () => {
    const app = read('admin/js/crm-app.js');
    const css = read('css/crm.css');
    const initStart = app.indexOf('async function init()');
    const wireTabsIndex = app.indexOf('wireTabs();', initStart);
    const requireSessionIndex = app.indexOf('auth.requireSession', initStart);
    const narrowRules = css.slice(css.indexOf('@media (max-width: 1179px)'));

    assert.ok(wireTabsIndex > -1, 'CRM tabs should be wired during dashboard init');
    assert.ok(requireSessionIndex > -1, 'dashboard init should still require auth for live data');
    assert.ok(
      wireTabsIndex < requireSessionIndex,
      'tabs should be wired before auth/config loading can fail locally'
    );
    assert.doesNotMatch(narrowRules, /\.crm-app\s*\{[\s\S]*display:\s*none\s*!important/i);
    assert.match(narrowRules, /\.crm-tabs[\s\S]*overflow-x:\s*auto/i);
  });

  it('keeps dashboard cards readable in a horizontally scrolling desktop calendar', () => {
    const html = read('admin/dashboard.html');
    const css = read('css/crm.css');

    assert.match(html, /Popescu Alexandru/i, 'sample full name should document expected fit');
    assert.match(html, /\+37368983660/i, 'sample Moldovan phone should document expected fit');
    assert.match(css, /--crm-day-column-width:\s*136px/i);
    assert.match(css, /grid-template-columns:[^;]*var\(--crm-day-column-width\)/is);
    assert.match(css, /overflow-x:\s*auto/i);
    assert.match(css, /white-space:\s*nowrap/i);
  });

  it('includes the dashboard reservation management controls from the brief', () => {
    const dashboard = read('admin/dashboard.html');
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const sidebarJs = read('admin/js/crm-sidebar.js');

    for (const label of [
      'Plăți cash în așteptare',
      'Adaugă rezervare',
      'Caută rezervare',
      'Marchează ca plătit',
      'Trimite SMS confirmare',
      'Șterge rezervarea',
      'schimba',
      'sterge',
    ]) {
      assert.match(`${dashboard}\n${dashboardJs}\n${sidebarJs}`, new RegExp(label, 'i'));
    }

    assert.match(dashboardJs, /room_explicitly_selected/i);
    assert.match(dashboardJs, /confirmReservationPayment/i);
    assert.match(
      dashboardJs,
      /notificationResults[\s\S]*SMS-ul nu a fost trimis/,
      'CRM should surface payment confirmation SMS failures returned by the Edge Function',
    );
    assert.doesNotMatch(
      dashboardJs,
      /payment_status:\s*'paid'[\s\S]*cash_expires_at:\s*null/i,
      'mark-paid should go through the Edge Function so SMS/email confirmation can be sent server-side',
    );
  });

  it('renders the staff add form with age buckets, a range calendar, and no payment selector', () => {
    const dashboard = read('admin/dashboard.html');

    assert.match(dashboard, /data-add-child-buckets/);
    assert.match(dashboard, /data-add-date-picker/);
    assert.match(dashboard, /data-add-calendar-grid/);
    assert.match(dashboard, /data-add-calendar-apply/);
    assert.doesNotMatch(dashboard, /data-add-payment-type/);
  });

  it('groups multi-room bookings into one calendar block across occupied rooms and days', () => {
    const { EcoVilaCrmCalendar: calendar } = loadAdminModule('admin/js/crm-calendar.js');
    const rooms = Array.from({ length: 6 }, (_, index) => ({
      id: `room-${index + 1}`,
      number: index + 1,
      type: 'small',
    }));
    const reservations = [3, 4, 5].map((number) => ({
      id: `reservation-${number}`,
      booking_group_id: 'group-may-11',
      room_id: `room-${number}`,
      rooms: { id: `room-${number}`, number, type: 'small' },
      guest_first_name: 'Alina',
      guest_last_name: 'Auzeac',
      guest_phone: '+37369857607',
      check_in: '2026-05-11',
      check_out: '2026-05-20',
      payment_type: 'card',
      payment_status: 'paid',
    }));
    const blocks = calendar.buildReservationBlocks(
      reservations,
      rooms,
      calendar.enumerateDates('2026-05-01', 31),
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].bookingGroupId, 'group-may-11');
    assert.deepEqual(Array.from(blocks[0].reservationIds), ['reservation-3', 'reservation-4', 'reservation-5']);
    assert.deepEqual(Array.from(blocks[0].roomNumbers), [3, 4, 5]);
    assert.equal(blocks[0].columnStart, 12, 'May 11 should start in the eleventh date column plus room labels');
    assert.equal(blocks[0].columnSpan, 9, 'check-out day should not be included');
    assert.equal(blocks[0].rowStart, 4, 'room 3 should start after the header and rooms 1-2');
    assert.equal(blocks[0].rowSpan, 3);
  });

  it('groups pending cash rows by booking group and totals them once', () => {
    const { EcoVilaCrmCalendar: calendar } = loadAdminModule('admin/js/crm-calendar.js');
    const pending = calendar.groupPendingCashReservations([
      {
        id: 'reservation-3',
        booking_group_id: 'cash-group',
        room_id: 'room-3',
        rooms: { number: 3, type: 'small' },
        total_price: 1200,
        cash_expires_at: '2026-05-08T10:30:00.000Z',
      },
      {
        id: 'reservation-4',
        booking_group_id: 'cash-group',
        room_id: 'room-4',
        rooms: { number: 4, type: 'small' },
        total_price: 1300,
        cash_expires_at: '2026-05-08T10:30:00.000Z',
      },
    ]);

    assert.equal(pending.length, 1);
    assert.equal(pending[0].bookingGroupId, 'cash-group');
    assert.deepEqual(Array.from(pending[0].reservationIds), ['reservation-3', 'reservation-4']);
    assert.deepEqual(Array.from(pending[0].roomNumbers), [3, 4]);
    assert.equal(pending[0].totalPrice, 2500);
  });

  it('maps CRM child buckets, validates exact rooms, and totals mixed room selections once per group', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js', {
      EcoVilaPricing: pricing,
      EcoVilaCalendar: calendar,
    });
    const rooms = [
      { id: 'room-3', number: 3, type: 'small', is_active: true },
      { id: 'room-11', number: 11, type: 'large', is_active: true },
    ];
    const reservations = [
      {
        room_id: 'room-11',
        check_in: '2026-05-18',
        check_out: '2026-05-19',
        payment_status: 'paid',
        cancelled_at: null,
      },
    ];
    const pricingTiers = [
      { nights_tier: 1, day_type: 'weekday', adult_price: 1100, kid_price: 900, effective_from: '2026-05-06' },
      { nights_tier: 1, day_type: 'holiday', adult_price: 1300, kid_price: 1000, effective_from: '2026-05-06' },
    ];

    assert.deepEqual(Array.from(sidebar.bucketValuesToAges(['0-3', '4-11', '12+'])), [3, 4, 12]);
    assert.equal(
      sidebar.areSelectedRoomsAvailable({
        rooms,
        reservations,
        roomNumbers: [3],
        checkIn: '2026-05-18',
        checkOut: '2026-05-19',
      }),
      true,
    );
    assert.equal(
      sidebar.areSelectedRoomsAvailable({
        rooms,
        reservations,
        roomNumbers: [3, 11],
        checkIn: '2026-05-18',
        checkOut: '2026-05-19',
      }),
      false,
    );
    assert.equal(
      sidebar.calculateStaffTotal({
        rooms,
        roomNumbers: [3, 11],
        adults: 4,
        kidsAges: [3, 4, 12],
        checkIn: '2026-05-18',
        checkOut: '2026-05-19',
        pricingTiers,
        holidays: [],
        createdOn: '2026-05-17',
      }).total,
      6400,
      'mixed-room pricing should apply the combined 5-adult room floor once to the one guest group',
    );
  });

  it('keeps the CRM range calendar open when a rerendered calendar click originated inside the picker', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const detachedDateButton = { closest() { return null; } };
    const pickerNode = { dataset: { addDatePicker: '' } };

    assert.equal(
      sidebar.isClickInsideAddDatePicker({
        target: detachedDateButton,
        composedPath() {
          return [detachedDateButton, pickerNode];
        },
      }),
      true,
    );
  });

  it('creates one paid din oficiu staff booking group for multiple rooms', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const rows = sidebar.buildStaffReservationRows(
      formWithFields({
        '[data-add-room-numbers]': field('3, 4, 5'),
        '[data-add-first-name]': field('Alina'),
        '[data-add-last-name]': field('Auzeac'),
        '[data-add-phone]': field('+37369857607'),
        '[data-add-email]': field('alina@example.md'),
        '[data-add-check-in]': field('2026-05-11'),
        '[data-add-check-out]': field('2026-05-20'),
        '[data-add-adults]': field('2'),
        '[data-add-child-bucket]:checked': [],
        '[data-add-total]': field('', { dataset: { total: '9000' } }),
        '[data-add-conference]': field('', { checked: false }),
        '[data-add-notes]': field(''),
      }),
      [
        { id: 'room-3', number: 3 },
        { id: 'room-4', number: 4 },
        { id: 'room-5', number: 5 },
      ],
      { role: 'diana' },
      {
        createGroupId: () => 'staff-group',
        now: new Date('2026-05-08T09:00:00.000Z'),
      },
    );

    assert.equal(rows.length, 3);
    assert.deepEqual(Array.from(new Set(Array.from(rows, (row) => row.booking_group_id))), ['staff-group']);
    assert.deepEqual(Array.from(rows, (row) => row.payment_type), ['office', 'office', 'office']);
    assert.deepEqual(Array.from(rows, (row) => row.payment_status), ['paid', 'paid', 'paid']);
    assert.deepEqual(Array.from(rows, (row) => row.cash_expires_at), [null, null, null]);
  });

  it('renders din oficiu as a CRM detail payment label', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');

    assert.match(dashboardJs, /office:\s*'din oficiu'/);
    assert.match(dashboardJs, /PAYMENT_LABELS/);
  });

  it('adds collapsible sidebar, current-month navigation, jump date, and today stats hooks', () => {
    const dashboard = read('admin/dashboard.html');
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const css = read('css/crm.css');

    for (const hook of [
      'data-collapse-sidebar',
      'data-calendar-month',
      'data-calendar-jump-date',
      'data-calendar-today',
      'data-stat-free-rooms',
      'data-stat-occupied-rooms',
      'data-stat-arrivals-today',
      'data-stat-departures-today',
      'data-stat-pending-cash',
    ]) {
      assert.match(dashboard, new RegExp(hook), `${hook} should exist`);
    }

    assert.match(dashboardJs, /renderTodayStats/i);
    assert.match(dashboardJs, /state\.today/i);
    assert.match(dashboardJs, /scrollCalendarToDate/i);
    assert.match(css, /crm-dashboard-stats/i);
    assert.match(css, /is-sidebar-collapsed/i);
  });

  it('keeps calendar room rows numeric-only and omits room labels inside reservation blocks', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const css = read('css/crm.css');

    assert.doesNotMatch(dashboardJs, /roomShortLabel\(room\)/);
    assert.doesNotMatch(dashboardJs, /block\.roomLabel/);
    assert.match(dashboardJs, /class="crm-reservation-card__phone"/);
    assert.match(css, /\.crm-calendar-cell--room strong[\s\S]*font-size:\s*1\.85rem/i);
    assert.match(css, /\.crm-calendar-cell--room[\s\S]*place-items:\s*center/i);
    assert.match(css, /crm-reservation-card__phone[\s\S]*font-size:\s*0\.74rem[\s\S]*text-overflow:\s*clip/i);
  });

  it('formats Moldovan phone numbers with spaces inside calendar cards', () => {
    const { EcoVilaCrmCalendar: calendar } = loadAdminModule('admin/js/crm-calendar.js');
    const dashboardJs = read('admin/js/crm-dashboard.js');

    assert.equal(calendar.formatCalendarPhone('+37368983660'), '+373 689 836 60');
    assert.equal(calendar.formatCalendarPhone('37368234952'), '+373 682 349 52');
    assert.equal(calendar.formatCalendarPhone('+373 589 825 00'), '+373 589 825 00');
    assert.match(dashboardJs, /formatCalendarPhone\(reservation\.guest_phone\)/);
  });

  it('prevents reservation card overlap and keeps date headers sticky while scrolling the table', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const css = read('css/crm.css');

    assert.match(css, /--crm-room-column-width:\s*88px/i);
    assert.match(css, /--crm-day-column-width:\s*136px/i);
    assert.match(css, /--crm-calendar-room-row-height:\s*52px/i);
    assert.match(dashboardJs, /repeat\(\$\{state\.rooms\.length\}, var\(--crm-calendar-room-row-height\)\)/);
    assert.match(css, /\.crm-panel\[data-panel="dashboard"\]\.is-active\s*\{[\s\S]*height:\s*calc\(100vh - 69px\)[\s\S]*overflow:\s*hidden/i);
    assert.match(css, /\.crm-calendar\s*\{[\s\S]*height:\s*calc\(100vh - 286px\)[\s\S]*max-height:\s*calc\(100vh - 286px\)/i);
    assert.match(css, /\.crm-calendar-cell--head\s*\{[\s\S]*position:\s*sticky[\s\S]*top:\s*0/i);
    assert.match(css, /\.crm-calendar-cell--room\s*\{[\s\S]*z-index:\s*[5-9]/i);
    assert.match(css, /\.crm-reservation-card--block\s*\{[\s\S]*z-index:\s*[1-4][\s\S]*align-self:\s*end/i);
    assert.match(css, /\.crm-reservation-card--multi-row\s*\{[\s\S]*align-self:\s*stretch/i);
    assert.match(dashboardJs, /block\.rowSpan > 1/);
  });

  it('centers tall multi-villa reservation cards as one content stack', () => {
    const css = read('css/crm.css');

    assert.match(
      css,
      /\.crm-reservation-card--multi-row\s*\{[\s\S]*align-content:\s*center[\s\S]*justify-items:\s*center[\s\S]*text-align:\s*center/i,
    );
  });

  it('implements the shared daily reception workflow', () => {
    const dashboard = read('admin/dashboard.html');
    const daily = read('admin/js/crm-daily.js');
    const app = read('admin/js/crm-app.js');
    const css = read('css/crm.css');

    for (const label of [
      'Se cazează azi',
      'Pleacă azi',
      'Adaugă un feedback clientului',
      'Actualizează oaspeții',
      'De încasat suplimentar',
      'De rambursat',
      'Zile extra',
      'Check-out nou',
      'De eliberat',
      'De primit',
    ]) {
      assert.match(`${dashboard}\n${daily}`, new RegExp(label, 'i'));
    }

    assert.doesNotMatch(daily, /S-a cazat|A plecat/i);
    assert.match(daily, /crm-daily-check/i);
    assert.match(daily, /aria-label/i);
    assert.match(dashboard, /data-daily-date-label/i);
    assert.doesNotMatch(dashboard, /data-daily-date hidden/i);
    assert.match(css, /crm-date-picker-button/i);
    assert.match(css, /crm-daily-empty__art/i);
    assert.match(daily, /EcoVilaCrmCalendar\.todayISO\(\)/i);
    assert.doesNotMatch(daily, /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/i);
    assert.match(daily, /showToday/i);
    assert.match(app, /EcoVilaCrmDaily\?\.showToday\?\.\(\)/i);
    assert.match(daily, /crm_daily_statuses/i);
    assert.match(daily, /check_in/i);
    assert.match(daily, /check_out/i);
    assert.match(daily, /towel_cards_issued/i);
    assert.match(daily, /data-daily-edit-child-buckets/i);
    assert.match(daily, /data-daily-edit-extra-days/i);
    assert.match(daily, /data-daily-edit-new-check-out/i);
    assert.match(daily, /data-daily-edit-availability/i);
    assert.match(daily, /upsert/i);
    assert.match(daily, /sortByRoomWithCompletedLast/i);
  });

  it('adds an expandable daily search by room, guest name, surname, and phone', () => {
    const dashboard = read('admin/dashboard.html');
    const css = read('css/crm.css');
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      EcoVilaCrmCalendar: {
        roomNumber(reservation) {
          return Number(reservation.rooms?.number || 0);
        },
        roomLabel(reservation) {
          return `Camera ${reservation.rooms?.number || ''}`;
        },
        guestName(reservation) {
          return [reservation.guest_first_name, reservation.guest_last_name].filter(Boolean).join(' ');
        },
        formatCalendarPhone(phone) {
          return String(phone || '').replace(/^\+373(\d{3})(\d{3})(\d{2})$/, '+373 $1 $2 $3');
        },
      },
    });
    const reservation = {
      guest_first_name: 'Ion',
      guest_last_name: 'Țurcanu',
      guest_phone: '+37368983660',
      rooms: { number: 12 },
    };
    const differentRoomWithPhoneFragment = {
      guest_first_name: 'Ana',
      guest_last_name: 'Popescu',
      guest_phone: '+37360111222',
      rooms: { number: 18 },
    };

    for (const hook of [
      'data-daily-titlebar',
      'data-daily-search-form',
      'data-daily-search-toggle',
      'data-daily-search',
    ]) {
      assert.match(dashboard, new RegExp(hook), `${hook} should exist`);
    }

    assert.match(css, /\.crm-daily-search\s*\{[\s\S]*width:\s*44px/i);
    assert.match(css, /\.crm-daily-search:focus-within[\s\S]*\.crm-daily-search\.has-value[\s\S]*width:\s*min\(340px,\s*42vw\)/i);
    assert.equal(typeof daily.dailyReservationMatchesSearch, 'function');
    assert.equal(daily.dailyReservationMatchesSearch(reservation, '12'), true);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, 'Ion'), true);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, 'turcanu'), true);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, '689 836'), true);
    assert.equal(daily.dailyReservationMatchesSearch(differentRoomWithPhoneFragment, '12'), false);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, 'popescu'), false);
  });

  it('calculates exact daily guest supplements from editable child age buckets', () => {
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      EcoVilaPricing: pricing,
      EcoVilaCrmCalendar: {
        addDays: pricing.addDays,
        roomNumber(reservation) {
          return Number(reservation.rooms?.number || 0);
        },
      },
      EcoVilaCrmSidebar: {
        calculateStaffTotal(input) {
          return {
            total: pricing.calculateStayPrice({
              roomType: input.rooms[0].type,
              checkIn: input.checkIn,
              checkOut: input.checkOut,
              adults: input.adults,
              kidsAges: input.kidsAges,
              pricingTiers: input.pricingTiers,
              holidays: input.holidays,
              createdOn: input.createdOn,
            }).total,
          };
        },
        splitTotalPrice(total) {
          return [total];
        },
      },
    });
    const pricingTiers = [
      { nights_tier: 1, day_type: 'weekday', adult_price: 1000, kid_price: 500, effective_from: '2026-05-01' },
      { nights_tier: 1, day_type: 'holiday', adult_price: 1000, kid_price: 500, effective_from: '2026-05-01' },
      { nights_tier: 2, day_type: 'weekday', adult_price: 1000, kid_price: 500, effective_from: '2026-05-01' },
      { nights_tier: 2, day_type: 'holiday', adult_price: 1000, kid_price: 500, effective_from: '2026-05-01' },
    ];
    const reservation = {
      id: 'reservation-1',
      room_id: 'room-1',
      booking_group_id: 'group-1',
      check_in: '2026-05-18',
      check_out: '2026-05-19',
      created_at: '2026-05-17T10:00:00Z',
      adults: 2,
      kids_ages: [3, 12],
      total_price: 3000,
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };

    assert.deepEqual(daily.kidsAgesToBuckets([3, 4, 12]), ['0-3', '4-11', '12+']);
    assert.deepEqual(daily.bucketValuesToAges(['0-3', '4-11', '12+']), [3, 4, 12]);
    assert.equal(
      daily.calculateDailySupplement({
        reservations: [reservation],
        reservation,
        adults: 2,
        childBuckets: ['0-3', '4-11'],
        pricingTiers,
        holidays: [],
      }).supplement,
      0,
      'changing an older child to a standard child should not ask staff to refund',
    );
    assert.equal(
      daily.calculateDailySupplement({
        reservations: [reservation],
        reservation,
        adults: 1,
        childBuckets: ['0-3'],
        pricingTiers,
        holidays: [],
      }).reimbursement,
      1000,
      'removing billable guests should tell staff what must be reimbursed',
    );
    assert.equal(
      daily.calculateDailySupplement({
        reservations: [reservation],
        reservation,
        adults: 3,
        childBuckets: ['0-3', '4-11', '12+'],
        pricingTiers,
        holidays: [],
      }).supplement,
      1500,
      'one extra adult and one extra 12+ child should be priced exactly from selected buckets',
    );
    const extraNightQuote = daily.calculateDailySupplement({
      reservations: [reservation],
      reservation,
      adults: 2,
      childBuckets: ['0-3', '12+'],
      extraDays: 1,
      pricingTiers,
      holidays: [],
    });
    assert.equal(extraNightQuote.checkOut, '2026-05-20');
    assert.equal(extraNightQuote.supplement, 3000);
    assert.equal(extraNightQuote.reimbursement, 0);
    assert.equal(
      daily.checkDailyExtensionAvailability({
        reservations: [
          reservation,
          {
            id: 'reservation-2',
            room_id: 'room-1',
            check_in: '2026-05-19',
            check_out: '2026-05-20',
            payment_status: 'paid',
          },
        ],
        group: [reservation],
        reservation,
        checkOut: '2026-05-20',
      }).available,
      false,
      'extra days should be blocked when the same room is already reserved',
    );
  });

  it('implements the SPA towel counter tab with daily room counts', () => {
    const dashboard = read('admin/dashboard.html');
    const app = read('admin/js/crm-app.js');
    const towels = read('admin/js/crm-towels.js');
    const helpers = read('js/supabase.js');
    const css = read('css/crm.css');
    const migrations = allMigrations();

    assert.match(dashboard, /data-panel="towels"/i);
    assert.match(dashboard, /data-towels-date-label/i);
    assert.match(dashboard, /data-towels-grid/i);
    assert.match(dashboard, /data-towels-completed/i);
    assert.match(dashboard, /data-towels-save-status/i);
    assert.match(dashboard, /Camere completate/i);
    assert.match(dashboard, /Salvat/i);
    assert.doesNotMatch(dashboard, /Salvat automat/i);
    assert.match(dashboard, /js\/crm-towels\.js/i);
    assert.match(app, /EcoVilaCrmTowels\?\.init\?\.\(context\)/i);
    assert.match(app, /EcoVilaCrmTowels\?\.showToday\?\.\(\)/i);
    assert.match(towels, /crm_towel_counts/i);
    assert.match(towels, /fetchRooms/i);
    assert.match(towels, /upsertTowelCount/i);
    assert.match(towels, /TOWEL_SAVE_DELAY_MS\s*=\s*5000/i);
    assert.match(towels, /SAVE_STATUS_VISIBLE_MS\s*=\s*3000/i);
    assert.match(towels, /completedCount/i);
    assert.match(towels, /data-towel-room-number/i);
    assert.match(helpers, /function fetchTowelCounts/i);
    assert.match(helpers, /function upsertTowelCount/i);
    assert.match(css, /crm-towels-grid/i);
    assert.match(css, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/i);
    assert.match(css, /\.crm-towels-stat-card/i);
    assert.match(css, /\.crm-towels-save-status/i);
    assert.match(css, /margin-top:\s*96px/i);
    assert.match(migrations, /add column if not exists towel_cards_issued integer/i);
    assert.match(migrations, /create table if not exists public\.crm_towel_counts/i);
    assert.match(migrations, /alter table public\.crm_towel_counts\s+enable row level security/i);
    assert.match(migrations, /grant select, insert, update, delete on\s+public\.crm_towel_counts\s+to authenticated/i);
    assert.match(migrations, /create policy "CRM staff can manage towel counts"/i);
    assert.match(migrations, /alter publication supabase_realtime add table public\.crm_towel_counts/i);
  });

  it('debounces SPA towel saves and shows a short saved status after persistence', async () => {
    const timers = new Map();
    const calls = [];
    let timerId = 0;
    const statusText = { textContent: '' };
    const statusClasses = new Set();
    const status = {
      classList: {
        add(name) {
          statusClasses.add(name);
        },
        remove(name) {
          statusClasses.delete(name);
        },
      },
      querySelector(selector) {
        return selector === 'span' ? statusText : null;
      },
    };
    const { EcoVilaCrmTowels: towels } = loadAdminModule('admin/js/crm-towels.js', {
      document: {
        querySelector(selector) {
          if (selector === '[data-towels-save-status]') {
            return status;
          }
          if (selector === '[data-towels-save-status] span') {
            return statusText;
          }
          return null;
        },
      },
      setTimeout(fn, delay) {
        timerId += 1;
        timers.set(timerId, { fn, delay });
        return timerId;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
      EcoVilaSupabase: {
        fetchRooms: async () => [],
        fetchTowelCounts: async () => [],
        upsertTowelCount: async (client, payload) => {
          calls.push(payload);
          return [payload];
        },
      },
    });
    const context = {
      client: {},
      session: { user: { id: 'staff-1' } },
      setAlert(message) {
        throw new Error(message);
      },
    };
    const state = {
      selectedDate: '2026-05-24',
      rooms: [],
      counts: [],
    };
    const room = { id: 'room-1', number: 1 };

    towels.scheduleTowelCountSave(context, state, room, 1);
    towels.scheduleTowelCountSave(context, state, room, 2);
    towels.scheduleTowelCountSave(context, state, room, 3);

    assert.equal(calls.length, 0, 'rapid clicks should not write immediately');
    const pendingSaveTimers = Array.from(timers.values()).filter((timer) => timer.delay === 5000);
    assert.equal(pendingSaveTimers.length, 1, 'only the final rapid click should leave one save timer');

    await pendingSaveTimers[0].fn();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].towel_count, 3);
    assert.equal(statusText.textContent, 'Salvat');
    assert.ok(statusClasses.has('is-visible'));
    const fadeTimer = Array.from(timers.values()).find((timer) => timer.delay === 3000);
    assert.ok(fadeTimer, 'saved status should be scheduled to fade after 3 seconds');
  });

  it('implements draft photo management with first photo as cover', () => {
    const dashboard = read('admin/dashboard.html');
    const photos = read('admin/js/crm-photos.js');
    const helpers = read('js/supabase.js');

    for (const label of [
      'Landing',
      'Căsuță Mică',
      'Căsuță Mare',
      'Hotel',
      'SPA',
      'Teritoriu',
      'Restaurant/Mâncare',
      'Teren de joacă',
      'Publică pozele',
    ]) {
      assert.match(`${dashboard}\n${photos}`, new RegExp(label, 'i'));
    }

    assert.match(photos, /ecovila-photos/i);
    assert.match(photos, /status:\s*'draft'/i);
    assert.match(photos, /publish_crm_photos/i);
    assert.match(photos, /sort_order\s*===\s*1|sort_order:\s*1/i);
    assert.match(helpers, /fetchPublishedPhotos/i);
  });

  it('renders the photo tab as spacious section cards with counts, empty states, and media groups', () => {
    const dashboard = read('admin/dashboard.html');
    const photos = read('admin/js/crm-photos.js');
    const css = read('css/crm.css');

    for (const hook of [
      'crm-photos-header',
      'crm-photos-title',
      'crm-photos-publish',
    ]) {
      assert.match(dashboard, new RegExp(hook), `${hook} should exist in the photo panel`);
    }

    for (const hook of [
      'crm-photo-card-head',
      'crm-photo-count',
      'crm-photo-empty__icon',
      'crm-photo-group-label',
      'crm-photo-thumb--primary',
      'crm-photo-secondary-grid',
      'crm-photo-remove',
      'data-photo-id',
      'draggable="true"',
    ]) {
      assert.match(photos, new RegExp(hook), `${hook} should be rendered by the photo manager`);
    }

    assert.doesNotMatch(photos, /crm-photo-drag-handle/);

    assert.match(css, /\.crm-panel\[data-panel="photos"\]\.is-active/i);
    assert.match(css, /\.crm-photo-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/i);
    assert.match(css, /\.crm-photo-section\s*\{[\s\S]*min-height:\s*332px/i);
    assert.match(css, /\.crm-photo-empty\s*\{[\s\S]*place-items:\s*center/i);
    assert.match(css, /\.crm-photo-thumb--primary\s+\.crm-photo-thumb__media\s*\{[\s\S]*aspect-ratio:\s*16 \/ 10/i);
    assert.match(css, /\.crm-photo-thumb\[draggable="true"\]/i);
    assert.doesNotMatch(css, /crm-photo-drag-handle/i);
  });

  it('uploads new CRM photos as inserts so storage RLS does not require overwrite permissions', async () => {
    const { EcoVilaSupabase: helpers } = loadAdminModule('js/supabase.js');
    let capturedUpload;
    const client = {
      storage: {
        from(bucket) {
          return {
            upload(storagePath, file, options) {
              capturedUpload = { bucket, storagePath, file, options };
              return Promise.resolve({ data: { path: storagePath }, error: null });
            },
          };
        },
      },
    };

    const file = { name: 'forest.jpg' };
    await helpers.uploadCrmPhoto(client, 'landing/forest.jpg', file);

    assert.equal(capturedUpload.bucket, 'ecovila-photos');
    assert.equal(capturedUpload.storagePath, 'landing/forest.jpg');
    assert.equal(capturedUpload.file, file);
    assert.equal(capturedUpload.options.upsert, false);
    assert.equal(capturedUpload.options.cacheControl, '31536000');
  });

  it('keeps Landing homepage position labels while showing the visual main-image label', () => {
    const renderedItems = [];
    const uploadInput = { addEventListener() {} };
    const list = {
      innerHTML: '',
      appendChild(item) {
        renderedItems.push(item);
      },
    };
    const sectionNode = {
      innerHTML: '',
      querySelector(selector) {
        if (selector === '.crm-photo-list') {
          return list;
        }

        if (selector === '[data-photo-upload="landing"]') {
          return uploadInput;
        }

        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const documentRef = {
      querySelector(selector) {
        return selector === '[data-photo-section="landing"]' ? sectionNode : null;
      },
      createElement() {
        return { className: '', innerHTML: '', textContent: '' };
      },
    };
    const { EcoVilaCrmPhotos: photos } = loadAdminModule('admin/js/crm-photos.js', {
      document: documentRef,
      EcoVilaSupabase: {
        getCrmPhotoPublicUrl: (_client, storagePath) => `/public/${storagePath}`,
      },
    });

    photos.renderPhotoSection(
      { client: {} },
      { slug: 'landing', label: 'Landing' },
      [{ id: 'photo-1', storage_path: 'landing/intro.jpg', alt_text: 'Intro', sort_order: 1 }],
    );

    assert.equal(renderedItems[0].textContent, 'Imagine principală');
    assert.match(renderedItems[1].innerHTML, /Poza 2 pe site/);
    assert.match(renderedItems[1].className, /crm-photo-thumb--primary/);
  });

  it('persists draft photo order after drag and drop reordering', async () => {
    const updates = [];
    const { EcoVilaCrmPhotos: photos } = loadAdminModule('admin/js/crm-photos.js', {
      document: { querySelector() { return null; } },
      EcoVilaSupabase: {
        updateCrmPhoto(_client, photoId, values) {
          updates.push({ photoId, values });
          return Promise.resolve([]);
        },
      },
    });

    await photos.reorderPhotos(
      { client: {}, setAlert() {} },
      { slug: 'small-villa', label: 'Căsuță Mică' },
      [
        { id: 'photo-1', sort_order: 1 },
        { id: 'photo-2', sort_order: 2 },
        { id: 'photo-3', sort_order: 3 },
      ],
      'photo-3',
      'photo-1',
    );

    assert.deepEqual(JSON.parse(JSON.stringify(updates)), [
      { photoId: 'photo-3', values: { sort_order: 1 } },
      { photoId: 'photo-1', values: { sort_order: 2 } },
      { photoId: 'photo-2', values: { sort_order: 3 } },
    ]);
  });

  it('re-renders reordered photos immediately before the save finishes', async () => {
    let resolveUpdate;
    const updatePromise = new Promise((resolve) => {
      resolveUpdate = resolve;
    });
    const renderedItems = [];
    const uploadInput = { addEventListener() {} };
    const list = {
      innerHTML: '',
      appendChild(item) {
        renderedItems.push(item);
      },
    };
    const sectionNode = {
      innerHTML: '',
      querySelector(selector) {
        if (selector === '.crm-photo-list') {
          return list;
        }

        if (selector === '[data-photo-upload="small-villa"]') {
          return uploadInput;
        }

        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const documentRef = {
      querySelector(selector) {
        return selector === '[data-photo-section="small-villa"]' ? sectionNode : null;
      },
      createElement() {
        return {
          className: '',
          children: [],
          innerHTML: '',
          textContent: '',
          appendChild(item) {
            this.children.push(item);
          },
          setAttribute() {},
        };
      },
    };
    const { EcoVilaCrmPhotos: photos } = loadAdminModule('admin/js/crm-photos.js', {
      document: documentRef,
      EcoVilaSupabase: {
        getCrmPhotoPublicUrl: (_client, storagePath) => `/public/${storagePath}`,
        updateCrmPhoto() {
          return updatePromise;
        },
      },
    });

    const reorderPromise = photos.reorderPhotos(
      { client: {}, setAlert() {} },
      { slug: 'small-villa', label: 'Căsuță Mică' },
      [
        { id: 'photo-1', storage_path: 'one.jpg', sort_order: 1 },
        { id: 'photo-2', storage_path: 'two.jpg', sort_order: 2 },
        { id: 'photo-3', storage_path: 'three.jpg', sort_order: 3 },
      ],
      'photo-3',
      'photo-1',
    );

    assert.match(renderedItems[1].innerHTML, /data-remove-photo="photo-3"/);
    resolveUpdate([]);
    await reorderPromise;
  });

  it('uses an animated three-second toast for photo publish confirmation', () => {
    const dashboard = read('admin/dashboard.html');
    const photos = read('admin/js/crm-photos.js');
    const css = read('css/crm.css');

    assert.match(dashboard, /data-crm-toast/);
    assert.match(photos, /showPhotoToast/);
    assert.match(photos, /setTimeout\([\s\S]*3000/);
    assert.doesNotMatch(photos, /setAlert\('Pozele au fost publicate\.'\)/);
    assert.match(css, /\.crm-toast/i);
    assert.match(css, /@keyframes\s+crm-toast-in/i);
  });

  it('moves pricing and holidays into the Prețuri tab', () => {
    const dashboard = read('admin/dashboard.html');
    const pricing = read('admin/js/crm-pricing.js');

    for (const label of [
      'Data intrării în vigoare',
      'Salvează prețuri',
      'Rezervările existente nu vor fi afectate',
      'Zile de sărbătoare',
      'Adaugă zi',
    ]) {
      assert.match(`${dashboard}\n${pricing}`, new RegExp(label, 'i'));
    }

    assert.match(pricing, /pricing_tiers/i);
    assert.match(pricing, /holidays/i);
    assert.match(pricing, /effective_from/i);
  });

  it('builds pricing rows with the selected effective date when only child prices change', () => {
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');
    const priceRow = {
      dataset: { tier: '1', dayType: 'weekday' },
      querySelector(selector) {
        return {
          '[data-adult-price]': field('1100'),
          '[data-kid-price]': field('850'),
        }[selector];
      },
    };
    const document = {
      querySelector(selector) {
        return selector === '[data-price-effective-from]' ? field('2026-06-15') : null;
      },
      querySelectorAll(selector) {
        return selector === '[data-price-row]' ? [priceRow] : [];
      },
    };

    assert.deepEqual(JSON.parse(JSON.stringify(pricing.collectPricingRows(document))), [
      {
        nights_tier: 1,
        day_type: 'weekday',
        adult_price: 1100,
        kid_price: 850,
        effective_from: '2026-06-15',
      },
    ]);
  });

  it('keeps newest same-date pricing rows active after repeated saves', () => {
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');
    const oldRows = [
      [1, 'weekday', 1100, 900],
      [1, 'holiday', 1300, 1000],
      [2, 'weekday', 1000, 800],
      [2, 'holiday', 1200, 900],
      [3, 'weekday', 900, 700],
      [3, 'holiday', 1100, 800],
    ].map(([nights_tier, day_type, adult_price, kid_price]) => ({
      nights_tier,
      day_type,
      adult_price,
      kid_price,
      effective_from: '2026-05-08',
      created_at: '2026-05-08T09:00:00.000Z',
    }));
    const latestRows = [
      [1, 'weekday', 1300, 600],
      [1, 'holiday', 1550, 600],
      [2, 'weekday', 1100, 600],
      [2, 'holiday', 1550, 600],
      [3, 'weekday', 1100, 600],
      [3, 'holiday', 1550, 600],
    ].map(([nights_tier, day_type, adult_price, kid_price]) => ({
      nights_tier,
      day_type,
      adult_price,
      kid_price,
      effective_from: '2026-05-08',
      created_at: '2026-05-08T10:00:00.000Z',
    }));

    assert.deepEqual(
      JSON.parse(JSON.stringify(pricing.activePricingRows(oldRows.concat(latestRows)).map((row) => [
        row.nights_tier,
        row.day_type,
        row.adult_price,
        row.kid_price,
      ]))),
      [
        [1, 'weekday', 1300, 600],
        [1, 'holiday', 1550, 600],
        [2, 'weekday', 1100, 600],
        [2, 'holiday', 1550, 600],
        [3, 'weekday', 1100, 600],
        [3, 'holiday', 1550, 600],
      ],
    );
  });

  it('shows a three-second pricing toast after saving prices', () => {
    const dashboard = read('admin/dashboard.html');
    const pricing = read('admin/js/crm-pricing.js');
    const css = read('css/crm.css');

    assert.match(dashboard, /data-crm-toast/);
    assert.match(pricing, /showPricingToast/);
    assert.match(pricing, /Prețuri actualizate/);
    assert.match(pricing, /setTimeout\([\s\S]*3000/);
    assert.doesNotMatch(pricing, /setAlert\('Prețurile au fost salvate/);
    assert.match(css, /\.crm-toast/i);
  });

  it('uses recurring day and month controls for CRM holidays', () => {
    const dashboard = read('admin/dashboard.html');
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');

    assert.match(dashboard, /data-holiday-day/i);
    assert.match(dashboard, /data-holiday-month/i);
    assert.doesNotMatch(dashboard, /data-holiday-date/i);
    assert.equal(pricing.toRecurringHolidayDate({ day: '30', month: '5' }), '2000-05-30');
    assert.equal(pricing.formatRecurringHoliday({ date: '2026-05-30' }), '30 mai');
  });

  it('adds Supabase CRM schema, storage, RLS, and publish RPC', () => {
    const sql = allMigrations();

    for (const table of ['crm_photo_sections', 'crm_photos', 'crm_daily_statuses']) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${table}`, 'i'));
      assert.match(sql, new RegExp(`alter table public\\.${table}\\s+enable row level security`, 'i'));
    }

    assert.match(sql, /insert into storage\.buckets[\s\S]+ecovila-photos/i);
    assert.match(sql, /bucket_id = 'ecovila-photos'/i);
    assert.match(sql, /create or replace function public\.publish_crm_photos\(\)/i);
    assert.match(sql, /ecovila_app_role\(\) in \('diana', 'angela'\)/i);
    assert.match(sql, /created_by in \('guest', 'diana', 'angela'\)/i);
    assert.match(sql, /alter publication supabase_realtime add table public\.reservations/i);
    assert.match(sql, /drop policy if exists "Public can read EcoVila photos" on storage\.objects/i);
    assert.match(sql, /crm_photos_created_by_idx/i);
    assert.match(sql, /crm_daily_statuses_updated_by_idx/i);
    assert.match(sql, /to anon\s+using \(status = 'published'\)/i);
  });
});
