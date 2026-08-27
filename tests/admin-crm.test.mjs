import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const pricing = require('../js/pricing.js');
const calendar = require('../js/calendar.js');

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

function createFakeElement(tagName = 'div') {
  const classes = new Set();
  const listeners = new Map();
  let html = '';
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    className: '',
    dataset: {},
    hidden: false,
    style: {},
    textContent: '',
    value: '',
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value);
      this.children = [];
    },
    append(...items) {
      items.forEach((item) => {
        this.appendChild(item);
      });
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(eventName, handler) {
      listeners.set(eventName, [...(listeners.get(eventName) || []), handler]);
    },
    click() {
      (listeners.get('click') || []).forEach((handler) => {
        handler({
          target: this,
          composedPath: () => [this],
        });
      });
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return shouldAdd;
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };

  return element;
}

function createFinanceDocument() {
  const elements = new Map();

  function register(selector, tagName = 'button') {
    const element = createFakeElement(tagName);
    elements.set(selector, element);
    return element;
  }

  const modeNights = register('[data-finance-mode="nights"]');
  modeNights.dataset.financeMode = 'nights';
  const modePaid = register('[data-finance-mode="paid"]');
  modePaid.dataset.financeMode = 'paid';

  register('[data-finance-prev]');
  register('[data-finance-next]');
  register('[data-finance-range-label]');
  register('[data-finance-range-calendar]', 'div');
  register('[data-finance-calendar-title]', 'span');
  register('[data-finance-calendar-grid]', 'div');
  register('[data-finance-calendar-prev]');
  register('[data-finance-calendar-next]');
  register('[data-finance-calendar-clear]');
  register('[data-finance-calendar-apply]');
  register('[data-finance-booked-day]', 'section');
  register('[data-finance-booked-count]', 'span');
  register('[data-finance-booked-list]', 'div');
  register('[data-finance-booked-empty]', 'p');
  register('[data-finance-cancelled-count]', 'strong');
  register('[data-finance-refund-gross]', 'strong');
  register('[data-finance-withheld-commission]', 'strong');
  register('[data-finance-refunded-total]', 'strong');
  register('[data-finance-bank-fees]', 'strong');
  register('[data-finance-net-cost]', 'strong');
  register('[data-finance-cancel-count]', 'strong');
  register('[data-finance-cancel-list]', 'div');
  register('[data-finance-cancel-empty]', 'p');
  register('[data-finance-scheduled]', 'section');
  register('[data-finance-scheduled-list]', 'div');
  register('[data-finance-scheduled-empty]', 'p');
  register('[data-finance-scheduled-count]', 'strong');

  return {
    document: {
      querySelector(selector) {
        return elements.get(selector) || null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-finance-mode]') {
          return [modeNights, modePaid];
        }
        return elements.has(selector) ? [elements.get(selector)] : [];
      },
      createElement: createFakeElement,
      addEventListener() {},
    },
    elements,
  };
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function allMigrations() {
  return fs
    .readdirSync(path.join(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => read(`supabase/migrations/${file}`))
    .join('\n');
}

describe('EcoVila Step 9 CRM', () => {
  it('reads the active refund rate from the staff backend and never invents one in the browser', () => {
    const dashboard = read('admin/js/crm-dashboard.js');
    const helpers = read('js/supabase.js');
    const scheduled = read('supabase/functions/scheduled-refunds/index.ts');

    assert.doesNotMatch(dashboard, /REFUND_COMMISSION_RATE\s*=\s*0\.014/);
    assert.match(dashboard, /getActiveRefundCommissionBps\?\.\(\)/);
    assert.match(dashboard, /fetchScheduledRefunds\(context\?\.client\)\.then/);
    assert.match(helpers, /activeCommissionBps/);
    assert.match(helpers, /getActiveRefundCommissionBps/);
    assert.match(scheduled, /activeCommissionBps: activeCommissionBps\(\)/);
  });

  it('renders the scheduled whole-booking refund total, gross basis and retained commission', () => {
    const finance = read('admin/js/crm-finance.js');
    assert.match(finance, /refund\.refundTotal\?\.net/);
    assert.match(finance, /refund\.refundTotal\?\.gross/);
    assert.match(finance, /refund\.refundTotal\?\.withheld/);
    assert.match(finance, /toate autorizările de plată/i);
  });

  it('surfaces unresolved difference authorizations as a pending refund outcome', () => {
    const dashboard = read('admin/js/crm-dashboard.js');
    const maibRefund = read('supabase/functions/maib-refund/index.ts');
    const scheduled = read('supabase/functions/scheduled-refunds/index.ts');

    assert.match(maibRefund, /differenceRefunds\.some\(.*!.*\.ok/s);
    assert.match(scheduled, /differenceRefunds\.some\(.*!.*\.ok/s);
    assert.match(maibRefund, /partial:\s*differencesPending/);
    assert.match(scheduled, /partial:\s*differencesPending/);
    assert.match(dashboard, /refundResult\?\.partial/);
  });

  it('prepares the main and every difference quote in one database transaction', () => {
    const intents = read('supabase/functions/_shared/refundIntents.ts');
    const migrations = allMigrations();
    assert.match(intents, /rpc\('prepare_full_refund_intent'/);
    assert.match(migrations, /create function public\.prepare_full_refund_intent/);
    assert.match(migrations, /for update/);
    assert.match(migrations, /reservation_changes/);
  });

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

  it('keeps the admin CRM out of search indexes with a noindex robots meta', () => {
    for (const page of ['admin/index.html', 'admin/dashboard.html']) {
      assert.match(
        read(page),
        /<meta\s+name="robots"\s+content="noindex[^"]*">/i,
        `${page} must carry a noindex robots meta so the CRM never appears in search results`,
      );
    }
  });

  it('adds the owner finance tab with reporting controls and metric hooks', () => {
    const dashboard = read('admin/dashboard.html');
    const app = read('admin/js/crm-app.js');
    const helpers = read('js/supabase.js');
    const finance = read('admin/js/crm-finance.js');

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
      'data-finance-booked-day',
      'data-finance-booked-count',
      'data-finance-booked-list',
      'data-finance-booked-empty',
      'data-finance-cancellations',
      'data-finance-cancelled-count',
      'data-finance-refund-gross',
      'data-finance-withheld-commission',
      'data-finance-refunded-total',
      'data-finance-bank-fees',
      'data-finance-net-cost',
      'data-finance-cancel-count',
      'data-finance-cancel-list',
      'data-finance-cancel-empty',
      'data-finance-scheduled',
      'data-finance-scheduled-list',
      'data-finance-scheduled-empty',
      'data-finance-scheduled-count',
      'js/crm-finance.js',
    ]) {
      assert.match(dashboard, new RegExp(hook), `${hook} should exist`);
    }

    assert.match(app, /EcoVilaCrmFinance\?\.init\?\.\(context\)/);
    assert.match(app, /EcoVilaCrmFinance\?\.showToday\?\.\(\)/);
    assert.match(helpers, /function fetchFinanceReservations/);
    assert.match(helpers, /function fetchFinanceBookedReservations/);
    assert.match(helpers, /function fetchFinanceCancellations/);
    assert.match(helpers, /created_at/);
    // Cancellations are keyed by cancelled_at and exclude never-paid abandoned holds.
    assert.match(helpers, /cancelled_at/);
    // Refund-cooldown CRM controls (ADR-096).
    assert.match(helpers, /function fetchScheduledRefunds/);
    assert.match(helpers, /function controlScheduledRefund/);
    assert.match(helpers, /function fetchRefundedGroups/);
    assert.match(helpers, /'scheduled-refunds'/);
    assert.match(finance, /function renderScheduledRefunds/);
    // Refunded state comes from the real refund record, not cancellation_reason.
    assert.match(finance, /refundedGroupIds/);
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

  it('summarizes cancellation gross, retained commission, net refund, bank fees and net cost', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const summary = finance.summarizeCancellationRows({
      // "refunded" is the real refund record (server truth), NOT cancellation_reason:
      // only these two groups had their money returned.
      refundedGroupIds: new Set(['grp-card', 'grp-mia']),
      rows: [
        {
          id: 'card-refunded',
          booking_group_id: 'grp-card',
          check_in: '2026-07-20',
          check_out: '2026-07-22',
          total_price: 5000,
          payment_type: 'card',
          payment_status: 'cancelled',
          paid_at: '2026-07-01T10:00:00.000Z',
          cancelled_at: '2026-07-08T09:00:00.000Z',
          cancellation_reason: 'guest_request_refunded',
          rooms: { number: 3, type: 'small' },
        },
        {
          id: 'mia-refunded',
          booking_group_id: 'grp-mia',
          check_in: '2026-07-25',
          check_out: '2026-07-26',
          total_price: 2500,
          payment_type: 'mia',
          payment_status: 'cancelled',
          paid_at: '2026-07-02T10:00:00.000Z',
          cancelled_at: '2026-07-08T11:00:00.000Z',
          cancellation_reason: 'guest_request_refunded',
          rooms: { number: 4, type: 'small' },
        },
        {
          id: 'card-kept',
          booking_group_id: 'grp-kept',
          check_in: '2026-07-10',
          check_out: '2026-07-11',
          total_price: 3000,
          payment_type: 'card',
          payment_status: 'cancelled',
          paid_at: '2026-07-03T10:00:00.000Z',
          cancelled_at: '2026-07-08T12:00:00.000Z',
          cancellation_reason: 'guest_request',
          rooms: { number: 5, type: 'large' },
        },
        {
          id: 'cash-cancelled',
          booking_group_id: 'grp-cash',
          check_in: '2026-07-14',
          check_out: '2026-07-15',
          total_price: 1000,
          payment_type: 'cash',
          payment_status: 'cancelled',
          paid_at: '2026-07-04T10:00:00.000Z',
          cancelled_at: '2026-07-08T13:00:00.000Z',
          cancellation_reason: 'guest_request',
          rooms: { number: 6, type: 'small' },
        },
        {
          id: 'office-cancelled',
          booking_group_id: 'grp-office',
          check_in: '2026-07-16',
          check_out: '2026-07-17',
          total_price: 2000,
          payment_type: 'office',
          payment_status: 'cancelled',
          paid_at: '2026-07-05T10:00:00.000Z',
          cancelled_at: '2026-07-08T14:00:00.000Z',
          cancellation_reason: 'guest_request',
          rooms: { number: 7, type: 'hotel' },
        },
        {
          id: 'abandoned-hold',
          booking_group_id: 'grp-hold',
          check_in: '2026-07-18',
          check_out: '2026-07-19',
          total_price: 4000,
          payment_type: 'mia',
          payment_status: 'cancelled',
          paid_at: null,
          cancelled_at: '2026-07-08T15:00:00.000Z',
          cancellation_reason: 'maib_session_expired',
          rooms: { number: 8, type: 'small' },
        },
      ],
    });

    // The whole cancellations view is refunded-only (owner request, ADR-095
    // corrected): of the five paid cancellations only the two with a real
    // refund record count — kept-money, cash and office cancellations are out,
    // and never-paid abandoned holds were never in.
    assert.equal(summary.count, 2);
    // Legacy Set callers have no retained-commission quote, so gross and net match.
    assert.equal(summary.grossTotal, 7500);
    assert.equal(summary.withheldCommission, 0);
    assert.equal(summary.refundedTotal, 7500);
    // 0.7% inbound on 7500 = 52.5, plus a flat 20 MDL payout fee on each of the two
    // sub-10k refunds (5000 + 2500) = 40 -> round(92.5) = 93.
    assert.equal(summary.bankFees, 93);
    assert.equal(summary.netCost, 93);
  });

  it('groups a multi-villa cancellation once and sums the whole-booking refund', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const rawRows = [
      {
        id: 'villa-2',
        booking_group_id: 'grp-multi',
        check_in: '2026-07-28',
        check_out: '2026-07-30',
        adults: 4,
        kids_ages: [],
        total_price: 4000,
        payment_type: 'card',
        payment_status: 'cancelled',
        paid_at: '2026-07-01T10:00:00.000Z',
        cancelled_at: '2026-07-08T09:00:00.000Z',
        cancellation_reason: 'guest_request_refunded',
        guest_first_name: 'Ion',
        guest_last_name: 'Popescu',
        rooms: { number: 2, type: 'small' },
      },
      {
        id: 'villa-1',
        booking_group_id: 'grp-multi',
        check_in: '2026-07-28',
        check_out: '2026-07-30',
        adults: 4,
        kids_ages: [],
        total_price: 4000,
        payment_type: 'card',
        payment_status: 'cancelled',
        paid_at: '2026-07-01T10:00:00.000Z',
        cancelled_at: '2026-07-08T09:00:00.000Z',
        cancellation_reason: 'guest_request_refunded',
        guest_first_name: 'Ion',
        guest_last_name: 'Popescu',
        rooms: { number: 1, type: 'small' },
      },
    ];

    const refundedGroupIds = new Set(['grp-multi']);
    const groups = finance.groupCancellationRows(
      finance.normalizeCancellationRows(rawRows),
      refundedGroupIds,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].villas.length, 2);
    assert.equal(groups[0].totalPrice, 8000);
    assert.equal(groups[0].refunded, true);
    assert.equal(groups[0].guestName, 'Ion Popescu');

    const summary = finance.summarizeCancellationRows({ rows: rawRows, refundedGroupIds });
    assert.equal(summary.count, 1);
    assert.equal(summary.refundedTotal, 8000);
    // 0.7% inbound on the 8000 group + a flat 20 MDL payout fee (sub-10k) = 56 + 20.
    assert.equal(summary.bankFees, 76);
    assert.equal(summary.netCost, 76);
  });

  it('applies the tiered flat refund payout fee: 20 MDL under 10k, 40 MDL at/over 10k', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const refundedRow = (id, total) => ({
      id,
      booking_group_id: id,
      check_in: '2026-07-20',
      check_out: '2026-07-22',
      total_price: total,
      payment_type: 'mia',
      payment_status: 'cancelled',
      paid_at: '2026-07-01T10:00:00.000Z',
      cancelled_at: '2026-07-08T09:00:00.000Z',
      cancellation_reason: 'guest_request_refunded',
      rooms: { number: 1, type: 'small' },
    });

    // The owner's real case: a 12,200 refund carried a flat 40 MDL payout fee.
    const big = finance.summarizeCancellationRows({
      rows: [refundedRow('big', 12200)],
      refundedGroupIds: new Set(['big']),
    });
    assert.equal(big.bankFees, 125); // round(0.007 * 12200 + 40)
    assert.equal(big.netCost, 125);

    // Exactly at the 10k threshold still takes the 40 MDL tier.
    const edge = finance.summarizeCancellationRows({
      rows: [refundedRow('edge', 10000)],
      refundedGroupIds: new Set(['edge']),
    });
    assert.equal(edge.bankFees, 110); // round(0.007 * 10000 + 40)

    // Under 10k takes the 20 MDL tier.
    const small = finance.summarizeCancellationRows({
      rows: [refundedRow('small', 3000)],
      refundedGroupIds: new Set(['small']),
    });
    assert.equal(small.bankFees, 41); // round(0.007 * 3000 + 20)
  });

  it('subtracts retained commission from bank fees and preserves a negative net cost', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const dashboard = read('admin/dashboard.html');
    const summary = finance.summarizeCancellationRows({
      rows: [{
        id: 'negative-cost',
        booking_group_id: 'negative-cost',
        check_in: '2026-07-20',
        check_out: '2026-07-22',
        total_price: 12200,
        payment_type: 'card',
        payment_status: 'cancelled',
        paid_at: '2026-07-01T10:00:00.000Z',
        cancelled_at: '2026-07-08T09:00:00.000Z',
        cancellation_reason: 'guest_request_refunded',
        rooms: { number: 1, type: 'small' },
      }],
      refundedGroupIds: new Map([['negative-cost', {
        amount: 12030,
        grossAmount: 12200,
        withheldCommission: 170,
      }]]),
    });

    assert.equal(summary.grossTotal, 12200);
    assert.equal(summary.withheldCommission, 170);
    assert.equal(summary.refundedTotal, 12030);
    assert.equal(summary.bankFees, 125);
    assert.equal(summary.netCost, -45);
    assert.match(dashboard, /Cost net EcoVila \(\+ cost \/ − recuperare\)/);
  });

  it('adds refunded add-guests transfers to the refunded total, each with its own payout fee', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const rows = [
      {
        id: 'with-change',
        booking_group_id: 'grp-change',
        check_in: '2026-07-20',
        check_out: '2026-07-22',
        total_price: 9000,
        payment_type: 'card',
        payment_status: 'cancelled',
        paid_at: '2026-07-01T10:00:00.000Z',
        cancelled_at: '2026-07-08T09:00:00.000Z',
        cancellation_reason: 'guest_request_refunded',
        rooms: { number: 3, type: 'small' },
      },
    ];
    const refundedGroupIds = new Set(['grp-change']);
    // A paid "add guests" difference is refunded as its OWN MAIB transfer —
    // reservations.total_price never includes it (the apply step only updates
    // the party fields), so the summary must add it on top (ADR-099).
    const refundedChangesByGroup = new Map([['grp-change', [1500]]]);

    const groups = finance.groupCancellationRows(
      finance.normalizeCancellationRows(rows),
      refundedGroupIds,
      refundedChangesByGroup,
    );
    assert.equal(groups[0].refundedAmount, 10500);

    const summary = finance.summarizeCancellationRows({
      rows,
      refundedGroupIds,
      refundedChangesByGroup,
    });
    // 9000 stay + 1500 refunded difference actually went back to the guest.
    assert.equal(summary.refundedTotal, 10500);
    // 0.7% inbound on 10500 = 73.5, plus a flat 20 MDL payout fee on EACH
    // sub-10k transfer (9000 main + 1500 difference) -> round(113.5) = 114.
    assert.equal(summary.bankFees, 114);
    assert.equal(summary.netCost, 114);

    // Without a real refund record the change amounts contribute nothing.
    const kept = finance.summarizeCancellationRows({
      rows,
      refundedGroupIds: new Set(),
      refundedChangesByGroup,
    });
    assert.equal(kept.count, 0);
    assert.equal(kept.refundedTotal, 0);
    assert.equal(kept.bankFees, 0);
    assert.equal(kept.netCost, 0);
  });

  it('marks refunded by the real refund record, not cancellation_reason', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const row = (id, reason) => ({
      id,
      booking_group_id: id,
      check_in: '2026-08-16',
      check_out: '2026-08-17',
      total_price: 3000,
      payment_type: 'card',
      payment_status: 'cancelled',
      paid_at: '2026-07-01T10:00:00.000Z',
      cancelled_at: '2026-07-05T17:14:00.000Z',
      cancellation_reason: reason,
      rooms: { number: 6, type: 'small' },
    });

    // A CRM-cancelled booking (reason 'Anulat din CRM') that WAS refunded now shows
    // as refunded — the bug where these read "fără rambursare".
    const crm = finance.groupCancellationRows(
      finance.normalizeCancellationRows([row('crm', 'Anulat din CRM')]),
      new Set(['crm']),
    );
    assert.equal(crm[0].refunded, true);

    // Conversely, a 'guest_request_refunded' reason with NO real refund is NOT refunded.
    const reasonOnly = finance.groupCancellationRows(
      finance.normalizeCancellationRows([row('reason-only', 'guest_request_refunded')]),
      new Set(),
    );
    assert.equal(reasonOnly[0].refunded, false);

    // Only the group with a real refund feeds the refunded total.
    const summary = finance.summarizeCancellationRows({
      rows: [row('crm', 'Anulat din CRM'), row('reason-only', 'guest_request_refunded')],
      refundedGroupIds: new Set(['crm']),
    });
    assert.equal(summary.refundedTotal, 3000);
  });

  it('normalizes one-day finance booked rows without cancelled reservations', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const rows = finance.normalizeBookedDayRows([
      {
        id: 'cancelled-created-day',
        room_id: 'room-2',
        check_in: '2026-06-28',
        check_out: '2026-06-29',
        adults: 2,
        kids_ages: [],
        total_price: 3200,
        payment_type: 'cash',
        payment_status: 'cancelled',
        cancelled_at: '2026-06-06T12:00:00.000Z',
        created_at: '2026-06-06T09:00:00.000Z',
        rooms: { number: 2, type: 'small' },
      },
      {
        id: 'villa-1-created-day',
        room_id: 'room-1',
        check_in: '2026-06-28',
        check_out: '2026-06-29',
        adults: 2,
        kids_ages: [],
        total_price: 3500,
        payment_type: 'cash',
        payment_status: 'pending',
        cancelled_at: null,
        created_at: '2026-06-06T10:45:00.000Z',
        rooms: { number: 1, type: 'small' },
      },
      {
        id: 'villa-9-created-day',
        room_id: 'room-9',
        check_in: '2026-06-29',
        check_out: '2026-07-01',
        adults: 3,
        kids_ages: [5],
        total_price: 7400,
        payment_type: 'card',
        payment_status: 'paid',
        cancelled_at: null,
        created_at: '2026-06-06T08:30:00.000Z',
        rooms: { number: 9, type: 'large' },
      },
    ]);

    assert.deepEqual(rows.map((row) => row.id), ['villa-9-created-day', 'villa-1-created-day']);
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), {
      id: 'villa-9-created-day',
      bookingGroupId: 'villa-9-created-day',
      roomNumber: 9,
      roomType: 'large',
      checkIn: '2026-06-29',
      checkOut: '2026-07-01',
      nights: 2,
      adults: 3,
      kids: 1,
      totalPrice: 7400,
      paymentType: 'card',
      paymentStatus: 'paid',
      createdAt: '2026-06-06T08:30:00.000Z',
    });
    assert.equal(rows[1].roomNumber, 1);
    assert.equal(rows[1].nights, 1);
    assert.equal(rows[1].adults, 2);
    assert.equal(rows[1].kids, 0);
    assert.equal(rows[1].totalPrice, 3500);
    assert.equal(rows[1].paymentStatus, 'pending');
  });

  it('keeps paid-then-cancelled booked rows but drops never-paid cancellations', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const rows = finance.normalizeBookedDayRows([
      {
        id: 'paid-then-refunded',
        booking_group_id: 'g1',
        check_in: '2026-06-28',
        check_out: '2026-06-29',
        adults: 2,
        kids_ages: [],
        total_price: 38,
        payment_type: 'mia',
        payment_status: 'cancelled',
        cancelled_at: '2026-06-17T00:55:00.000Z',
        paid_at: '2026-06-17T00:54:00.000Z',
        created_at: '2026-06-17T00:53:00.000Z',
        rooms: { number: 3, type: 'small' },
      },
      {
        id: 'never-paid-expired',
        booking_group_id: 'g2',
        check_in: '2026-06-28',
        check_out: '2026-06-29',
        adults: 2,
        kids_ages: [],
        total_price: 3600,
        payment_type: 'card',
        payment_status: 'cancelled',
        cancelled_at: '2026-06-17T00:51:00.000Z',
        paid_at: null,
        created_at: '2026-06-17T00:45:00.000Z',
        rooms: { number: 4, type: 'small' },
      },
    ]);

    assert.deepEqual(rows.map((row) => row.id), ['paid-then-refunded']);
    assert.equal(rows[0].paymentStatus, 'cancelled');
  });

  it('labels cancelled booked rows as anulată and reads the booked day in Moldova time', () => {
    const finance = read('admin/js/crm-finance.js');
    const helpers = read('js/supabase.js');

    assert.match(
      finance,
      /paymentStatus === 'cancelled'[\s\S]*?return 'anulată'/,
      'cancelled booked rows should render as anulată, not online plătit',
    );
    assert.match(
      helpers,
      /Europe\/Chisinau/,
      'the booked-day window should use the Moldova calendar day, not UTC midnight',
    );
    assert.match(
      helpers,
      /paid_at\.not\.is\.null/,
      'paid-then-cancelled bookings should still be fetched for the booked-day list',
    );
  });

  it('groups one-day finance booked rows by booking with a shared total', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const rows = finance.normalizeBookedDayRows([
      {
        id: 'group-villa-8',
        booking_group_id: 'multi-room',
        room_id: 'room-8',
        check_in: '2026-08-16',
        check_out: '2026-08-18',
        adults: 6,
        kids_ages: [4],
        total_price: 5433,
        payment_type: 'office',
        payment_status: 'paid',
        cancelled_at: null,
        created_at: '2026-06-16T16:55:00.000Z',
        rooms: { number: 8, type: 'small' },
      },
      {
        id: 'group-villa-7',
        booking_group_id: 'multi-room',
        room_id: 'room-7',
        check_in: '2026-08-16',
        check_out: '2026-08-18',
        adults: 6,
        kids_ages: [4],
        total_price: 5434,
        payment_type: 'office',
        payment_status: 'paid',
        cancelled_at: null,
        created_at: '2026-06-16T16:55:00.000Z',
        rooms: { number: 7, type: 'small' },
      },
      {
        id: 'solo-villa-5',
        booking_group_id: 'single-booking',
        room_id: 'room-5',
        check_in: '2026-08-10',
        check_out: '2026-08-11',
        adults: 2,
        kids_ages: [],
        total_price: 3000,
        payment_type: 'office',
        payment_status: 'paid',
        cancelled_at: null,
        created_at: '2026-06-16T11:06:00.000Z',
        rooms: { number: 5, type: 'small' },
      },
    ]);

    const groups = finance.groupBookedDayRows(rows);
    assert.equal(groups.length, 2, 'two reservations should remain after grouping the multi-room booking');

    const single = groups[0];
    assert.equal(single.key, 'single-booking');
    assert.equal(single.villas.length, 1);
    assert.equal(single.totalPrice, 3000);

    const multi = groups[1];
    assert.equal(multi.key, 'multi-room');
    assert.deepEqual([...multi.villas].map((villa) => villa.roomNumber), [7, 8]);
    // total_price is split per villa, so the booking total is summed.
    assert.equal(multi.totalPrice, 5433 + 5434);
    // adults/kids are the whole-booking party, taken once (not summed across villas).
    assert.equal(multi.adults, 6);
    assert.equal(multi.kids, 1);
    assert.equal(multi.nights, 2);
  });

  it('applies a single clicked day from the finance range calendar', async () => {
    const calls = [];
    const { document, elements } = createFinanceDocument();
    const client = {
      channel() {
        return {
          on() {
            return this;
          },
          subscribe() {
            return this;
          },
        };
      },
    };
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      document,
      EcoVilaCrmCalendar: {
        todayISO: () => '2026-06-08',
      },
      EcoVilaSupabase: {
        async fetchFinanceReservations(_client, options) {
          calls.push({ type: 'finance', ...options });
          return [];
        },
        async fetchFinanceBookedReservations(_client, options) {
          calls.push({ type: 'booked', ...options });
          return [];
        },
        async fetchFinanceChangePayments(_client, options) {
          calls.push({ type: 'changes', ...options });
          return [];
        },
        async fetchFinanceCancellations(_client, options) {
          calls.push({ type: 'cancellations', ...options });
          return [];
        },
        async fetchScheduledRefunds() {
          calls.push({ type: 'scheduled' });
          return [];
        },
      },
    });

    finance.init({
      client,
      formatDate: (value) => value,
      formatMDL: (value) => `${value} MDL`,
      setAlert() {},
    });
    await Promise.resolve();

    elements.get('[data-finance-mode="paid"]').click();
    await Promise.resolve();
    elements.get('[data-finance-range-label]').click();
    const dateButton = elements
      .get('[data-finance-calendar-grid]')
      .children.find((button) => button.dataset.date === '2026-06-06');
    assert.ok(dateButton, 'June 6 should be rendered in the finance calendar');

    dateButton.click();
    elements.get('[data-finance-calendar-apply]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(
      calls.some((call) => {
        return call.type === 'finance' && call.rangeStart === '2026-06-06' && call.rangeEnd === '2026-06-07';
      }),
      'single-day Apply should reload finance data for the selected day',
    );
    assert.ok(
      calls.some((call) => {
        return call.type === 'booked' && call.rangeStart === '2026-06-06' && call.rangeEnd === '2026-06-07';
      }),
      'single-day Apply in incasari mode should load reservations booked during that day',
    );
    assert.ok(
      calls.some((call) => {
        return call.type === 'cancellations' && call.rangeStart === '2026-06-06' && call.rangeEnd === '2026-06-07';
      }),
      'single-day Apply should load cancellations made during the selected day',
    );
    assert.ok(
      calls.some((call) => call.type === 'scheduled'),
      'finance load should also refresh the pending scheduled refunds list',
    );
  });

  it('defaults the finance tab to today as a single-day range on load', async () => {
    const calls = [];
    const { document } = createFinanceDocument();
    const client = {
      channel() {
        return {
          on() {
            return this;
          },
          subscribe() {
            return this;
          },
        };
      },
    };
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      document,
      EcoVilaCrmCalendar: {
        todayISO: () => '2026-06-16',
      },
      EcoVilaSupabase: {
        async fetchFinanceReservations(_client, options) {
          calls.push(options);
          return [];
        },
        async fetchFinanceBookedReservations() {
          return [];
        },
        async fetchFinanceCancellations() {
          return [];
        },
      },
    });

    finance.init({
      client,
      formatDate: (value) => value,
      formatMDL: (value) => `${value} MDL`,
      setAlert() {},
    });
    await Promise.resolve();

    assert.ok(calls.length >= 1, 'finance init should load data immediately');
    assert.equal(calls[0].rangeStart, '2026-06-16', 'default range should start today');
    assert.equal(calls[0].rangeEnd, '2026-06-17', 'default range should be a single day');
    assert.equal(calls[0].mode, 'paid', 'default mode should be Încasări so the booked-day list shows');
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

  it('uses localStorage-backed Supabase auth storage and migrates legacy cookie sessions', async () => {
    const calls = [];
    const cookieWrites = [];
    // A legacy pre-ADR-091 cookie session: it must migrate to localStorage and
    // be deleted, never written back — cookies rode the Cookie header to the
    // static host's access logs on every /admin request.
    let cookieJar = 'ecovila_crm_auth_sb-legacy-token=%7B%22access_token%22%3A%22old%22%7D';
    const localStore = new Map();
    const session = {
      user: {
        app_metadata: { role: 'diana' },
      },
    };
    const documentRef = {
      querySelector() {
        return null;
      },
      get cookie() {
        return cookieJar;
      },
      set cookie(value) {
        cookieWrites.push(value);
        const [pair] = String(value).split(';');
        const [name] = pair.split('=');
        if (String(value).includes('Max-Age=0')) {
          cookieJar = cookieJar
            .split('; ')
            .filter((cookie) => !cookie.startsWith(`${name}=`))
            .join('; ');
        }
      },
    };
    const localStorageRef = {
      getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
      setItem: (key, value) => localStore.set(key, String(value)),
      removeItem: (key) => localStore.delete(key),
      key: (index) => [...localStore.keys()][index] ?? null,
      get length() {
        return localStore.size;
      },
    };
    const client = {
      auth: {
        getSession: async () => ({ data: { session }, error: null }),
        signOut: async () => {},
      },
    };
    const { EcoVilaCrmAuth: auth } = loadAdminModule('admin/js/crm-auth.js', {
      document: documentRef,
      localStorage: localStorageRef,
      location: { href: '' },
      EcoVilaSupabase: {
        getSupabaseClient(options) {
          calls.push(options);
          return client;
        },
      },
    });

    const result = await auth.requireSession();
    const storage = calls[0].authStorage;

    assert.equal(result.role, 'diana');
    assert.equal(calls.length, 1);

    // New sessions live in localStorage only — no cookie write may carry them.
    storage.setItem('sb-admin-auth-token', '{"access_token":"access","refresh_token":"refresh"}');
    assert.equal(storage.getItem('sb-admin-auth-token'), '{"access_token":"access","refresh_token":"refresh"}');
    assert.equal(localStore.get('ecovila_crm_auth_sb-admin-auth-token'), '{"access_token":"access","refresh_token":"refresh"}');
    assert.ok(
      cookieWrites.every((write) => !write.includes('access_token') || write.includes('Max-Age=0')),
      'session tokens must never be written into cookies',
    );

    // The legacy cookie migrates on first read and is deleted afterwards.
    assert.equal(storage.getItem('sb-legacy-token'), '{"access_token":"old"}');
    assert.equal(localStore.get('ecovila_crm_auth_sb-legacy-token'), '{"access_token":"old"}');
    assert.ok(cookieWrites.some((write) => write.startsWith('ecovila_crm_auth_sb-legacy-token=') && write.includes('Max-Age=0')));
    assert.ok(!cookieJar.includes('sb-legacy-token'), 'legacy cookie should be gone');

    storage.removeItem('sb-admin-auth-token');
    assert.equal(storage.getItem('sb-admin-auth-token'), null);
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
    ]) {
      assert.match(`${dashboard}\n${dashboardJs}\n${sidebarJs}`, new RegExp(label, 'i'));
    }

    assert.doesNotMatch(dashboard, /data-delete-confirm/);
    assert.doesNotMatch(dashboard, /tastează\s+sterge/i);
    assert.doesNotMatch(dashboardJs, /confirm\s*!==\s*'sterge'/);
    assert.match(dashboardJs, /Sigur vrei să ștergi această rezervare\?/);
    assert.match(dashboardJs, /Ești absolut sigur că vrei să ștergi această rezervare\?/);
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

  it('routes paid MAIB CRM cancellations through the staff refund function before cancelling the group', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const helpers = read('js/supabase.js');

    assert.match(helpers, /function refundMaibPaymentRequest/, 'Supabase helpers should expose the staff refund Edge Function');
    assert.match(helpers, /functions\.invoke\('maib-refund'/, 'CRM refunds should call the maib-refund Edge Function');
    assert.match(
      dashboardJs,
      /payment_type === 'card'[\s\S]*payment_status === 'paid'[\s\S]*refundMaibPaymentRequest/s,
      'paid MAIB reservations cancelled in CRM should be refunded before cancellation',
    );
    assert.match(
      dashboardJs,
      /payment_status:\s*'cancelled'[\s\S]*updateReservationGroup/s,
      'CRM cancellation should cancel the full booking group after any required refund',
    );
    assert.match(
      helpers,
      /function notifyReservationCancellation/,
      'Supabase helpers should expose the staff cancellation-notification Edge Function',
    );
    assert.match(
      helpers,
      /functions\.invoke\('reservation-cancel-notify'/,
      'CRM cancellations should notify the guest via the reservation-cancel-notify Edge Function',
    );
    assert.match(
      dashboardJs,
      /updateReservationGroup[\s\S]*notifyReservationCancellation/s,
      'CRM cancellation should notify the guest after the reservation is cancelled',
    );
  });

  it('shows the booking-group total in the edit dialog for grouped reservations', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');

    assert.match(
      dashboardJs,
      /openReservation\(reservation,\s*\{\s*groupTotal:\s*total\s*\}\)/,
      'the calendar card should pass the aggregated booking-group total to the dialog',
    );
    assert.match(
      dashboardJs,
      /options\.groupTotal[\s\S]*data-edit-total/s,
      'the edit dialog should render the group total when provided',
    );
  });

  it('renders the supplied group total instead of the single reservation price', () => {
    const totalField = createFakeElement('strong');
    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.querySelector = (selector) =>
      ({
        '[data-edit-check-in]': createFakeElement('input'),
        '[data-edit-check-out]': createFakeElement('input'),
        '[data-edit-adults]': createFakeElement('input'),
        '[data-edit-kids-ages]': createFakeElement('input'),
        '[data-edit-name]': createFakeElement('input'),
        '[data-edit-phone]': createFakeElement('input'),
        '[data-edit-notes]': createFakeElement('textarea'),
        '[data-edit-payment]': createFakeElement('p'),
        '[data-edit-total]': totalField,
        '[data-send-payment-confirmation]': createFakeElement('button'),
        '[data-delete-reservation]': createFakeElement('button'),
      })[selector] || null;
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: {
        createElement: createFakeElement,
        querySelector(selector) {
          return selector === '[data-reservation-dialog]' ? dialog : null;
        },
        querySelectorAll() {
          return [];
        },
        addEventListener() {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: { formatMDL: (amount) => `${amount} MDL` },
      EcoVilaCrmCalendar,
    });

    const reservation = {
      id: 'reservation-group-owner',
      booking_group_id: 'group-two-villas',
      check_in: '2026-07-04',
      check_out: '2026-07-07',
      adults: 4,
      kids_ages: [],
      guest_first_name: 'Anatolie',
      guest_last_name: 'Popov',
      guest_phone: '+37362109460',
      payment_type: 'card',
      payment_status: 'paid',
      total_price: 8600,
    };

    EcoVilaCrmDashboard.openReservation(reservation, { groupTotal: 17200 });
    assert.equal(totalField.textContent, 'Preț total: 17200 MDL');

    EcoVilaCrmDashboard.openReservation(reservation);
    assert.equal(totalField.textContent, 'Preț total: 8600 MDL');
  });

  it('passes the full-refund override and warns when a paid MAIB refund stays pending', async () => {
    const elements = new Map();
    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.close = () => {};
    const fields = {
      '[data-edit-check-in]': createFakeElement('input'),
      '[data-edit-check-out]': createFakeElement('input'),
      '[data-edit-adults]': createFakeElement('input'),
      '[data-edit-kids-ages]': createFakeElement('input'),
      '[data-edit-name]': createFakeElement('input'),
      '[data-edit-phone]': createFakeElement('input'),
      '[data-edit-notes]': createFakeElement('textarea'),
      '[data-edit-payment]': createFakeElement('p'),
      '[data-edit-total]': createFakeElement('strong'),
      '[data-send-payment-confirmation]': createFakeElement('button'),
      '[data-delete-reservation]': createFakeElement('button'),
      '[data-refund-full-override]': createFakeElement('input'),
    };
    dialog.querySelector = (selector) => fields[selector] || null;
    elements.set('[data-reservation-dialog]', dialog);
    let confirmCalls = [];
    const operations = [];
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      confirm(message) {
        confirmCalls.push(message);
        return true;
      },
      document: {
        createElement: createFakeElement,
        querySelector(selector) {
          return elements.get(selector) || null;
        },
        querySelectorAll() {
          return [];
        },
        addEventListener() {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: { formatMDL: (amount) => `${amount} MDL` },
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        async refundMaibPaymentRequest(_client, payload) {
          operations.push(['refund', payload]);
          return {
            ok: false,
            pending: true,
            message: 'Restituirea nu s-a confirmat încă — verifică soldul MAIB.',
          };
        },
        async updateReservationGroup(_client, groupId, payload) {
          operations.push(['cancel-group', groupId, payload.payment_status]);
          return {};
        },
        async updateReservation() {
          operations.push(['cancel-single']);
          return {};
        },
        async notifyReservationCancellation(_client, payload) {
          operations.push(['notify', payload]);
          return { ok: true };
        },
      },
    });
    let alert = '';
    const context = { client: {}, setAlert(message) { alert = message; } };
    EcoVilaCrmDashboard.initStateForTests({
      context,
      reload: async () => {
        operations.push(['reload']);
      },
    });

    EcoVilaCrmDashboard.openReservation({
      id: 'reservation-paid-card',
      booking_group_id: 'group-paid-card',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      adults: 2,
      kids_ages: [],
      guest_first_name: 'Ana',
      guest_last_name: 'Lungu',
      guest_phone: '+37368983660',
      notes: '',
      payment_type: 'card',
      payment_status: 'paid',
      total_price: 4200,
    });
    assert.equal(fields['[data-refund-full-override]'].checked, false, 'override defaults to withhold');
    fields['[data-refund-full-override]'].checked = true;

    await fields['[data-delete-reservation]'].onclick();

    assert.deepEqual(confirmCalls, [
      'Sigur vrei să ștergi această rezervare?',
      'Ești absolut sigur că vrei să ștergi această rezervare?',
    ]);
    // Cancel FIRST, refund SECOND (ADR-088): refunding before a cancel that
    // then fails would return the money while the booking stays active. A
    // refund that fails after the cancel is queued server-side and retried by
    // the reconcile-refunds cron.
    assert.deepEqual(operations.map((item) => item[0]), ['cancel-group', 'refund', 'notify', 'reload']);
    const refund = operations.find((item) => item[0] === 'refund');
    assert.equal(refund[1].bookingGroupId, 'group-paid-card');
    assert.equal(refund[1].reason, 'crm_cancellation');
    assert.equal(refund[1].withholdCommission, false);
    assert.equal(alert, 'Restituirea nu s-a confirmat încă — verifică soldul MAIB.');
    const notify = operations.find((item) => item[0] === 'notify');
    assert.equal(notify[1].bookingGroupId, 'group-paid-card');
    assert.equal(notify[1].reservationId, 'reservation-paid-card');
  });

  it('stops CRM deletion when the second confirmation is declined', async () => {
    const deleteButton = createFakeElement('button');
    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.querySelector = (selector) => ({
      '[data-edit-check-in]': createFakeElement('input'),
      '[data-edit-check-out]': createFakeElement('input'),
      '[data-edit-adults]': createFakeElement('input'),
      '[data-edit-kids-ages]': createFakeElement('input'),
      '[data-edit-name]': createFakeElement('input'),
      '[data-edit-phone]': createFakeElement('input'),
      '[data-edit-notes]': createFakeElement('textarea'),
      '[data-edit-payment]': createFakeElement('p'),
      '[data-edit-total]': createFakeElement('strong'),
      '[data-send-payment-confirmation]': createFakeElement('button'),
      '[data-delete-reservation]': deleteButton,
    })[selector] || null;
    const calls = [];
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      confirm(message) {
        calls.push(message);
        return calls.length === 1;
      },
      document: {
        createElement: createFakeElement,
        querySelector(selector) {
          return selector === '[data-reservation-dialog]' ? dialog : null;
        },
        querySelectorAll() {
          return [];
        },
        addEventListener() {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: { formatMDL: (amount) => `${amount} MDL` },
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        async refundMaibPaymentRequest() {
          throw new Error('refund should not run');
        },
        async updateReservationGroup() {
          throw new Error('cancel should not run');
        },
        async updateReservation() {
          throw new Error('cancel should not run');
        },
      },
    });
    EcoVilaCrmDashboard.initStateForTests({ context: { client: {}, setAlert() {} }, reload: async () => {} });

    EcoVilaCrmDashboard.openReservation({
      id: 'reservation-declined',
      booking_group_id: 'group-declined',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      adults: 2,
      kids_ages: [],
      guest_first_name: 'Ana',
      guest_last_name: 'Lungu',
      guest_phone: '+37368983660',
      notes: '',
      payment_type: 'card',
      payment_status: 'paid',
      total_price: 4200,
    });

    await deleteButton.onclick();

    assert.equal(calls.length, 2);
  });

  it('renders the staff add form with age buckets, a range calendar, and no payment selector', () => {
    const dashboard = read('admin/dashboard.html');

    assert.match(dashboard, /data-add-child-buckets/);
    assert.match(dashboard, /data-add-date-picker/);
    assert.match(dashboard, /data-add-calendar-grid/);
    assert.match(dashboard, /data-add-calendar-apply/);
    // The add-reservation phone is pre-filled with the "+373" prefix (ADR-080) so staff
    // type only the local digits; a bare "+373" still fails validation (see test below).
    assert.match(dashboard, /<input type="tel" value="\+373" placeholder="\+373" data-add-phone required>/);
    // The search phone stays placeholder-only (not pre-filled) so an untouched search reads as empty.
    assert.doesNotMatch(dashboard, /<input type="tel" value="\+373" data-search-phone/);
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

  it('colours scattered multi-block bookings so non-adjacent villas read as one reservation', () => {
    const { EcoVilaCrmCalendar: calendar } = loadAdminModule('admin/js/crm-calendar.js');
    const { EcoVilaCrmDashboard: dashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      EcoVilaCrmCalendar: calendar,
    });
    const rooms = Array.from({ length: 8 }, (_, index) => ({
      id: `room-${index + 1}`,
      number: index + 1,
      type: 'small',
    }));
    // One booking on non-adjacent villas 3, 6, 8 -> three separate blocks.
    const scattered = [3, 6, 8].map((number) => ({
      id: `scatter-${number}`,
      booking_group_id: 'group-scatter',
      room_id: `room-${number}`,
      rooms: { id: `room-${number}`, number, type: 'small' },
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      payment_type: 'card',
      payment_status: 'paid',
    }));
    // A plain single-villa booking that shares the same days.
    const solo = {
      id: 'solo-1',
      booking_group_id: 'group-solo',
      room_id: 'room-1',
      rooms: { id: 'room-1', number: 1, type: 'small' },
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      payment_type: 'card',
      payment_status: 'paid',
    };
    const blocks = calendar.buildReservationBlocks(
      [...scattered, solo],
      rooms,
      calendar.enumerateDates('2026-06-01', 30),
    );
    assert.equal(blocks.filter((block) => block.bookingGroupId === 'group-scatter').length, 3);

    const colors = dashboard.assignGroupColors(blocks);
    assert.equal(Number.isInteger(colors.get('group-scatter')), true, 'scattered booking gets an accent colour');
    assert.equal(colors.has('group-solo'), false, 'a single-block booking keeps its status colour');
  });

  it('keeps overlapping groups on distinct colours but reuses colours across non-overlapping days', () => {
    const { EcoVilaCrmDashboard: dashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      EcoVilaCrmCalendar: {},
    });
    const block = (groupId, checkIn, checkOut) => ({
      bookingGroupId: groupId,
      primary: { check_in: checkIn, check_out: checkOut },
    });
    // A, B, C overlap the same days; D is a week later (no overlap).
    const colors = dashboard.assignGroupColors([
      block('A', '2026-06-10', '2026-06-12'),
      block('A', '2026-06-10', '2026-06-12'),
      block('B', '2026-06-11', '2026-06-13'),
      block('B', '2026-06-11', '2026-06-13'),
      block('C', '2026-06-10', '2026-06-14'),
      block('C', '2026-06-10', '2026-06-14'),
      block('D', '2026-06-20', '2026-06-22'),
      block('D', '2026-06-20', '2026-06-22'),
    ]);

    const a = colors.get('A');
    const b = colors.get('B');
    const c = colors.get('C');
    const d = colors.get('D');
    assert.notEqual(a, b, 'overlapping groups must differ');
    assert.notEqual(a, c, 'overlapping groups must differ');
    assert.notEqual(b, c, 'overlapping groups must differ');
    assert.equal(d, a, 'a non-overlapping group reuses the first colour');
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

    assert.deepEqual(Array.from(sidebar.bucketValuesToAges(['0-2', '3-11', '12+'])), [2, 3, 12]);
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
        kidsAges: [2, 4, 12],
        checkIn: '2026-05-18',
        checkOut: '2026-05-19',
        pricingTiers,
        holidays: [],
        createdOn: '2026-05-17',
      }).total,
      6600,
      'mixed-room pricing should apply the combined 6-adult room floor once to the one guest group',
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
        '[data-add-full-name]': field('Alina Auzeac'),
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

  it('does not substitute a fake phone when the CRM add form phone is empty', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const rows = sidebar.buildStaffReservationRows(
      formWithFields({
        '[data-add-room-numbers]': field('1'),
        '[data-add-full-name]': field('Ana Munteanu'),
        '[data-add-phone]': field(''),
        '[data-add-email]': field('ana@example.md'),
        '[data-add-check-in]': field('2026-06-01'),
        '[data-add-check-out]': field('2026-06-02'),
        '[data-add-adults]': field('2'),
        '[data-add-child-bucket]:checked': [],
        '[data-add-total]': field('', { dataset: { total: '1900' } }),
        '[data-add-conference]': field('', { checked: false }),
        '[data-add-notes]': field(''),
      }),
      [{ id: 'room-1', number: 1 }],
      { role: 'diana' },
      {
        createGroupId: () => 'staff-group',
        now: new Date('2026-05-08T09:00:00.000Z'),
      },
    );

    assert.equal(rows[0].guest_phone, '');
    assert.notEqual(rows[0].guest_phone, '+37300000000');
  });

  it('stores null instead of a stand-in email when the CRM add form email is empty', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const rows = sidebar.buildStaffReservationRows(
      formWithFields({
        '[data-add-room-numbers]': field('1'),
        '[data-add-full-name]': field('Ana Munteanu'),
        '[data-add-phone]': field('+37369857607'),
        '[data-add-email]': field('  '),
        '[data-add-check-in]': field('2026-06-01'),
        '[data-add-check-out]': field('2026-06-02'),
        '[data-add-adults]': field('2'),
        '[data-add-child-bucket]:checked': [],
        '[data-add-total]': field('', { dataset: { total: '1900' } }),
        '[data-add-conference]': field('', { checked: false }),
        '[data-add-notes]': field(''),
      }),
      [{ id: 'room-1', number: 1 }],
      { role: 'diana' },
      {
        createGroupId: () => 'staff-group',
        now: new Date('2026-05-08T09:00:00.000Z'),
      },
    );

    assert.equal(rows[0].guest_email, null);
    assert.notEqual(rows[0].guest_email, 'rezervari@ecovila.md');
  });

  it('marks the CRM add-reservation email field as optional and never requires it', () => {
    const dashboardHtml = read('admin/dashboard.html');
    const emailField = dashboardHtml.match(/<label class="crm-field">\s*<span>Email[\s\S]*?<\/label>/);

    assert.ok(emailField, 'add-reservation email field should be present');
    assert.match(emailField[0], /opțional/i);
    assert.doesNotMatch(emailField[0], /data-add-email[^>]*\brequired\b/);
  });

  it('blocks CRM add submit when the phone is empty', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const message = sidebar.validateAddForm(
      {
        rooms: [{ id: 'room-1', number: 1 }],
        reservations: [],
      },
      formWithFields({
        '[data-add-room-numbers]': field('1'),
        '[data-add-adults]': field('2'),
        '[data-add-kids]': field('0'),
        '[data-add-check-in]': field('2026-06-01'),
        '[data-add-check-out]': field('2026-06-02'),
        '[data-add-phone]': field(''),
        '[data-add-total]': field('', { dataset: { total: '1900' } }),
      }),
      { childBuckets: [] },
    );

    assert.equal(message, 'Introdu un telefon valid în format internațional.');
  });

  it('blocks CRM add submit when only the pre-filled "+373" prefix is left', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const message = sidebar.validateAddForm(
      {
        rooms: [{ id: 'room-1', number: 1 }],
        reservations: [],
      },
      formWithFields({
        '[data-add-room-numbers]': field('1'),
        '[data-add-adults]': field('2'),
        '[data-add-kids]': field('0'),
        '[data-add-check-in]': field('2026-06-01'),
        '[data-add-check-out]': field('2026-06-02'),
        '[data-add-phone]': field('+373'),
        '[data-add-total]': field('', { dataset: { total: '1900' } }),
      }),
      { childBuckets: [] },
    );

    assert.equal(message, 'Introdu un telefon valid în format internațional.');
  });

  it('blocks CRM add submit without at least one adult and with an invalid email', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const baseFields = {
      '[data-add-room-numbers]': field('1'),
      '[data-add-kids]': field('0'),
      '[data-add-check-in]': field('2026-06-01'),
      '[data-add-check-out]': field('2026-06-02'),
      '[data-add-phone]': field('+37369857607'),
      '[data-add-total]': field('', { dataset: { total: '1900' } }),
    };
    const state = { rooms: [{ id: 'room-1', number: 1 }], reservations: [] };

    assert.equal(
      sidebar.validateAddForm(
        state,
        formWithFields({ ...baseFields, '[data-add-adults]': field('0') }),
        { childBuckets: [] },
      ),
      'Indică cel puțin un adult.',
    );
    assert.equal(
      sidebar.validateAddForm(
        state,
        formWithFields({
          ...baseFields,
          '[data-add-adults]': field('2'),
          '[data-add-email]': field('not-an-email'),
        }),
        { childBuckets: [] },
      ),
      'Introdu un email valid sau lasă câmpul gol.',
    );
  });

  it('normalizes local Moldovan phone formats in CRM staff reservation rows', () => {
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js');
    const rows = sidebar.buildStaffReservationRows(
      formWithFields({
        '[data-add-room-numbers]': field('1'),
        '[data-add-full-name]': field('Ana Munteanu'),
        '[data-add-phone]': field('069 857 607'),
        '[data-add-email]': field('ana@example.md'),
        '[data-add-check-in]': field('2026-06-01'),
        '[data-add-check-out]': field('2026-06-02'),
        '[data-add-adults]': field('2'),
        '[data-add-child-bucket]:checked': [],
        '[data-add-total]': field('', { dataset: { total: '1900' } }),
        '[data-add-conference]': field('', { checked: false }),
        '[data-add-notes]': field(''),
      }),
      [{ id: 'room-1', number: 1 }],
      { role: 'diana' },
      {
        createGroupId: () => 'staff-group',
        now: new Date('2026-05-08T09:00:00.000Z'),
      },
    );

    assert.equal(rows[0].guest_phone, '+37369857607');
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

  it('renders a buffered calendar window so the dashboard can keep scrolling into adjacent months', () => {
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: { querySelector() { return null; } },
      EcoVilaCrmCalendar: loadAdminModule('admin/js/crm-calendar.js').EcoVilaCrmCalendar,
    });

    const dates = EcoVilaCrmDashboard.buildCalendarWindowDates('2026-06-15');

    assert.equal(dates[0], '2026-05-01');
    assert.equal(dates.at(-1), '2026-07-31');
    assert.ok(dates.includes('2026-06-01'));
    assert.ok(dates.includes('2026-07-01'));
  });

  it('derives the calendar month label from horizontal scroll position', () => {
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: { querySelector() { return null; } },
      EcoVilaCrmCalendar,
    });
    const dates = EcoVilaCrmDashboard.buildCalendarWindowDates('2026-06-15');
    const columnWidth = 136;
    const firstJulyIndex = dates.indexOf('2026-07-01');

    const label = EcoVilaCrmDashboard.calendarMonthLabelForScroll({
      dates,
      scrollLeft: firstJulyIndex * columnWidth,
      columnWidth,
    });

    assert.equal(label, 'Iulie 2026');
  });

  it('preserves the dashboard calendar scroll offset when data reloads after deletion', () => {
    const calendarElement = { scrollLeft: 1840, clientWidth: 900, scrollWidth: 5000 };
    const documentRef = {
      querySelector(selector) {
        return selector === '[data-reservation-calendar]' ? calendarElement : null;
      },
    };
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: documentRef,
      requestAnimationFrame(callback) {
        callback();
      },
    });
    const state = {};

    EcoVilaCrmDashboard.captureCalendarScroll(state);
    calendarElement.scrollLeft = 0;
    EcoVilaCrmDashboard.restoreCalendarScroll(state);

    assert.equal(calendarElement.scrollLeft, 1840);
  });

  it('lets staff book unlimited months ahead while loading real availability for the next two years', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const sidebarJs = read('admin/js/crm-sidebar.js');

    // Occupancy is fetched ~2 years out (accurate window), no longer just one year.
    assert.match(dashboardJs, /ADD_RESERVATION_LOOKAHEAD_DAYS\s*=\s*365\s*\*\s*2/);
    assert.doesNotMatch(dashboardJs, /ADD_RESERVATION_LOOKAHEAD_DAYS\s*=\s*365\s*;/);
    // The 1-year wall was this gate: dates past the loaded window were unselectable.
    // It is gone — staff may pick any future date; the DB exclusion constraint is
    // the backstop for the rare far-future clash beyond the loaded window.
    assert.doesNotMatch(sidebarJs, /date\s*>=\s*state\.addAvailabilityEnd/);
  });

  it('defers the scroll-driven month-window extension until scrolling settles', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');

    // The expensive window shift (reload + grid rebuild) is scheduled on a debounce
    // timer instead of firing synchronously on every scroll event, and a cooldown
    // ignores the synthetic scroll our own repositioning triggers.
    assert.match(dashboardJs, /extendTimer\s*=\s*root\.setTimeout/);
    assert.match(dashboardJs, /CALENDAR_EXTEND_DEBOUNCE_MS/);
    assert.match(dashboardJs, /suppressExtendUntil/);
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

  it('escapes guest fields in calendar and pending cash reservation cards', () => {
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const calendarGrid = createFakeElement('div');
    const pendingList = createFakeElement('div');
    const appended = [];
    const documentRef = {
      createElement(tagName) {
        const element = createFakeElement(tagName);
        const originalAppend = element.appendChild.bind(element);
        element.appendChild = (child) => {
          originalAppend(child);
          if (element === calendarGrid && child.className?.includes?.('crm-reservation-card')) {
            appended.push(child);
          }
          return child;
        };
        return element;
      },
      querySelector(selector) {
        if (selector === '[data-calendar-grid]') return calendarGrid;
        if (selector === '[data-pending-cash-list]') return pendingList;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    calendarGrid.appendChild = (child) => {
      calendarGrid.children.push(child);
      if (child.className?.includes?.('crm-reservation-card')) {
        appended.push(child);
      }
      return child;
    };
    const { EcoVilaCrmDashboard: dashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: documentRef,
      EcoVilaCrmCalendar,
    });
    const payload = '<img src=x onerror=alert(1)>';
    const phonePayload = '<svg onload=alert(2)>';
    const reservation = {
      id: 'reservation-xss',
      booking_group_id: 'group-xss',
      room_id: 'room-1',
      guest_first_name: payload,
      guest_last_name: 'Client',
      guest_phone: phonePayload,
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      adults: 2,
      kids_ages: [],
      payment_type: 'cash',
      payment_status: 'pending',
      total_price: 2400,
      cash_expires_at: '2026-06-01T10:00:00.000Z',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };

    dashboard.renderCalendar(
      { formatDate: (date) => date, formatMDL: (amount) => `${amount} MDL` },
      {
        today: '2026-06-01',
        startDate: '2026-06-01',
        dates: ['2026-06-10', '2026-06-11'],
        rooms: [{ id: 'room-1', number: 1, type: 'small' }],
        reservations: [reservation],
      },
    );
    dashboard.renderPendingCash({ formatMDL: (amount) => `${amount} MDL` }, [reservation]);

    const calendarHtml = appended.map((item) => item.innerHTML).join('\n');
    assert.doesNotMatch(calendarHtml, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(calendarHtml, /<svg onload=alert\(2\)>/);
    // The calendar card title now shows the booking total instead of the guest name.
    assert.match(calendarHtml, /2400 MDL/);
    assert.doesNotMatch(calendarHtml, /Client/);
    assert.match(calendarHtml, /&lt;svg onload=alert\(2\)&gt;/);
    assert.doesNotMatch(pendingList.innerHTML, /<img src=x onerror=alert\(1\)>/);
    assert.match(pendingList.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt; Client/);
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
    assert.equal(daily.dailyReservationMatchesSearch(reservation, 'Turcanu Ion'), true);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, '068983660'), true);
    assert.equal(daily.dailyReservationMatchesSearch(differentRoomWithPhoneFragment, '12'), false);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, 'popescu'), false);
    assert.equal(daily.dailyReservationMatchesSearch(reservation, 'ion popescu'), false);
  });

  it('escapes guest fields in sidebar search results and daily cards', async () => {
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const searchContainer = createFakeElement('div');
    const checkIns = createFakeElement('div');
    const checkOuts = createFakeElement('div');
    const dailyCards = [];
    const documentRef = {
      createElement(tagName) {
        const element = createFakeElement(tagName);
        if (tagName === 'article') {
          dailyCards.push(element);
        }
        return element;
      },
      querySelector(selector) {
        if (selector === '[data-check-ins]') return checkIns;
        if (selector === '[data-check-outs]') return checkOuts;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const payload = '<img src=x onerror=alert(1)>';
    const phonePayload = '<svg onload=alert(2)>';
    const reservation = {
      id: 'reservation-xss',
      booking_group_id: 'group-xss',
      room_id: 'room-1',
      guest_first_name: payload,
      guest_last_name: 'Client',
      guest_phone: phonePayload,
      check_in: '2026-06-10',
      check_out: '2026-06-11',
      adults: 2,
      kids_ages: [],
      total_price: 2400,
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };
    const { EcoVilaCrmSidebar: sidebar } = loadAdminModule('admin/js/crm-sidebar.js', {
      EcoVilaCrmCalendar,
    });
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      document: documentRef,
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        fetchAdminReservations: async () => [reservation],
        fetchDailyStatuses: async () => [],
        fetchHolidays: async () => [],
        fetchPricingTiers: async () => [],
      },
    });

    sidebar.renderSearchResults(searchContainer, [reservation], () => {});
    await daily.loadDaily(
      {
        client: {},
        formatDate: (date) => date,
        formatMDL: (amount) => `${amount} MDL`,
        session: { user: { id: 'staff-1' } },
        setAlert() {},
      },
      {
        selectedDate: '2026-06-10',
        dailySearchQuery: '',
      },
    );

    const dailyHtml = dailyCards.map((item) => item.innerHTML).join('\n');
    assert.doesNotMatch(searchContainer.innerHTML, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(searchContainer.innerHTML, /<svg onload=alert\(2\)>/);
    assert.match(searchContainer.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt; Client/);
    assert.match(searchContainer.innerHTML, /&lt;svg onload=alert\(2\)&gt;/);
    assert.doesNotMatch(dailyHtml, /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(dailyHtml, /<svg onload=alert\(2\)>/);
    assert.match(dailyHtml, /&lt;img src=x onerror=alert\(1\)&gt; Client/);
    assert.match(dailyHtml, /&lt;svg onload=alert\(2\)&gt;/);
  });

  it('shows only confirmed reservations in daily check-in and check-out lists', async () => {
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const checkIns = createFakeElement('div');
    const checkOuts = createFakeElement('div');
    const dailyCards = [];
    const statusLookups = [];
    const documentRef = {
      createElement(tagName) {
        const element = createFakeElement(tagName);
        if (tagName === 'article') {
          dailyCards.push(element);
        }
        return element;
      },
      querySelector(selector) {
        if (selector === '[data-check-ins]') return checkIns;
        if (selector === '[data-check-outs]') return checkOuts;
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const rows = [
      {
        id: 'paid-in',
        guest_first_name: 'Paid',
        guest_last_name: 'Arrival',
        guest_phone: '+37360111111',
        check_in: '2026-06-10',
        check_out: '2026-06-12',
        adults: 2,
        kids_ages: [],
        total_price: 2400,
        payment_status: 'paid',
        cancelled_at: null,
        rooms: { id: 'room-1', number: 1, type: 'small' },
      },
      {
        id: 'pending-in',
        guest_first_name: 'Pending',
        guest_last_name: 'Arrival',
        guest_phone: '+37360222222',
        check_in: '2026-06-10',
        check_out: '2026-06-12',
        adults: 2,
        kids_ages: [],
        total_price: 2400,
        payment_status: 'pending',
        cancelled_at: null,
        rooms: { id: 'room-2', number: 2, type: 'small' },
      },
      {
        id: 'cancelled-status-in',
        guest_first_name: 'Cancelled',
        guest_last_name: 'Status',
        guest_phone: '+37360333333',
        check_in: '2026-06-10',
        check_out: '2026-06-12',
        adults: 2,
        kids_ages: [],
        total_price: 2400,
        payment_status: 'cancelled',
        cancelled_at: '2026-06-09T09:00:00.000Z',
        rooms: { id: 'room-3', number: 3, type: 'small' },
      },
      {
        id: 'cancelled-at-in',
        guest_first_name: 'Cancelled',
        guest_last_name: 'Timestamp',
        guest_phone: '+37360444444',
        check_in: '2026-06-10',
        check_out: '2026-06-12',
        adults: 2,
        kids_ages: [],
        total_price: 2400,
        payment_status: 'paid',
        cancelled_at: '2026-06-09T10:00:00.000Z',
        rooms: { id: 'room-4', number: 4, type: 'small' },
      },
      {
        id: 'paid-out',
        guest_first_name: 'Paid',
        guest_last_name: 'Departure',
        guest_phone: '+37360555555',
        check_in: '2026-06-08',
        check_out: '2026-06-10',
        adults: 2,
        kids_ages: [],
        total_price: 2400,
        payment_status: 'paid',
        cancelled_at: null,
        rooms: { id: 'room-5', number: 5, type: 'small' },
      },
      {
        id: 'pending-out',
        guest_first_name: 'Pending',
        guest_last_name: 'Departure',
        guest_phone: '+37360666666',
        check_in: '2026-06-08',
        check_out: '2026-06-10',
        adults: 2,
        kids_ages: [],
        total_price: 2400,
        payment_status: 'pending',
        cancelled_at: null,
        rooms: { id: 'room-6', number: 6, type: 'small' },
      },
    ];
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      document: documentRef,
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        fetchAdminReservations: async () => rows,
        fetchDailyStatuses: async (_client, _serviceDate, ids) => {
          statusLookups.push(ids);
          return [];
        },
        fetchHolidays: async () => [],
        fetchPricingTiers: async () => [],
      },
    });
    const state = {
      selectedDate: '2026-06-10',
      dailySearchQuery: '',
    };

    await daily.loadDaily(
      {
        client: {},
        formatDate: (date) => date,
        formatMDL: (amount) => `${amount} MDL`,
        session: { user: { id: 'staff-1' } },
        setAlert() {},
      },
      state,
    );

    assert.deepEqual(state.checkIns.map((reservation) => reservation.id), ['paid-in']);
    assert.deepEqual(state.checkOuts.map((reservation) => reservation.id), ['paid-out']);
    assert.deepEqual(Array.from(statusLookups[0]), ['paid-in', 'paid-out']);
    const dailyHtml = dailyCards.map((card) => card.innerHTML).join('\n');
    assert.match(dailyHtml, /Paid Arrival/);
    assert.match(dailyHtml, /Paid Departure/);
    assert.doesNotMatch(dailyHtml, /Pending/);
    assert.doesNotMatch(dailyHtml, /Cancelled/);
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
      kids_ages: [2, 12],
      total_price: 3000,
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };

    assert.deepEqual(daily.kidsAgesToBuckets([2, 3, 12]), ['0-2', '3-11', '12+']);
    assert.deepEqual(daily.bucketValuesToAges(['0-2', '3-11', '12+']), [2, 3, 12]);
    assert.equal(
      daily.calculateDailySupplement({
        reservations: [reservation],
        reservation,
        adults: 2,
        childBuckets: ['0-2', '3-11'],
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
        childBuckets: ['0-2'],
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
        childBuckets: ['0-2', '3-11', '12+'],
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
      childBuckets: ['0-2', '12+'],
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

  it('pages through admin reservations so a >1000-row window is never truncated', async () => {
    const { EcoVilaSupabase: helpers } = loadAdminModule('js/supabase.js');

    // 1345 rows across the window — like the real June–August prod window that
    // rendered August blank because PostgREST caps a single response at 1000.
    const allRows = Array.from({ length: 1345 }, (_, index) => ({
      id: `res-${String(index).padStart(4, '0')}`,
    }));
    const rangeCalls = [];
    const orderColumns = [];

    // Minimal PostgREST builder: records .order() columns and serves .range()
    // slices, mirroring the real 1000-row page cap.
    function makeBuilder() {
      const builder = {
        select: () => builder,
        gt: () => builder,
        lt: () => builder,
        gte: () => builder,
        is: () => builder,
        or: () => builder,
        eq: () => builder,
        order: (column) => {
          orderColumns.push(column);
          return builder;
        },
        range: (from, to) => {
          rangeCalls.push([from, to]);
          const slice = allRows.slice(from, Math.min(to + 1, from + 1000));
          return Promise.resolve({ data: slice, error: null });
        },
      };
      return builder;
    }
    const client = { from: () => makeBuilder() };

    const rows = await helpers.fetchAdminReservations(client, {
      startDate: '2026-06-01',
      endDate: '2026-09-01',
    });

    // Every row returned, in order, with no duplicates or gaps.
    assert.equal(rows.length, 1345);
    assert.equal(rows[0].id, 'res-0000');
    assert.equal(rows[1344].id, 'res-1344');
    assert.equal(new Set(rows.map((row) => row.id)).size, 1345);
    // Two pages: [0,999] then [1000,1999].
    assert.deepEqual(rangeCalls, [[0, 999], [1000, 1999]]);
    // A deterministic tiebreaker (id) must back the primary sort for stable paging.
    assert.ok(orderColumns.includes('id'), 'id should tiebreak the ordering');
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

  it('builds a price schedule split into effective-date timeframes', () => {
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');
    const make = (effective_from, created_at, table) => table.map(([nights_tier, day_type, adult_price, kid_price]) => ({
      nights_tier,
      day_type,
      adult_price,
      kid_price,
      effective_from,
      created_at,
    }));
    const summer = make('2026-06-01', '2026-05-01T09:00:00.000Z', [
      [1, 'weekday', 1100, 900],
      [1, 'holiday', 1300, 1000],
      [2, 'weekday', 1000, 800],
      [2, 'holiday', 1200, 900],
      [3, 'weekday', 900, 700],
      [3, 'holiday', 1100, 800],
    ]);
    const autumn = make('2026-10-01', '2026-05-01T10:00:00.000Z', [
      [1, 'weekday', 1300, 600],
      [1, 'holiday', 1550, 600],
      [2, 'weekday', 1100, 600],
      [2, 'holiday', 1550, 600],
      [3, 'weekday', 1100, 600],
      [3, 'holiday', 1550, 600],
    ]);

    const schedule = pricing.pricingSchedule(summer.concat(autumn));
    assert.equal(schedule.length, 2);
    assert.equal(schedule[0].from, '2026-06-01');
    assert.equal(schedule[0].until, '2026-09-30');
    assert.equal(schedule[1].from, '2026-10-01');
    assert.equal(schedule[1].until, null);
    assert.deepEqual(
      JSON.parse(JSON.stringify(
        schedule[0].prices.map((row) => [row.nights_tier, row.day_type, row.adult_price, row.kid_price]),
      )),
      [
        [1, 'weekday', 1100, 900],
        [1, 'holiday', 1300, 1000],
        [2, 'weekday', 1000, 800],
        [2, 'holiday', 1200, 900],
        [3, 'weekday', 900, 700],
        [3, 'holiday', 1100, 800],
      ],
    );
    assert.equal(schedule[1].prices[0].adult_price, 1300);
  });

  it('collapses consecutive timeframes with identical prices', () => {
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');
    const table = [
      [1, 'weekday', 1100, 900],
      [1, 'holiday', 1300, 1000],
      [2, 'weekday', 1000, 800],
      [2, 'holiday', 1200, 900],
      [3, 'weekday', 900, 700],
      [3, 'holiday', 1100, 800],
    ];
    const rows = ['2026-06-01', '2026-08-01'].flatMap((effective_from) => table.map(
      ([nights_tier, day_type, adult_price, kid_price]) => ({
        nights_tier,
        day_type,
        adult_price,
        kid_price,
        effective_from,
        created_at: `${effective_from}T09:00:00.000Z`,
      }),
    ));

    const schedule = pricing.pricingSchedule(rows);
    assert.equal(schedule.length, 1);
    assert.equal(schedule[0].from, '2026-06-01');
    assert.equal(schedule[0].until, null);
  });

  it('drops fully elapsed price periods, keeping the active one and future ones', () => {
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');
    const mk = (effective_from, adultBase) => Array.from({ length: 6 }, (unused, index) => ({
      nights_tier: (index >> 1) + 1,
      day_type: index % 2 === 0 ? 'weekday' : 'holiday',
      adult_price: adultBase + index,
      kid_price: 500 + index,
      effective_from,
      created_at: `${effective_from}T09:00:00.000Z`,
    }));
    // elapsed (ends well before today) → active (in force now) → scheduled (future)
    const rows = mk('2020-01-01', 700).concat(mk('2020-06-01', 800)).concat(mk('2099-01-01', 900));

    const schedule = pricing.pricingSchedule(rows);
    assert.equal(schedule.length, 2);
    assert.equal(schedule[0].from, '2020-06-01');
    assert.equal(schedule[0].isCurrent, true);
    assert.equal(schedule[1].from, '2099-01-01');
    assert.equal(schedule[1].isFuture, true);
    assert.ok(!schedule.some((segment) => segment.from === '2020-01-01'));
  });

  it('formats schedule helpers as day.month.year and previous day', () => {
    const { EcoVilaCrmPricing: pricing } = loadAdminModule('admin/js/crm-pricing.js');
    assert.equal(pricing.formatScheduleDate('2026-10-01'), '01.10.2026');
    assert.equal(pricing.dayBeforeISO('2026-10-01'), '2026-09-30');
    assert.equal(pricing.dayBeforeISO('2026-03-01'), '2026-02-28');
  });

  it('exposes a price-schedule view toggle and container in the CRM', () => {
    const dashboard = read('admin/dashboard.html');
    assert.match(dashboard, /data-price-view="edit"/);
    assert.match(dashboard, /data-price-view="schedule"/);
    assert.match(dashboard, /data-price-view-panel="edit"/);
    assert.match(dashboard, /data-price-view-panel="schedule"/);
    assert.match(dashboard, /data-price-schedule/);
    assert.doesNotMatch(dashboard, /data-upcoming-prices/);
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

  it('restricts Angela to a read-only reservations dashboard while keeping daily writes', () => {
    const sql = allMigrations();

    // The shared both-roles manage policy is replaced by explicit per-role policies.
    assert.match(sql, /drop policy if exists "CRM staff can manage reservations" on public\.reservations/i);
    assert.match(sql, /create policy "Diana can manage reservations"[\s\S]+?for all[\s\S]+?ecovila_app_role\(\) = 'diana'/i);
    assert.match(sql, /create policy "Angela can read reservations"[\s\S]+?for select[\s\S]+?ecovila_app_role\(\) = 'angela'/i);
    assert.match(sql, /create policy "Angela can update daily reservation fields"[\s\S]+?for update[\s\S]+?ecovila_app_role\(\) = 'angela'/i);

    // The column guard limits Angela's UPDATEs to exactly the daily-tab fields.
    assert.match(sql, /create or replace function public\.enforce_angela_reservation_columns\(\)/i);
    assert.match(sql, /allowed_columns constant text\[\] := array\[\s*'towel_cards_issued', 'adults', 'check_out', 'kids_ages', 'total_price'\s*\]/i);
    assert.match(sql, /if public\.ecovila_app_role\(\) <> 'angela' then\s+return new;/i);
    assert.match(sql, /create trigger enforce_angela_reservation_columns\s+before update on public\.reservations/i);
  });
});

// ADR-100: the add-reservation form picks dates first and then offers the whole
// 1-25 inventory as a grid, and staff can block villas temporarily while a
// cheque clears.
describe('EcoVila CRM date-first room grid and temporary holds', () => {
  const rooms = [
    { id: 'room-1', number: 1, type: 'small', is_active: true },
    { id: 'room-2', number: 2, type: 'small', is_active: true },
    { id: 'room-9', number: 9, type: 'large', is_active: true },
    { id: 'room-16', number: 16, type: 'hotel', is_active: true },
  ];

  function loadSidebar() {
    return loadAdminModule('admin/js/crm-sidebar.js', {
      EcoVilaPricing: pricing,
      EcoVilaCalendar: calendar,
    }).EcoVilaCrmSidebar;
  }

  it('renders the room picker below the dates, as a grid writing into a hidden field', () => {
    const dashboard = read('admin/dashboard.html');
    const sidebarJs = read('admin/js/crm-sidebar.js');
    const css = read('css/crm.css');

    // The free-text villa box is gone; the CSV lives on as the hidden source of
    // truth every reader (pricing, validation, row building) already uses.
    assert.doesNotMatch(dashboard, /<input type="text" placeholder="3, 11, 18" data-add-room-numbers>/);
    assert.match(dashboard, /<input type="hidden" data-add-room-numbers>/);
    assert.match(dashboard, /data-add-room-grid/);
    assert.match(dashboard, /data-add-room-status/);

    // Dates must come first in the DOM order staff read top to bottom.
    assert.ok(
      dashboard.indexOf('data-add-date-picker') < dashboard.indexOf('data-add-room-picker'),
      'the villa grid should sit below the check-in/check-out picker',
    );

    assert.match(sidebarJs, /function buildRoomPickerModel/);
    assert.match(css, /\.crm-room-group__grid\s*{[^}]*grid-template-columns:\s*repeat\(8,/i);
  });

  it('offers every one of the 25 villas, grouped by type, with inactive numbers still in place', () => {
    const sidebar = loadSidebar();
    const model = sidebar.buildRoomPickerModel({
      rooms,
      reservations: [],
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      selectedNumbers: [],
    });

    assert.equal(model.totalCount, 25);
    assert.deepEqual(Array.from(model.groups, (group) => group.label), ['Mici', 'Mari', 'Hotel']);
    assert.deepEqual(Array.from(model.groups, (group) => group.totalCount), [8, 7, 10]);

    const squares = Array.from(model.groups).flatMap((group) => Array.from(group.squares));
    assert.equal(squares.length, 25);
    assert.deepEqual(squares.map((square) => square.number), Array.from({ length: 25 }, (_, i) => i + 1));

    // fetchRooms only returns ACTIVE rooms, so a villa missing from the payload
    // must render in place as inactive rather than shifting every later number.
    assert.equal(squares.find((square) => square.number === 1).state, 'available');
    assert.equal(squares.find((square) => square.number === 3).state, 'inactive');
    assert.equal(model.freeCount, 4);
  });

  it('waits for the dates before claiming anything is free', () => {
    const sidebar = loadSidebar();
    const model = sidebar.buildRoomPickerModel({ rooms, reservations: [], selectedNumbers: [] });

    assert.equal(model.ranged, false);
    assert.equal(model.freeCount, 0);
    assert.ok(Array.from(model.groups).flatMap((group) => Array.from(group.squares)).every((square) => {
      return square.state === 'standby' || square.state === 'inactive';
    }));
  });

  it('waits for the inventory too, instead of flashing 25 deactivated villas', () => {
    const sidebar = loadSidebar();
    // state.rooms is empty until the first dashboard load lands.
    const model = sidebar.buildRoomPickerModel({ rooms: [], reservations: [], selectedNumbers: [] });
    const squares = Array.from(model.groups).flatMap((group) => Array.from(group.squares));

    assert.equal(squares.length, 25);
    assert.ok(squares.every((square) => square.state === 'standby'));
  });

  it('marks occupied villas, keeps selected ones, and says so when nothing is free', () => {
    const sidebar = loadSidebar();
    const reservations = [
      { room_id: 'room-1', check_in: '2026-08-10', check_out: '2026-08-12', payment_status: 'paid', cancelled_at: null },
      // A live hold blocks its villa exactly like a paid booking.
      {
        room_id: 'room-9',
        check_in: '2026-08-10',
        check_out: '2026-08-12',
        payment_status: 'pending',
        payment_type: 'office',
        cash_expires_at: '2026-08-01T12:00:00.000Z',
        cancelled_at: null,
      },
      // A cancelled row frees its villa again.
      { room_id: 'room-16', check_in: '2026-08-10', check_out: '2026-08-12', payment_status: 'cancelled', cancelled_at: '2026-08-01T09:00:00.000Z' },
    ];
    const model = sidebar.buildRoomPickerModel({
      rooms,
      reservations,
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      selectedNumbers: [2],
    });
    const squares = model.groups.flatMap((group) => group.squares);

    assert.equal(squares.find((square) => square.number === 1).state, 'occupied');
    assert.equal(squares.find((square) => square.number === 9).state, 'occupied');
    assert.equal(squares.find((square) => square.number === 16).state, 'available');
    assert.equal(squares.find((square) => square.number === 2).state, 'selected');
    assert.equal(model.freeCount, 2, 'a selected villa is still one of the free ones');
  });

  it('drops a selected villa that someone else booked, and keeps the rest', () => {
    const sidebar = loadSidebar();
    const model = sidebar.buildRoomPickerModel({
      rooms,
      reservations: [
        { room_id: 'room-2', check_in: '2026-08-10', check_out: '2026-08-12', payment_status: 'paid', cancelled_at: null },
      ],
      checkIn: '2026-08-10',
      checkOut: '2026-08-12',
      selectedNumbers: [1, 2],
    });

    const reconciled = sidebar.reconcileSelectedRooms(model);
    assert.deepEqual(Array.from(reconciled.kept), [1]);
    assert.deepEqual(Array.from(reconciled.dropped), [2]);

    // With no stay chosen, availability is unknown — nothing may be reported as
    // taken, or clearing the dates would accuse villas of being booked.
    const dateless = sidebar.buildRoomPickerModel({ rooms, reservations: [], selectedNumbers: [1, 2] });
    assert.deepEqual(Array.from(sidebar.reconcileSelectedRooms(dateless).dropped), []);
  });

  it('never claims availability past the loaded two-year horizon', () => {
    const sidebar = loadSidebar();
    const model = sidebar.buildRoomPickerModel({
      rooms,
      reservations: [],
      checkIn: '2029-08-10',
      checkOut: '2029-08-12',
      horizonEnd: '2028-07-18',
      selectedNumbers: [],
    });

    // Staff may still book that far ahead (ADR-086), but the grid says the
    // availability is unverified instead of inventing 25 free villas.
    assert.equal(model.unverified, true);
  });

  it('treats a stay as bookable only when ONE villa covers every night of it', () => {
    const sidebar = loadSidebar();
    // Villa 1 is taken on night one, villa 2 on night two: each night has a free
    // villa, yet no single villa can host a two-night stay.
    const reservations = [
      { room_id: 'room-1', check_in: '2026-08-10', check_out: '2026-08-11', payment_status: 'paid', cancelled_at: null },
      { room_id: 'room-2', check_in: '2026-08-11', check_out: '2026-08-12', payment_status: 'paid', cancelled_at: null },
    ];
    const index = sidebar.buildRoomOccupancyIndex(reservations);
    const twoRooms = rooms.filter((room) => room.type === 'small');

    assert.ok(twoRooms.some((room) => sidebar.isRoomFreeInIndex(index, room.id, '2026-08-10', '2026-08-11')));
    assert.ok(twoRooms.some((room) => sidebar.isRoomFreeInIndex(index, room.id, '2026-08-11', '2026-08-12')));
    assert.ok(
      !twoRooms.some((room) => sidebar.isRoomFreeInIndex(index, room.id, '2026-08-10', '2026-08-12')),
      'the whole-range check is what stops an unbookable split stay',
    );

    // Half-open ranges: a stay may start the day another one checks out.
    assert.ok(sidebar.isRoomFreeInIndex(index, 'room-1', '2026-08-11', '2026-08-12'));
    assert.ok(sidebar.isRoomFreeInIndex(index, 'room-2', '2026-08-09', '2026-08-11'));
  });

  it('creates a paid office booking by default and an unpaid, dated hold when asked', () => {
    const sidebar = loadSidebar();
    const now = new Date('2026-08-01T09:00:00.000Z');
    const baseFields = {
      '[data-add-room-numbers]': field('7'),
      '[data-add-full-name]': field('Ion Popescu'),
      '[data-add-phone]': field('+37369857607'),
      '[data-add-email]': field(''),
      '[data-add-check-in]': field('2026-08-10'),
      '[data-add-check-out]': field('2026-08-12'),
      '[data-add-adults]': field('2'),
      '[data-add-child-bucket]:checked': [],
      '[data-add-total]': field('', { dataset: { total: '3000' } }),
      '[data-add-conference]': field('', { checked: false }),
      '[data-add-notes]': field(''),
    };
    const roomList = [{ id: 'room-7', number: 7 }];
    const options = { createGroupId: () => 'staff-group', now };

    const [normal] = sidebar.buildStaffReservationRows(
      formWithFields(baseFields),
      roomList,
      { role: 'diana' },
      options,
    );
    assert.equal(normal.payment_type, 'office');
    assert.equal(normal.payment_status, 'paid');
    assert.equal(normal.paid_at, now.toISOString());
    assert.equal(normal.cash_expires_at, null);

    const [hold] = sidebar.buildStaffReservationRows(
      formWithFields({
        ...baseFields,
        '[data-add-hold-toggle]': field('', { checked: true }),
        '[data-add-hold-hours]': [
          { value: '1', checked: false },
          { value: '3', checked: true },
          { value: '8', checked: false },
        ],
      }),
      roomList,
      { role: 'diana' },
      options,
    );
    assert.equal(hold.payment_type, 'office', 'a hold is still a staff booking');
    assert.equal(hold.payment_status, 'pending', 'pending keeps the villa inside the no-overlap constraint');
    assert.equal(hold.paid_at, null, 'paid_at must stay null or expired holds pollute finance');
    assert.equal(hold.cash_expires_at, '2026-08-01T12:00:00.000Z');
    assert.equal(hold.total_price, 3000, 'the price is still recorded — it is what will be owed');
  });

  it('defaults the hold to three hours and only accepts 1h / 3h / 8h', () => {
    const sidebar = loadSidebar();

    assert.deepEqual(
      { ...sidebar.readHoldState(formWithFields({ '[data-add-hold-toggle]': field('', { checked: false }) })) },
      { enabled: false, hours: 3 },
    );
    assert.deepEqual(
      {
        ...sidebar.readHoldState(formWithFields({
          '[data-add-hold-toggle]': field('', { checked: true }),
          '[data-add-hold-hours]': [{ value: '8', checked: true }],
        })),
      },
      { enabled: true, hours: 8 },
    );
    // A tampered value falls back to the default rather than creating an
    // arbitrary-length block; the DB snaps it to a real bucket anyway.
    assert.deepEqual(
      {
        ...sidebar.readHoldState(formWithFields({
          '[data-add-hold-toggle]': field('', { checked: true }),
          '[data-add-hold-hours]': [{ value: '48', checked: true }],
        })),
      },
      { enabled: true, hours: 3 },
    );
  });

  it('tells staff exactly when a hold dies, on the resort clock', () => {
    const sidebar = loadSidebar();
    // 09:00 UTC on 1 August is 12:00 in Chișinău (UTC+3).
    const now = new Date('2026-08-01T09:00:00.000Z');

    assert.equal(sidebar.formatHoldExpiry(sidebar.holdExpiresAt(3, now), now), 'Expiră azi la 15:00');
    assert.equal(sidebar.formatHoldExpiry(sidebar.holdExpiresAt(8, now), now), 'Expiră azi la 20:00');
    // A late-evening 8h hold rolls past midnight.
    const evening = new Date('2026-08-01T18:00:00.000Z');
    assert.equal(sidebar.formatHoldExpiry(sidebar.holdExpiresAt(8, evening), evening), 'Expiră mâine la 05:00');
  });

  it('shows a hold as provisional in the calendar and counts down in hours', () => {
    const { EcoVilaCrmCalendar: crmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const hold = {
      payment_type: 'office',
      payment_status: 'pending',
      cash_expires_at: '2026-08-01T12:00:00.000Z',
      cancelled_at: null,
    };
    const paidOffice = { payment_type: 'office', payment_status: 'paid', cash_expires_at: null, cancelled_at: null };

    assert.equal(crmCalendar.isTemporaryHold(hold), true);
    assert.equal(crmCalendar.isTemporaryHold(paidOffice), false, 'a confirmed hold is an ordinary booking');
    assert.equal(crmCalendar.getCardClass(hold), 'crm-reservation-card--hold');
    assert.equal(
      crmCalendar.getCardClass({ ...hold, payment_status: 'cancelled', cancelled_at: '2026-08-01T12:00:00.000Z' }),
      'crm-reservation-card--cancelled',
    );

    const css = read('css/crm.css');
    assert.match(css, /\.crm-reservation-card--hold\s*{[\s\S]*?repeating-linear-gradient/i);
  });

  it('counts a hold down to its real deadline, with no cash-style grace', () => {
    const { EcoVilaCrmDashboard: dashboard } = loadAdminModule('admin/js/crm-dashboard.js');
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000 + 14 * 60 * 1000).toISOString();

    assert.match(dashboard.formatHoldCountdown(inTwoHours), /^2h 1[34]m rămase$/);
    assert.match(dashboard.formatHoldCountdown(new Date(Date.now() + 9 * 60 * 1000).toISOString()), /^[89]m rămase$/);
    assert.equal(dashboard.formatHoldCountdown(new Date(Date.now() - 1000).toISOString()), 'Expiră acum');
    assert.equal(dashboard.formatHoldCountdown(null), 'Fără termen');
  });

  it('gives holds their own sidebar panel with confirm and release actions', () => {
    const dashboard = read('admin/dashboard.html');
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const helpers = read('js/supabase.js');

    // The cash panel is a daily money tool and stays exactly as it was.
    assert.match(dashboard, /Plăți cash în așteptare/);
    assert.match(dashboard, /data-holds-section/);
    assert.match(dashboard, /Rezervări temporare/);
    assert.match(dashboardJs, /data-confirm-hold/);
    assert.match(dashboardJs, /data-release-hold/);

    // Confirm/release go through the RPCs, which re-check the deadline on the
    // server and move the whole booking group in one transaction.
    assert.match(helpers, /rpc\('confirm_temporary_hold'/);
    assert.match(helpers, /rpc\('release_temporary_hold'/);
    assert.match(helpers, /function fetchTemporaryHolds[\s\S]*?eq\('payment_type', 'office'\)[\s\S]*?not\('cash_expires_at', 'is', null\)/);
  });

  it('stamps hold deadlines from the database clock and expires them on cron', () => {
    const sql = allMigrations();

    // The admin browser only hints at a duration; the DB decides the deadline.
    assert.match(sql, /create or replace function public\.enforce_temporary_hold_expiry\(\)/i);
    assert.match(sql, /new\.cash_expires_at := now\(\) \+ make_interval\(hours => snapped_hours\)/i);
    assert.match(sql, /new\.paid_at := null/i);
    assert.match(sql, /create trigger enforce_temporary_hold_expiry\s+before insert on public\.reservations/i);

    // Auto-release: pure SQL, so no guest ever gets an "expired" message.
    assert.match(sql, /cron\.schedule\(\s*'ecovila-expire-temporary-holds'/i);
    assert.match(sql, /cancellation_reason = 'hold_expired'[\s\S]*?where payment_type = 'office'[\s\S]*?and payment_status = 'pending'[\s\S]*?and cash_expires_at < now\(\)/i);

    // Both RPCs are diana-gated and re-check the deadline / group integrity.
    assert.match(sql, /create or replace function public\.confirm_temporary_hold\(p_booking_group_id uuid\)/i);
    assert.match(sql, /create or replace function public\.release_temporary_hold\(p_booking_group_id uuid\)/i);
    assert.match(sql, /confirm_temporary_hold[\s\S]*?ecovila_app_role\(\) <> 'diana'/i);
    assert.match(sql, /release_temporary_hold[\s\S]*?ecovila_app_role\(\) <> 'diana'/i);
    assert.match(sql, /and r\.cash_expires_at > now\(\)/i);
    assert.match(sql, /revoke all on function public\.confirm_temporary_hold\(uuid\) from public, anon, authenticated/i);
    assert.match(sql, /grant execute on function public\.release_temporary_hold\(uuid\) to authenticated, service_role/i);
  });

  it('reads an empty villa field as no villas, not as villa zero', () => {
    const sidebar = loadSidebar();

    // Number('') is 0 and Number.isInteger(0) is true, so an empty field used to
    // parse as villa "0" — which the grid then reported as deselected on load.
    assert.deepEqual(Array.from(sidebar.readNumberList('')), []);
    assert.deepEqual(Array.from(sidebar.readNumberList('   ')), []);
    assert.deepEqual(Array.from(sidebar.readNumberList('3, , 4')), [3, 4]);
    assert.deepEqual(Array.from(sidebar.readNumberList('3, 11, 18')), [3, 11, 18]);
  });

  it('clears the stay and the villas by hand after a booking is saved', () => {
    const sidebar = loadSidebar();
    const fields = {
      '[data-add-check-in]': field('2026-08-10'),
      '[data-add-check-out]': field('2026-08-12'),
      '[data-add-room-numbers]': field('3, 4'),
    };

    // form.reset() leaves hidden inputs alone (their value IS their default), so
    // without this the next booking would start with the previous stay filled in.
    sidebar.clearAddFormSelection(formWithFields(fields));

    assert.equal(fields['[data-add-check-in]'].value, '');
    assert.equal(fields['[data-add-check-out]'].value, '');
    assert.equal(fields['[data-add-room-numbers]'].value, '');
  });

  it('does not treat the click that opens the picker as a click outside it', () => {
    const sidebar = loadSidebar();
    const square = { closest: (selector) => (selector === '[data-add-room]' ? square : null), dataset: { addRoom: '3' } };
    const elsewhere = { closest: () => null };

    assert.equal(sidebar.isClickOnRoomSquare({ target: square, composedPath: () => [square] }), true);
    assert.equal(sidebar.isClickOnRoomSquare({ target: elsewhere, composedPath: () => [elsewhere] }), false);
  });

  it('refuses to report a reschedule as done when a group row vanished mid-move (ADR-101)', () => {
    const sql = allMigrations();
    const reschedule = read('supabase/functions/reservation-reschedule/index.ts');

    // The RPC used to update zero rows silently when a row was cancelled between
    // the Edge Function's read and the commit (guest cancel, CRM delete, hold
    // expiry) — the CRM then showed a move that never happened. Both phases now
    // assert row counts and abort with P0002, rolling the whole move back.
    assert.match(sql, /get diagnostics touched = row_count/i);
    assert.match(sql, /is no longer active and cannot be moved'[\s\S]{0,80}using errcode = 'P0002'/i);
    assert.match(sql, /vanished mid-move'[\s\S]{0,80}using errcode = 'P0002'/i);

    // The Edge Function turns that rollback into a retriable 409, like 23P01.
    assert.match(reschedule, /\.code\) === 'P0002'/);
    assert.match(reschedule, /nu mai este activă — a fost anulată sau eliberată între timp/);

    // The hold-SMS suppression is decided on the row AFTER the move committed:
    // a hold confirmed mid-move is a real booking whose guest must hear about it.
    assert.match(reschedule, /loadReservationHoldFields\(client, opened\.id\)/);
    assert.match(reschedule, /datesChanged && !suppressHoldSms/);
  });

  it('keeps live holds out of every guest-facing rail, not just the OTP list', () => {
    const shared = read('supabase/functions/_shared/reservations.ts');
    const reschedule = read('supabase/functions/reservation-reschedule/index.ts');

    // One definition, every rail. Filtering only the OTP list would still leave
    // a phone-scoped manage token able to open — and cancel — a staff hold.
    assert.match(shared, /EXCLUDE_LIVE_HOLDS_FILTER =\s*\n?\s*'payment_type\.neq\.office,payment_status\.neq\.pending,cash_expires_at\.is\.null'/);
    for (const fn of [
      'reservation-lookup-start',
      'reservation-lookup-verify',
      'reservation-manage-details',
      'reservation-cancel',
    ]) {
      const source = read(`supabase/functions/${fn}/index.ts`);
      assert.match(source, /import \{ EXCLUDE_LIVE_HOLDS_FILTER \}/, `${fn} should import the shared filter`);
      assert.match(source, /\.or\(EXCLUDE_LIVE_HOLDS_FILTER\)/, `${fn} should apply the shared filter`);
    }

    // Moving a hold's dates must not text a guest about a booking they were
    // never promised (decided on post-move state, see the ADR-101 test).
    assert.match(reschedule, /if \(datesChanged && !suppressHoldSms\)/);
  });

  it('releases a hold instead of running the guest-notifying cancellation path', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');

    // "Șterge rezervarea" on a hold used to reach notifyReservationCancellation,
    // texting the guest that a booking they never made was cancelled.
    assert.match(
      dashboardJs,
      /isTemporaryHold\(reservation\) && reservation\.booking_group_id\)\s*\{\s*await releaseHold\([^)]*\{ skipConfirm: true \}\)/,
      'deleteReservation should route a live hold to the release RPC',
    );
    // The RPC call and the reload are separate, so a failed reload cannot report
    // a committed confirmation as a failure.
    assert.match(dashboardJs, /function runHoldAction/);
    assert.match(dashboardJs, /function errorMessage\(error, fallback\)/);
    // Stale reloads must not overwrite newer state.
    assert.match(dashboardJs, /state\.loadGeneration !== generation/);
  });

  it('counts a hold as an occupied villa but never as an arrival', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');

    // The Situația zilnică tab lists only paid stays; the dashboard counters
    // have to agree with it or staff chase an arrival that does not exist.
    assert.match(dashboardJs, /const confirmedReservations = activeReservations\.filter/);
    assert.match(dashboardJs, /confirmedReservations\.filter\(\(reservation\) => reservation\.check_in === today\)/);
    assert.match(dashboardJs, /confirmedReservations\.filter\(\(reservation\) => reservation\.check_out === today\)/);
    // Occupancy still counts every non-cancelled row, holds included.
    assert.match(dashboardJs, /activeReservations\s*\n?\s*\.filter\(\(reservation\) => root\.EcoVilaCrmCalendar\.overlapsDate/);
  });

  it('keeps a live hold out of the finance "bookings created" list until confirmed', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      EcoVilaPricing: pricing,
      EcoVilaCrmCalendar: { todayISO: () => '2026-08-01' },
    });
    const base = {
      check_in: '2026-08-10',
      check_out: '2026-08-12',
      total_price: 4000,
      created_at: '2026-08-01T09:00:00.000Z',
      rooms: { number: 3, type: 'small' },
    };
    const rows = finance.normalizeBookedDayRows([
      { ...base, id: 'hold', payment_type: 'office', payment_status: 'pending', cash_expires_at: '2026-08-01T12:00:00.000Z', paid_at: null, cancelled_at: null },
      { ...base, id: 'confirmed', payment_type: 'office', payment_status: 'paid', cash_expires_at: null, paid_at: '2026-08-01T10:00:00.000Z', cancelled_at: null },
      { ...base, id: 'online', payment_type: 'card', payment_status: 'paid', cash_expires_at: null, paid_at: '2026-08-01T11:00:00.000Z', cancelled_at: null },
    ]);

    assert.deepEqual(Array.from(rows, (row) => row.id), ['confirmed', 'online']);
  });

  it('respects conflicts it already knows about on a stay that runs past the horizon', () => {
    const sidebar = loadSidebar();
    // The stay starts inside the loaded window (where villa 1 is taken) and ends
    // past it. "Unverified" must not erase the known clash.
    const model = sidebar.buildRoomPickerModel({
      rooms,
      reservations: [
        { room_id: 'room-1', check_in: '2028-07-01', check_out: '2028-07-20', payment_status: 'paid', cancelled_at: null },
      ],
      checkIn: '2028-07-10',
      checkOut: '2028-08-05',
      horizonEnd: '2028-07-18',
      selectedNumbers: [],
    });
    const squares = Array.from(model.groups).flatMap((group) => Array.from(group.squares));

    assert.equal(model.unverified, true, 'the range still reads as unverified overall');
    assert.equal(squares.find((square) => square.number === 1).state, 'occupied');
    assert.equal(squares.find((square) => square.number === 2).state, 'available');
  });
});

// ADR-104 — partial cancellation + manual partial refund from the CRM dialog.
// The feature makes a booking group able to hold cancelled and live rows at the
// same time for the first time, so these cover both the new control and the
// readers that used to assume a group cancels as one unit.
describe('EcoVila CRM partial cancellation and partial refund', () => {
  it('offers the villa picker, a manual amount and a typed confirmation in the reservation dialog', () => {
    const dashboard = read('admin/dashboard.html');
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const css = read('css/crm.css');

    for (
      const hook of [
        'data-partial-cancel',
        'data-partial-toggle',
        'data-partial-villas',
        'data-partial-amount',
        'data-partial-confirm',
        'data-partial-submit',
      ]
    ) {
      assert.match(dashboard, new RegExp(hook), `${hook} must exist in the reservation dialog`);
    }
    // The block belongs to the reservation dialog, not to some other panel.
    const dialogMarkup = dashboard.slice(
      dashboard.indexOf('data-reservation-dialog'),
      dashboard.indexOf('data-swap-dialog'),
    );
    assert.match(dialogMarkup, /data-partial-cancel/);

    // Irreversible money action: it needs the typed word before it can fire.
    assert.match(dashboardJs, /PARTIAL_CONFIRM_WORD\s*=\s*'anulez'/);
    assert.match(dashboardJs, /=== PARTIAL_CONFIRM_WORD/);
    // One server call performs cancel + refund + notification together.
    assert.match(dashboardJs, /EcoVilaSupabase\.partialCancelReservation/);
    assert.match(css, /\.crm-partial__villa\b/);
  });

  it('only lists live villas, hides the control for read-only staff and for holds', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    // Candidates come from the booking group minus anything already cancelled.
    assert.match(
      dashboardJs,
      /partialCancelCandidates[\s\S]*?!root\.EcoVilaCrmCalendar\.isCancelled\(row\)/,
    );
    // A hold is released, never "cancelled" — cancelling it would tell the guest
    // a reservation they never made was called off.
    assert.match(dashboardJs, /const available = !readOnly && !isHold && candidates\.length > 0/);
  });

  it('states what the refund does to the money before staff can confirm it', () => {
    const dashboard = read('admin/dashboard.html');
    const dashboardJs = read('admin/js/crm-dashboard.js');
    // The one-refund-per-payment consequence has to be on screen, in figures,
    // because the remainder can never be returned through the system again.
    assert.match(dashboardJs, /Restul de \$\{formatMDL\(rest\)\} nu va mai putea fi restituit prin MAIB/);
    assert.match(dashboardJs, /const rest = Math\.max\(0, Math\.round\(context\.paidTotal\) - amount\)/);
    assert.match(dashboard, /Sumă de reversat \(bază brută, MDL\)/);
    assert.match(dashboardJs, /getActiveRefundCommissionBps/);
    assert.match(dashboardJs, /Math\.ceil\(amount \* \(1 - activeRate\)\)/);
    assert.match(dashboardJs, /comision reținut \$\{formatMDL\(withheld\)\}/);
    assert.match(dashboardJs, /clientul primește \$\{formatMDL\(net\)\}/);
    assert.match(dashboardJs, /Anulează și restituie \$\{formatMDL\(net\)\}/);
    assert.match(dashboardJs, /restituire integrală, fără reținerea comisionului/);
  });

  it('uses one unchecked override for both full and partial cancellation requests', () => {
    const dashboard = read('admin/dashboard.html');
    const dashboardJs = read('admin/js/crm-dashboard.js');
    const dialogMarkup = dashboard.slice(
      dashboard.indexOf('data-reservation-dialog'),
      dashboard.indexOf('data-swap-dialog'),
    );

    assert.equal((dialogMarkup.match(/data-refund-full-override/g) || []).length, 1);
    assert.doesNotMatch(dialogMarkup, /data-refund-full-override[^>]*checked/);
    assert.match(
      dashboardJs,
      /partialCancelReservation[\s\S]*?withholdCommission: !context\.refundOverride\?\.checked/,
    );
    assert.match(
      dashboardJs,
      /refundMaibPaymentRequest[\s\S]*?withholdCommission: !qs\('\[data-refund-full-override\]', dialog\)\?\.checked/,
    );
  });

  it('previews gross, retained and net figures and sends the partial override', async () => {
    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.close = () => {};
    const section = createFakeElement('section');
    const list = createFakeElement('ul');
    const amount = createFakeElement('input');
    const confirm = createFakeElement('input');
    const hint = createFakeElement('p');
    const error = createFakeElement('p');
    const submit = createFakeElement('button');
    const override = createFakeElement('input');
    const partialCheckboxes = [];
    const sectionFields = {
      '[data-partial-body]': createFakeElement('div'),
      '[data-partial-toggle]': createFakeElement('button'),
      '[data-partial-villas]': list,
      '[data-partial-amount]': amount,
      '[data-partial-confirm]': confirm,
      '[data-partial-error]': error,
      '[data-partial-warning]': createFakeElement('p'),
      '[data-partial-submit]': submit,
      '[data-partial-selected]': createFakeElement('p'),
      '[data-partial-hint]': hint,
    };
    section.querySelector = (selector) => sectionFields[selector] || null;
    section.querySelectorAll = (selector) => {
      if (selector === '[data-partial-villa]') return partialCheckboxes;
      if (selector === 'input') return [amount, confirm, ...partialCheckboxes];
      return [];
    };
    list.appendChild = (item) => {
      list.children.push(item);
      partialCheckboxes.push(item.children[0].children[0]);
      return item;
    };

    const fields = {
      '[data-edit-check-in]': createFakeElement('input'),
      '[data-edit-check-out]': createFakeElement('input'),
      '[data-edit-adults]': createFakeElement('input'),
      '[data-edit-kids-ages]': createFakeElement('input'),
      '[data-edit-name]': createFakeElement('input'),
      '[data-edit-phone]': createFakeElement('input'),
      '[data-edit-notes]': createFakeElement('textarea'),
      '[data-edit-payment]': createFakeElement('p'),
      '[data-edit-total]': createFakeElement('strong'),
      '[data-send-payment-confirmation]': createFakeElement('button'),
      '[data-delete-reservation]': createFakeElement('button'),
      '[data-refund-full-override]': override,
      '[data-partial-cancel]': section,
    };
    dialog.querySelector = (selector) => fields[selector] || null;
    const requests = [];
    let activeRateBps = 140;
    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js');
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: {
        createElement: createFakeElement,
        querySelector(selector) {
          return selector === '[data-reservation-dialog]' ? dialog : null;
        },
        querySelectorAll() {
          return [];
        },
        addEventListener() {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: {
        formatMDL(value) {
          return `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} MDL`;
        },
      },
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        getActiveRefundCommissionBps() {
          return activeRateBps;
        },
        async partialCancelReservation(_client, payload) {
          requests.push(payload);
          return {
            ok: true,
            refund: { ok: true, amount: payload.refundAmount },
            notificationResults: [{ sent: true }],
          };
        },
      },
    });
    const reservation = {
      id: 'villa-partial',
      booking_group_id: 'group-partial',
      check_in: '2026-09-10',
      check_out: '2026-09-12',
      adults: 2,
      kids_ages: [],
      guest_first_name: 'Ana',
      guest_last_name: 'Lungu',
      guest_phone: '+37368983660',
      payment_type: 'card',
      payment_status: 'paid',
      total_price: 12200,
      rooms: { number: 1, type: 'small' },
    };
    EcoVilaCrmDashboard.initStateForTests({
      context: { client: {}, setAlert() {} },
      reservations: [reservation],
      reload: async () => {},
    });
    EcoVilaCrmDashboard.openReservation(reservation);
    partialCheckboxes[0].checked = true;
    confirm.value = 'anulez';
    amount.value = '3500';
    amount.oninput();

    assert.equal(
      hint.textContent,
      'Restitui 3 500 MDL din 12 200 MDL încasați · comision reținut 49 MDL · clientul primește 3 451 MDL. Restul de 8 700 MDL nu va mai putea fi restituit prin MAIB.',
    );
    assert.equal(submit.textContent, 'Anulează și restituie 3 451 MDL');

    activeRateBps = 0;
    override.checked = false;
    amount.oninput();
    assert.equal(
      hint.textContent,
      'Restitui 3 500 MDL din 12 200 MDL încasați · clientul primește 3 500 MDL. Restul de 8 700 MDL nu va mai putea fi restituit prin MAIB.',
    );
    assert.equal(hint.textContent.includes('comision'), false);
    activeRateBps = null;
    amount.oninput();
    assert.equal(hint.textContent.includes('comision'), false);
    activeRateBps = 140;

    amount.value = '3500.5';
    amount.oninput();
    assert.equal(submit.disabled, true);
    await submit.onclick();
    assert.equal(error.textContent, 'Suma de reversat trebuie să fie un număr întreg pozitiv (sau lasă câmpul gol).');
    assert.equal(requests.length, 0);

    amount.value = '3500';
    override.checked = true;
    override.onchange();
    assert.equal(
      hint.textContent,
      'Restitui 3 500 MDL din 12 200 MDL încasați · restituire integrală, fără reținerea comisionului · clientul primește 3 500 MDL. Restul de 8 700 MDL nu va mai putea fi restituit prin MAIB.',
    );
    assert.equal(submit.textContent, 'Anulează și restituie 3 500 MDL');
    await submit.onclick();
    assert.equal(requests[0].withholdCommission, false);
  });

  it('cancels all the selected villas or none, inside one transaction', () => {
    const migration = read('supabase/migrations/20260811120000_partial_cancellation.sql');
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');

    // A guarded PostgREST update plus a JS row count is NOT atomic: a one-of-two
    // match commits before the function can reject it (ADR-101's lesson).
    assert.match(migration, /create or replace function public\.cancel_reservation_rows/);
    assert.match(migration, /<> v_requested/);
    assert.match(migration, /errcode = 'P0002'/);
    assert.match(migration, /grant execute on function public\.cancel_reservation_rows/);
    assert.doesNotMatch(migration, /grant execute[\s\S]*to (anon|authenticated)/);

    assert.match(fn, /rpc\('cancel_reservation_rows'/);
    // The refund must never run when the cancellation did not fully apply.
    const cancelIndex = fn.indexOf('cancelSelectedReservations(client');
    const refundIndex = fn.indexOf('executeRefund(client');
    assert.ok(cancelIndex > 0 && refundIndex > cancelIndex, 'cancel must precede the refund');
  });

  it('refuses a second refund on a payment MAIB will only refund once', () => {
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');
    // succeeded -> the slot is spent; anything else non-terminal -> someone else's
    // refund is already in motion and would be silently overwritten.
    assert.match(fn, /existing\?\.status === 'succeeded'/);
    assert.match(fn, /existing && existing\.status !== 'cancelled'/);
    assert.match(fn, /transferă restul manual/);
    // Staff-only: this moves money.
    assert.match(fn, /requireStaffRole\(request, \['diana'\]\)/);
  });

  it('tells the guest the rest of the booking stands instead of "cancelled"', () => {
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');
    const notifications = read('supabase/functions/_shared/notifications.ts');
    assert.match(notifications, /export function buildPartialCancellationEmail/);
    assert.match(notifications, /export function partialCancellationSms/);
    // Nothing left alive -> it really is an ordinary cancellation.
    assert.match(fn, /if \(!input\.remaining\.length\)[\s\S]*?buildCancellationEmail/);
    // The dedup key is one of the rows cancelled by THIS call, so a second
    // partial cancellation of the same booking still reaches the guest.
    assert.match(fn, /mapNotificationOwners\(input\.cancelled\)/);
  });

  it('stops a partial cancellation while the guest has money in flight', () => {
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');
    // A live checkout settles at the amount it was created with, against
    // whatever rows survive — the guest would pay for villas they no longer have.
    assert.match(fn, /function assertNoLivePaymentSession/);
    assert.match(fn, /plată online în curs/);
    // An open "add guests" change quotes the old villa count; void it first.
    assert.match(fn, /supersedeOpenChanges\(client, bookingGroupId\)/);
  });

  it('keeps the guest-facing pages on the villas the guest still has', () => {
    const details = read('supabase/functions/reservation-manage-details/index.ts');
    const changes = read('supabase/functions/_shared/reservationChanges.ts');
    // /gestionare summed total_price over every row of the group, cancelled ones
    // included, and read the booking's status off the first of them.
    assert.match(details, /function keepLiveRows/);
    assert.match(details, /return keepLiveRows\(data \|\| \[\]\)/);
    // "Add guests" requires EVERY loaded row to be paid and live, so one
    // cancelled sibling used to lock the guest out of the villas they kept.
    assert.match(changes, /function keepLiveChangeRows/);
    assert.match(changes, /return keepLiveChangeRows\(data \|\| \[\]\)/);
  });

  it('never promises a refund the payment can no longer make', () => {
    const cancel = read('supabase/functions/reservation-cancel/index.ts');
    // scheduleBookingRefund hands back a terminal row untouched; reporting
    // "scheduled" then is a promise no cron will keep.
    assert.match(cancel, /prepareFullRefundIntent/);
    assert.match(
      cancel,
      /const spent = !intent\.refundScheduled/,
    );
    assert.match(cancel, /refundScheduled = intent\.refundScheduled/);
    assert.match(cancel, /cancellation_reason: refundScheduled \? 'guest_request_refunded'/);
    // And staff are told, because the remainder needs a manual transfer.
    assert.match(cancel, /if \(spent\) \{[\s\S]*?alertRefundProblem/);
  });

  it('drops a cancelled villa out of the daily card total and repricing', () => {
    const daily = loadAdminModule('admin/js/crm-daily.js', {
      EcoVilaPricing: pricing,
      EcoVilaCrmCalendar: {
        addDays: pricing.addDays,
        roomNumber: (reservation) => Number(reservation.rooms?.number || 0),
      },
      EcoVilaCrmSidebar: {
        calculateStaffTotal: (input) => ({ total: 1000 * input.rooms.length }),
      },
    }).EcoVilaCrmDaily;

    const live = {
      id: 'live',
      room_id: 'room-1',
      booking_group_id: 'group-1',
      check_in: '2026-05-18',
      check_out: '2026-05-19',
      created_at: '2026-05-17T10:00:00Z',
      adults: 2,
      kids_ages: [],
      total_price: 3000,
      payment_status: 'paid',
      cancelled_at: null,
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };
    const dropped = {
      ...live,
      id: 'dropped',
      room_id: 'room-2',
      payment_status: 'cancelled',
      cancelled_at: '2026-05-17T12:00:00Z',
      rooms: { id: 'room-2', number: 2, type: 'small' },
    };

    const quote = daily.calculateDailySupplement({
      reservations: [live, dropped],
      reservation: live,
      adults: 2,
      childBuckets: [],
      pricingTiers: [],
      holidays: [],
    });

    // "Achitat" on the card, and the baseline a guest edit is priced against.
    assert.equal(quote.existingTotal, 3000, 'the cancelled villa must not inflate the paid total');
    assert.equal(quote.group.length, 1, 'only live villas belong to the booking');
    assert.equal(quote.quotedTotal, 1000, 'repricing must quote one villa, not two');
  });

  it('reports the sum actually refunded, not the price of the cancelled villas', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const cancelledVilla = {
      id: 'villa-1',
      booking_group_id: 'grp-partial',
      check_in: '2026-08-20',
      check_out: '2026-08-23',
      adults: 4,
      kids_ages: [],
      total_price: 6000,
      payment_type: 'card',
      payment_status: 'cancelled',
      paid_at: '2026-08-01T10:00:00.000Z',
      cancelled_at: '2026-08-05T09:00:00.000Z',
      cancellation_reason: 'Anulare parțială din CRM',
      guest_first_name: 'Vera',
      guest_last_name: 'Munteanu',
      rooms: { number: 4, type: 'small' },
    };

    // Staff typed 850 for a villa that cost 6000 — Finance must report 850.
    const withAmount = finance.summarizeCancellationRows({
      rows: [cancelledVilla],
      refundedGroupIds: new Map([['grp-partial', 850]]),
    });
    assert.equal(withAmount.refundedTotal, 850);
    // 0.7% of 850 + the 20 MDL sub-10k payout fee, i.e. the fee follows the sum
    // actually transferred rather than the stay price.
    assert.equal(withAmount.bankFees, 26);
    assert.equal(withAmount.netCost, 26);

    // No recorded amount (an out-of-band reconciliation): keep the old estimate.
    const withoutAmount = finance.summarizeCancellationRows({
      rows: [cancelledVilla],
      refundedGroupIds: new Map([['grp-partial', null]]),
    });
    assert.equal(withoutAmount.refundedTotal, 6000);

    // And a plain Set (the pre-ADR-104 shape) still behaves exactly as before.
    const legacy = finance.summarizeCancellationRows({
      rows: [cancelledVilla],
      refundedGroupIds: new Set(['grp-partial']),
    });
    assert.equal(legacy.refundedTotal, 6000);
  });

  it('splits a partially cancelled booking in the bookings-by-day list', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');
    const base = {
      booking_group_id: 'grp-mixed',
      check_in: '2026-08-20',
      check_out: '2026-08-22',
      adults: 4,
      kids_ages: [],
      total_price: 3000,
      payment_type: 'card',
      created_at: '2026-08-01T09:00:00.000Z',
      paid_at: '2026-08-01T09:30:00.000Z',
    };
    const groups = finance.groupBookedDayRows(finance.normalizeBookedDayRows([
      { ...base, id: 'kept-1', payment_status: 'paid', cancelled_at: null, rooms: { number: 2, type: 'small' } },
      { ...base, id: 'kept-2', payment_status: 'paid', cancelled_at: null, rooms: { number: 3, type: 'small' } },
      {
        ...base,
        id: 'dropped',
        payment_status: 'cancelled',
        cancelled_at: '2026-08-05T09:00:00.000Z',
        rooms: { number: 1, type: 'small' },
      },
    ]));

    // One entry per state: the live part at its own price, the cancelled villa
    // beside it. Merged, the booking read "anulată" (lowest villa number wins)
    // at the full 9000.
    assert.equal(groups.length, 2);
    const live = groups.find((group) => group.paymentStatus === 'paid');
    const cancelled = groups.find((group) => group.paymentStatus === 'cancelled');
    assert.equal(live.villas.length, 2);
    assert.equal(live.totalPrice, 6000);
    assert.equal(cancelled.villas.length, 1);
    assert.equal(cancelled.totalPrice, 3000);
  });

  it('exposes the partial-cancel call and complete refunded quotes through the shared client', () => {
    const supabase = read('js/supabase.js');
    assert.match(supabase, /async function partialCancelReservation/);
    assert.match(supabase, /invoke\('reservation-partial-cancel'/);
    assert.match(supabase, /partialCancelReservation,/);
    // refunded-groups now carries the real amount; a legacy string entry from an
    // older function build must still resolve to a usable row.
    assert.match(supabase, /grossAmount: null/);
    assert.match(supabase, /withheldCommission: 0/);
    assert.match(supabase, /Array\.isArray\(result\.data\?\.refunds\)/);
    assert.match(supabase, /refund_amount, refund_withheld/);
  });

  it('omits an undefined commission choice but forwards explicit false to both functions', async () => {
    const helpers = require('../js/supabase.js');
    const calls = [];
    const client = {
      functions: {
        async invoke(name, options) {
          calls.push({ name, body: options.body });
          return { data: { ok: true }, error: null };
        },
      },
    };

    await helpers.refundMaibPaymentRequest(client, { bookingGroupId: 'full-default' });
    await helpers.refundMaibPaymentRequest(client, {
      bookingGroupId: 'full-override',
      withholdCommission: false,
    });
    await helpers.partialCancelReservation(client, {
      bookingGroupId: 'partial-default',
      reservationIds: ['villa-1'],
      refundAmount: 3500,
    });
    await helpers.partialCancelReservation(client, {
      bookingGroupId: 'partial-override',
      reservationIds: ['villa-2'],
      refundAmount: 3500,
      withholdCommission: false,
    });

    assert.equal(Object.hasOwn(calls[0].body, 'withholdCommission'), false);
    assert.equal(calls[1].body.withholdCommission, false);
    assert.equal(Object.hasOwn(calls[2].body, 'withholdCommission'), false);
    assert.equal(calls[3].body.withholdCommission, false);
  });

  it('keeps refunded-groups readable by a CRM bundle the owner has not uploaded yet', () => {
    // Functions go live days before the manual TopHost upload. If the response
    // stopped being a plain id list, the CRM still running the old bundle would
    // build a Set of objects and report every refunded cancellation as "fără
    // rambursare" until the frontend catches up.
    const fn = read('supabase/functions/scheduled-refunds/index.ts');
    assert.match(fn, /groups: refunds\.map\(\(entry\) => entry\.bookingGroupId\), refunds/);
  });

  it('treats a typed 0 as "no refund" but rejects a typed 3500.5 as non-integer', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    // A number input reports garbage ("12e-") as an EMPTY value, which would
    // otherwise read as "no refund" and cancel villas while returning nothing.
    assert.match(dashboardJs, /if \(field\.validity\?\.badInput\) \{\s*return NaN;/);
    assert.match(dashboardJs, /!Number\.isInteger\(amount\)/);
    assert.match(dashboardJs, /Suma de reversat trebuie să fie un număr întreg pozitiv/);
    assert.match(dashboardJs, /return amount > 0 \? amount : null;/);
    // NaN is the only thing that blocks the button; null (no refund) is allowed.
    assert.match(
      dashboardJs,
      /submit\.disabled = !selected\.length \|\| !confirmed \|\| Number\.isNaN\(amount\);/,
    );
  });

  it('drops the previous booking\'s submit handler when the control is unavailable', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    // The handler closes over the villas of the booking it was built for.
    assert.match(dashboardJs, /if \(staleSubmit\) staleSubmit\.onclick = null;/);
  });

  it('re-checks the confirmation word at submit time, not only when the button was enabled', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    // A failed attempt re-enables the button; the word could have been cleared
    // (or the dialog reopened on another booking) while the request was in flight.
    assert.match(dashboardJs, /if \(confirmWord !== PARTIAL_CONFIRM_WORD\)/);
    // And the failure path re-derives the button state instead of blindly enabling.
    assert.match(dashboardJs, /showError\(message\.slice\(0, 220\)\);\s*\n[\s\S]{0,220}refreshPartialCancel\(section, context\);/);
  });

  it('measures the unrefundable remainder against the whole payment, not the live villas', () => {
    const dashboardJs = read('admin/js/crm-dashboard.js');
    // One MAIB payment covered every villa, including any dropped earlier
    // without a refund — counting only the live ones understated what stays
    // stuck on that payment.
    assert.match(dashboardJs, /const paidTotal = partialCancelGroup\(reservation\)\.reduce/);
    assert.match(dashboardJs, /row\.payment_status === 'paid' \|\| row\.cancelled_at/);
  });

  it('claims the payment\'s single refund slot in the same transaction as the cancellation', () => {
    const migration = read('supabase/migrations/20260811120000_partial_cancellation.sql');
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');

    // Checking for an existing refund in the function and then executing is
    // check-then-act: a guest cancellation scheduling its own refund in that
    // window would be overwritten with the staff amount and paid out at once.
    assert.match(migration, /insert into public\.maib_refunds/);
    assert.match(migration, /on conflict \(pay_id\) do update set/);
    assert.match(migration, /where public\.maib_refunds\.status = 'cancelled'/);
    assert.match(migration, /A refund already exists for payment/);
    assert.match(fn, /p_refund_pay_id: refund\.payment\?\.pay_id \?\? null/);
    // Due-dated a few minutes out so the reconcile cron finishes the payout if
    // this function dies after the cancellation commits.
    assert.match(fn, /p_refund_eligible_at: refund\.payment/);
    assert.match(fn, /REFUND_RECOVERY_DELAY_MS/);
  });

  it('refuses a payment already marked refunded even with no refund row to read', () => {
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');
    // Manual reconciliation marks the payment without writing maib_refunds.
    // Calling MAIB again returns REVERSED, which the engine reads as success —
    // we would report money as returned that never moved.
    assert.match(fn, /String\(payment\.status \|\| ''\) === 'refunded'/);
  });

  it('refuses to cancel while a checkout session is open with the provider', () => {
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');
    // maib-create-payment inserts the payment row BEFORE stamping
    // payment_in_progress, so the reservation flag alone leaves a window in
    // which a checkout for the original amount is already live.
    assert.match(fn, /async function assertNoOpenPaymentSession/);
    assert.match(fn, /\.in\('status', \['created', 'pending'\]\)/);
    assert.match(fn, /await assertNoOpenPaymentSession\(client, bookingGroupId\)/);
  });

  it('tells staff when an add-guests payment lands on a change that no longer applies', () => {
    const callback = read('supabase/functions/maib-callback/index.ts');
    // The money is captured and nothing downstream acts on it — a console line
    // is not a person. More likely now that a partial cancellation supersedes
    // open changes while a card checkout for one may still be payable.
    assert.match(callback, /sendStaffAlert\('Plată „adaugă oaspeți" fără efect'/);
    assert.match(callback, /Banii trebuie restituiți manual/);
  });

  it('names the refunded sum even when staff cancel every villa', () => {
    const notifications = read('supabase/functions/_shared/notifications.ts');
    const fn = read('supabase/functions/reservation-partial-cancel/index.ts');
    // Ticking all the villas is a full cancellation that still returned a
    // hand-typed sum; the ordinary cancellation copy had no refund line.
    assert.match(
      notifications,
      /refundAmount\?: number \| null;\s*\n\s*withheldCommission\?: number \| null;/,
    );
    assert.match(
      fn,
      /refundAmount: input\.refundQuote\?\.net,\s*\n\s*withheldCommission: input\.refundQuote\?\.withheld/,
    );
  });

  it('stops calling a still-live booking "refunded" on the guest manage page', () => {
    const gestionare = read('js/gestionare.js');
    // After a partial refund the payment reads 'refunded' while the guest still
    // has live paid villas — badging those as "Rambursată" says their remaining
    // stay is off, and contradicts the confirmation page.
    assert.match(gestionare, /const stillBooked = summary\.paymentStatus === 'paid'/);
    assert.match(gestionare, /if \(!stillBooked && \(payment\?\.status === 'refunded'/);
  });

  it('summarizes finance rows with standalone payment links in MODE_PAID only', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js');

    // In MODE_PAID: link rows fold into commercialTotal, onlineTotal, and linksTotal
    const summaryPaid = finance.summarizeFinanceRows({
      mode: 'paid',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-06-01',
      rows: [
        {
          id: 'res-1',
          room_id: 'room-1',
          check_in: '2026-05-10',
          check_out: '2026-05-12',
          total_price: 3000,
          payment_type: 'card',
          payment_status: 'paid',
          paid_at: '2026-05-05T10:00:00.000Z',
          rooms: { type: 'small' },
        },
      ],
      changeRows: [
        {
          id: 'change-1',
          booking_group_id: 'res-1',
          difference_amount: 500,
          paid_at: '2026-05-06T10:00:00.000Z',
          room_type: 'small',
        },
      ],
      linkRows: [
        {
          id: 'link-1',
          amount: 2000,
          paid_amount: 2000,
          paid_at: '2026-05-15T12:00:00.000Z',
          payment_rail: 'mia',
        },
        {
          id: 'link-2-refunded',
          amount: 1500,
          paid_amount: 1500,
          refunded_amount: 500,
          paid_at: '2026-05-20T12:00:00.000Z',
          payment_rail: 'card',
        },
        {
          id: 'link-3-full-refund',
          amount: 1000,
          paid_amount: 1000,
          refunded_amount: 1000,
          paid_at: '2026-05-22T12:00:00.000Z',
          payment_rail: 'mia',
        },
        {
          id: 'link-out-of-range',
          amount: 5000,
          paid_amount: 5000,
          paid_at: '2026-06-05T12:00:00.000Z',
          payment_rail: 'mia',
        },
      ],
    });

    assert.equal(summaryPaid.commercialTotal, 6500);
    assert.equal(summaryPaid.onlineTotal, 6500);
    assert.equal(summaryPaid.linksTotal, 3000);
    assert.equal(summaryPaid.paidBookings, 1);
    assert.equal(summaryPaid.averageBookingValue, 3500);
    assert.equal(summaryPaid.occupiedNights, 2);
    assert.equal(summaryPaid.roomTypeTotals.small, 3500);

    // In MODE_NIGHTS: links are completely absent
    const summaryNights = finance.summarizeFinanceRows({
      mode: 'nights',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-06-01',
      rows: [
        {
          id: 'res-1',
          room_id: 'room-1',
          check_in: '2026-05-10',
          check_out: '2026-05-12',
          total_price: 3000,
          payment_type: 'card',
          payment_status: 'paid',
          paid_at: '2026-05-05T10:00:00.000Z',
          rooms: { type: 'small' },
        },
      ],
      linkRows: [
        {
          id: 'link-1',
          amount: 2000,
          paid_amount: 2000,
          paid_at: '2026-05-15T12:00:00.000Z',
          payment_rail: 'mia',
        },
      ],
    });

    assert.equal(summaryNights.commercialTotal, 3000);
    assert.equal(summaryNights.onlineTotal, 3000);
    assert.equal(summaryNights.linksTotal, 0);
    assert.equal(summaryNights.averageBookingValue, 3000);
  });

  it('provides payment link admin helpers in js/supabase.js', async () => {
    const { EcoVilaSupabase: supabase } = loadAdminModule('js/supabase.js');

    assert.equal(typeof supabase.createPaymentLink, 'function');
    assert.equal(typeof supabase.listPaymentLinks, 'function');
    assert.equal(typeof supabase.revokePaymentLink, 'function');
    assert.equal(typeof supabase.markPaymentLinkRefunded, 'function');
    assert.equal(typeof supabase.fetchFinancePaymentLinks, 'function');

    const calls = [];
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      not() { return builder; },
      gte() { return builder; },
      lt() { return builder; },
      order() { return builder; },
      range() { return Promise.resolve({ data: [{ id: 'link-1', paid_amount: 1000 }] }); },
    };
    const mockClient = {
      functions: {
        async invoke(name, options) {
          calls.push({ name, options });
          return { data: { ok: true } };
        },
      },
      from(table) {
        return builder;
      },
    };

    await supabase.createPaymentLink(mockClient, {
      amount: 1500,
      paymentRail: 'mia',
      expiresInHours: 3,
      label: 'Avans',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
      name: 'payment-link-admin',
      options: {
        body: {
          action: 'create',
          amount: 1500,
          paymentRail: 'mia',
          expiresInHours: 3,
          label: 'Avans',
        },
      },
    });

    await supabase.listPaymentLinks(mockClient, { limit: 20 });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
      name: 'payment-link-admin',
      options: {
        body: {
          action: 'list',
          limit: 20,
        },
      },
    });

    await supabase.revokePaymentLink(mockClient, { id: 'test-link-id' });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), {
      name: 'payment-link-admin',
      options: {
        body: {
          action: 'revoke',
          id: 'test-link-id',
        },
      },
    });

    await supabase.markPaymentLinkRefunded(mockClient, {
      id: 'test-link-id',
      amount: 1000,
      note: 'Restituire cash',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(calls[3])), {
      name: 'payment-link-admin',
      options: {
        body: {
          action: 'markRefunded',
          id: 'test-link-id',
          amount: 1000,
          note: 'Restituire cash',
        },
      },
    });

    const financeRows = await supabase.fetchFinancePaymentLinks(mockClient, {
      rangeStart: '2026-05-01',
      rangeEnd: '2026-06-01',
    });
    assert.equal(financeRows.length, 1);
    assert.equal(financeRows[0].id, 'link-1');
  });

  it('exports EcoVilaCrmPaymentLinks module and handles UI contracts', () => {
    const { EcoVilaCrmPaymentLinks: mod } = loadAdminModule('admin/js/crm-payment-links.js', {
      EcoVilaPricing: pricing,
    });

    assert.equal(typeof mod.init, 'function');
    assert.equal(typeof mod.showPanel, 'function');
    assert.equal(typeof mod.loadLinks, 'function');
    assert.equal(typeof mod.renderLinkList, 'function');
    assert.equal(typeof mod.formatMDL, 'function');
    assert.equal(typeof mod.formatCreatedAt, 'function');
  });

  it('keeps payment-link presentation out of the JavaScript module', () => {
    const moduleSource = read('admin/js/crm-payment-links.js');

    assert.doesNotMatch(moduleSource, /\.style\./, 'payment-link JavaScript must not assign inline styles');
    assert.doesNotMatch(moduleSource, /#[0-9a-f]{3,8}\b/i, 'payment-link JavaScript must not contain raw hex colours');
    // No other CRM module uses emoji; the manual-review strip carries its urgency
    // through the --crm-danger rail and pill, not a glyph.
    assert.doesNotMatch(
      moduleSource,
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u,
      'payment-link JavaScript must not use emoji markers',
    );
  });

  it('wires payment-links tab and panel in admin/dashboard.html and admin/js/crm-app.js', () => {
    const html = read('admin/dashboard.html');
    const app = read('admin/js/crm-app.js');

    // Tab button placed right after Finance tab
    assert.match(
      html,
      /<button class="crm-tab" type="button" data-tab="finance">Finance<\/button>\s*\n\s*<button class="crm-tab" type="button" data-tab="payment-links">Linkuri de plată<\/button>/,
    );

    // Panel placed right after Finance panel
    assert.match(
      html,
      /<\/section>\s*\n\s*<section class="crm-panel" data-panel="payment-links"/,
    );

    // Script tag placed before crm-auth.js. The ?v= token is bumped every release
    // (ADR-067), so match any stamp rather than pinning one.
    assert.match(
      html,
      /<script src="js\/crm-payment-links\.js\?v=\d+"><\/script>\s*\n\s*<script src="js\/crm-auth\.js/,
    );

    // TAB_NAMES contains payment-links
    assert.match(app, /'payment-links'/);
    // ROLE_TABS.angela does NOT contain payment-links (Diana-only)
    assert.doesNotMatch(app, /angela:\s*\[[^\]]*'payment-links'[^\]]*\]/);
  });

  it('paginates payment links using the nextBefore cursor and appends subsequent pages', async () => {
    const page1Links = Array.from({ length: 50 }, (_, i) => ({
      id: `link-p1-${i + 1}`,
      amount: 1000 + i * 10,
      paymentRail: 'card',
      status: 'paid',
      effectiveStatus: 'paid',
      createdAt: `2026-08-20T12:${String(i).padStart(2, '0')}:00Z`,
      payUrl: `https://ecovila.md/plata.html?p=link-p1-${i + 1}`,
    }));

    const page2Links = Array.from({ length: 15 }, (_, i) => ({
      id: `link-p2-${i + 1}`,
      amount: 2000 + i * 10,
      paymentRail: 'mia',
      status: 'paid',
      effectiveStatus: 'paid',
      createdAt: `2026-08-19T10:${String(i).padStart(2, '0')}:00Z`,
      payUrl: `https://ecovila.md/plata.html?p=link-p2-${i + 1}`,
    }));

    const listCalls = [];
    const mockSupabase = {
      listPaymentLinks: async (_client, params) => {
        listCalls.push(params);
        if (params.before === '2026-08-20T12:00:00Z') {
          return { ok: true, links: page2Links, nextBefore: null };
        }
        return { ok: true, links: page1Links, nextBefore: '2026-08-20T12:00:00Z' };
      },
    };

    const elements = new Map();
    function register(selector, tagName = 'div') {
      const el = createFakeElement(tagName);
      elements.set(selector, el);
      return el;
    }

    const list = register('[data-link-list]', 'div');
    const empty = register('[data-link-empty]', 'p');
    register('[data-link-create-form]', 'form');
    register('[data-link-amount]', 'input');
    register('[data-link-label]', 'input');
    register('[data-link-create]', 'button');
    register('[data-link-create-error]', 'p');
    register('[data-link-result]', 'div');
    register('[data-link-url]', 'input');
    register('[data-link-copy]', 'button');
    register('[data-link-open]', 'a');
    register('[data-link-rail-hint]', 'p');

    const container = createFakeElement('section');
    list.parentNode = container;
    container.children = [list, empty];
    container.insertBefore = function (newChild, refChild) {
      const idx = this.children.indexOf(refChild);
      if (idx >= 0) this.children.splice(idx, 0, newChild);
      else this.children.push(newChild);
      newChild.parentNode = this;
      return newChild;
    };

    const fakeDoc = {
      createElement(tag) {
        return createFakeElement(tag);
      },
      querySelector(sel) {
        if (elements.has(sel)) return elements.get(sel);
        if (sel === '[data-link-load-more]') {
          return container.children.find((c) => c.dataset?.linkLoadMore !== undefined) || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-link-rail]' || sel === '[data-link-expiry]') return [];
        if (elements.has(sel)) return [elements.get(sel)];
        return [];
      },
    };

    const { EcoVilaCrmPaymentLinks: mod } = loadAdminModule('admin/js/crm-payment-links.js', {
      EcoVilaPricing: pricing,
      EcoVilaSupabase: mockSupabase,
      document: fakeDoc,
    });

    mod.init({ client: { id: 'test-client' } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(listCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(listCalls[0])), { limit: 50 });
    assert.equal(mod.state.links.length, 50);
    assert.equal(list.children.length, 50);
    assert.equal(mod.state.nextBefore, '2026-08-20T12:00:00Z');

    const loadMoreBtn = fakeDoc.querySelector('[data-link-load-more]');
    assert.ok(loadMoreBtn, 'Load more button must be rendered');
    assert.equal(loadMoreBtn.hidden, false, 'Load more button must be visible when nextBefore exists');
    assert.equal(loadMoreBtn.textContent, 'Încarcă mai multe');

    // Click load more button to fetch page 2
    loadMoreBtn.click();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(listCalls.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(listCalls[1])), { limit: 50, before: '2026-08-20T12:00:00Z' });
    assert.equal(mod.state.links.length, 65, 'Page 2 items must be appended to list');
    assert.equal(list.children.length, 65);
    assert.equal(mod.state.nextBefore, null);
    assert.equal(loadMoreBtn.hidden, true, 'Load more button must be hidden when nextBefore is null');
  });

  it('keeps refund action available after partial refund and caps new total at paidAmount', async () => {
    const refundCalls = [];
    const mockSupabase = {
      listPaymentLinks: async () => ({ ok: true, links: [] }),
      markPaymentLinkRefunded: async (_client, payload) => {
        refundCalls.push(payload);
        return {
          ok: true,
          link: {
            id: payload.id,
            status: 'paid',
            effectiveStatus: 'paid',
            amount: 1000,
            paidAmount: 1000,
            refundedAmount: payload.amount,
            refundedAt: '2026-08-27T10:00:00Z',
            refundNote: payload.note,
          },
        };
      },
    };

    const elements = new Map();
    function register(selector, tagName = 'div') {
      const el = createFakeElement(tagName);
      elements.set(selector, el);
      return el;
    }

    const list = register('[data-link-list]', 'div');
    const empty = register('[data-link-empty]', 'p');
    register('[data-link-create-form]', 'form');
    register('[data-link-amount]', 'input');
    register('[data-link-label]', 'input');
    register('[data-link-create]', 'button');
    register('[data-link-create-error]', 'p');
    register('[data-link-result]', 'div');
    register('[data-link-url]', 'input');
    register('[data-link-copy]', 'button');
    register('[data-link-open]', 'a');
    register('[data-link-rail-hint]', 'p');

    const refundDialog = register('[data-link-refund-dialog]', 'dialog');
    const refundForm = register('[data-link-refund-form]', 'form');
    const refundAmountInput = register('[data-link-refund-amount]', 'input');
    const refundNoteInput = register('[data-link-refund-note]', 'input');
    const refundError = register('[data-link-refund-error]', 'p');
    const refundCancel = register('[data-link-refund-cancel]', 'button');
    const refundSubmit = register('[data-link-refund-submit]', 'button');

    const labelSpan = createFakeElement('span');
    const amountLabel = createFakeElement('label');
    amountLabel.children = [labelSpan, refundAmountInput];
    amountLabel.querySelector = (sel) => (sel === 'span' ? labelSpan : null);
    refundAmountInput.closest = (sel) => (sel === 'label' ? amountLabel : null);

    refundDialog.showModal = () => {};
    refundDialog.close = () => {};

    let submitHandler = null;
    refundForm.addEventListener = function (eventName, handler) {
      if (eventName === 'submit') submitHandler = handler;
    };

    const container = createFakeElement('section');
    list.parentNode = container;
    container.children = [list, empty];

    const fakeDoc = {
      createElement(tag) {
        return createFakeElement(tag);
      },
      querySelector(sel, scope) {
        if (scope && scope === refundDialog) {
          if (sel === '[data-link-refund-amount]') return refundAmountInput;
          if (sel === '[data-link-refund-note]') return refundNoteInput;
          if (sel === '[data-link-refund-error]') return refundError;
        }
        if (elements.has(sel)) return elements.get(sel);
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '[data-link-rail]' || sel === '[data-link-expiry]') return [];
        if (elements.has(sel)) return [elements.get(sel)];
        return [];
      },
    };

    refundDialog.querySelector = (sel) => fakeDoc.querySelector(sel, refundDialog);
    refundDialog.querySelectorAll = (sel) => fakeDoc.querySelectorAll(sel);

    const { EcoVilaCrmPaymentLinks: mod } = loadAdminModule('admin/js/crm-payment-links.js', {
      EcoVilaPricing: pricing,
      EcoVilaSupabase: mockSupabase,
      document: fakeDoc,
      confirm: () => true,
    });

    mod.init({ client: { id: 'test-client' } });
    await new Promise((resolve) => setImmediate(resolve));

    // Link with 1000 MDL paid, 400 MDL partially refunded
    const link = {
      id: 'link-partial-1',
      status: 'paid',
      effectiveStatus: 'paid',
      amount: 1000,
      paidAmount: 1000,
      refundedAmount: 400,
      refundedAt: '2026-08-25T10:00:00Z',
      refundNote: 'Avans anulat parțial',
      payUrl: 'https://ecovila.md/plata.html?p=link-partial-1',
    };

    mod.state.links = [link];
    mod.renderLinkList();

    // 1. Assert card renders with refund action button
    const card = list.children[0];
    assert.ok(card);
    const refundBtn = card.children.flatMap((c) => c.children || []).find((c) => c.dataset?.action === 'refund');
    assert.ok(refundBtn, 'Refund button must be present for partially refunded link');

    // 2. Open refund dialog: pre-fills with recorded 400 and caps at 1000
    refundBtn.click();
    assert.equal(refundAmountInput.value, '400', 'Pre-fills with existing cumulative refund');
    assert.equal(refundAmountInput.max, '1000', 'Capped at paidAmount');
    assert.match(labelSpan.textContent, /Total nou restituit/i);

    // 3. Attempting to refund more than 1000 is blocked by form validation
    refundAmountInput.value = '1200';
    submitHandler?.({ preventDefault() {} });
    assert.equal(refundCalls.length, 0, 'Must not submit refund above paidAmount');
    assert.equal(refundError.hidden, false);

    // 4. Record new total refund of 1000 (remaining 600)
    refundAmountInput.value = '1000';
    refundNoteInput.value = 'Restituire integrală finalizată';
    await submitHandler?.({ preventDefault() {} });

    assert.equal(refundCalls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(refundCalls[0])), {
      id: 'link-partial-1',
      amount: 1000,
      note: 'Restituire integrală finalizată',
    });

    // 5. Fully refunded link (1000 / 1000) no longer renders refund action
    const updatedCard = list.children[0];
    const updatedRefundBtn = updatedCard.children.flatMap((c) => c.children || []).find((c) => c.dataset?.action === 'refund');
    assert.equal(updatedRefundBtn, undefined, 'Refund action must be hidden after 100% refund');
  });

  it('implements ADR-107 bound link helpers and effectiveTotal in crm-calendar.js', () => {
    const { EcoVilaCrmCalendar: cal } = loadAdminModule('admin/js/crm-calendar.js', {
      EcoVilaPricing: pricing,
    });

    assert.equal(typeof cal.boundLinkNet, 'function');
    assert.equal(typeof cal.effectiveTotal, 'function');
    assert.equal(typeof cal.pendingDifference, 'function');

    // boundLinkNet calculations (strictly require purpose and positive integer paid_amount)
    assert.equal(cal.boundLinkNet(null), 0);
    assert.equal(cal.boundLinkNet({ status: 'active', amount: 500, purpose: 'accommodation_difference' }), 0, 'unpaid link net is 0');
    assert.equal(cal.boundLinkNet({ status: 'revoked', amount: 500, purpose: 'accommodation_difference' }), 0, 'revoked link net is 0');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 500, purpose: 'accommodation_difference' }), 500);
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 500, refunded_amount: 200, purpose: 'accommodation_difference' }), 300);
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 500, refunded_amount: 500, purpose: 'accommodation_difference' }), 0);
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 500, purpose: 'standalone' }), 0, 'standalone link is not a bound link');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 500 }), 0, 'link without purpose is not a bound link');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, purpose: 'accommodation_difference' }), 0, 'link without paid_amount is 0');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: null, purpose: 'accommodation_difference' }), 0, 'null paid_amount is 0');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 0, purpose: 'accommodation_difference' }), 0, 'zero paid_amount is 0');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: -50, purpose: 'accommodation_difference' }), 0, 'negative paid_amount is 0');
    assert.equal(cal.boundLinkNet({ status: 'paid', amount: 500, paid_amount: 'abc', purpose: 'accommodation_difference' }), 0, 'non-integer paid_amount is 0');

    // pendingDifference calculations (exclude expired, revoked, paid, standalone, and purposeless links)
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    const pastExpiry = '2020-01-01T00:00:00.000Z';
    assert.equal(cal.pendingDifference([]), 0);
    assert.equal(cal.pendingDifference([{ status: 'active', amount: 400, purpose: 'accommodation_difference' }]), 400);
    assert.equal(cal.pendingDifference([{ status: 'active', amount: 400, purpose: 'accommodation_difference', expires_at: futureExpiry }]), 400);
    assert.equal(cal.pendingDifference([{ status: 'active', amount: 400, purpose: 'accommodation_difference', expires_at: pastExpiry }]), 0, 'expired link is excluded');
    assert.equal(cal.pendingDifference([{ status: 'active', amount: 400, purpose: 'accommodation_difference', revoked_at: '2026-08-01T00:00:00.000Z' }]), 0, 'revoked_at link is excluded');
    assert.equal(cal.pendingDifference([{ status: 'revoked', amount: 400, purpose: 'accommodation_difference' }]), 0, 'status revoked link is excluded');
    assert.equal(cal.pendingDifference([{ status: 'expired', amount: 400, purpose: 'accommodation_difference' }]), 0, 'status expired link is excluded');
    assert.equal(cal.pendingDifference([{ status: 'active', amount: 400 }]), 0, 'link without purpose is excluded');
    assert.equal(cal.pendingDifference([
      { status: 'active', amount: 400, purpose: 'accommodation_difference' },
      { status: 'active', amount: 700, purpose: 'accommodation_difference', expires_at: pastExpiry },
      { status: 'active', amount: 800, purpose: 'accommodation_difference', revoked_at: '2026-08-01T00:00:00.000Z' },
      { status: 'paid', amount: 600, paid_amount: 600, purpose: 'accommodation_difference' },
      { status: 'active', amount: 300, purpose: 'standalone' },
    ]), 400);

    // effectiveTotal calculations
    const live1 = { id: 'res-1', total_price: 3000, payment_status: 'paid' };
    const live2 = { id: 'res-2', total_price: 3000, payment_status: 'paid' };
    const cancelled = { id: 'res-3', total_price: 3000, payment_status: 'cancelled', cancelled_at: '2026-08-01' };

    const boundLink1 = { id: 'l1', reservation_id: 'res-1', status: 'paid', paid_amount: 500, purpose: 'accommodation_difference' };
    const boundLinkCancelled = { id: 'l2', reservation_id: 'res-3', status: 'paid', paid_amount: 800, purpose: 'accommodation_difference' };
    const unpaidLink = { id: 'l3', reservation_id: 'res-2', status: 'active', amount: 400, purpose: 'accommodation_difference' };
    const linkNoPurpose = { id: 'l4', reservation_id: 'res-1', status: 'paid', paid_amount: 500 };
    const linkStandalone = { id: 'l5', reservation_id: 'res-1', status: 'paid', paid_amount: 500, purpose: 'standalone' };
    const linkNoPaidAmount = { id: 'l6', reservation_id: 'res-1', status: 'paid', amount: 500, purpose: 'accommodation_difference' };

    assert.equal(
      cal.effectiveTotal([live1, live2, cancelled], [boundLink1, boundLinkCancelled, unpaidLink, linkNoPurpose, linkStandalone, linkNoPaidAmount]),
      6500, // 3000 + 3000 + 500 (cancelled villa link, unpaid link, purposeless link, standalone link, and link without paid_amount excluded)
    );
  });

  it('chunks difference-link reads so a busy calendar cannot blow the request URL', async () => {
    // Every id travels inside a PostgREST `in.(...)` filter in the URL. A three
    // month window holds hundreds of reservations; at ~900 ids the request is
    // ~33KB and the gateway answered 400, which surfaced in the CRM as a failed
    // read and stamped every calendar card. Chunking keeps each request small.
    const { EcoVilaSupabase: supabase } = loadAdminModule('js/supabase.js');

    for (const helper of ['fetchReservationDifferenceLinks', 'fetchRefundedBoundLinkAmounts']) {
      const batches = [];
      const mockBuilder = {
        select() { return mockBuilder; },
        eq() { return mockBuilder; },
        gt() { return mockBuilder; },
        in(_column, values) { batches.push(values.length); return mockBuilder; },
        order() { return mockBuilder; },
        range() { return Promise.resolve({ data: [] }); },
      };
      const mockClient = { from() { return mockBuilder; } };
      const ids = Array.from({ length: 950 }, (_, index) => `res-${index}`);

      await supabase[helper](mockClient, { reservationIds: ids });

      assert.ok(batches.length > 1, `${helper} must split a 950-id read into several requests`);
      assert.equal(batches.reduce((sum, size) => sum + size, 0), 950, `${helper} must cover every id`);
      assert.ok(
        batches.every((size) => size <= 200),
        `${helper} must keep each request within the chunk size`,
      );
    }
  });

  it('implements ADR-107 Supabase helpers for difference links and refunded amounts', async () => {
    const { EcoVilaSupabase: supabase } = loadAdminModule('js/supabase.js');

    assert.equal(typeof supabase.fetchReservationDifferenceLinks, 'function');
    assert.equal(typeof supabase.fetchRefundedBoundLinkAmounts, 'function');

    const selectCalls = [];
    const mockBuilder = {
      select(cols) { selectCalls.push(cols); return mockBuilder; },
      eq() { return mockBuilder; },
      gt() { return mockBuilder; },
      in() { return mockBuilder; },
      order() { return mockBuilder; },
      range() { return Promise.resolve({ data: [{ id: 'diff-1', paid_amount: 500 }] }); },
    };
    const mockClient = {
      from() { return mockBuilder; },
    };

    const diffRows = await supabase.fetchReservationDifferenceLinks(mockClient, {
      reservationIds: ['res-1', 'res-2'],
    });
    assert.equal(diffRows.length, 1);
    assert.equal(diffRows[0].id, 'diff-1');
    assert.match(selectCalls[0], /purpose/);
    assert.match(selectCalls[0], /reservation_id/);
    assert.match(selectCalls[0], /booking_group_id/);
    assert.match(selectCalls[0], /room_type/);

    const refundedBoundRows = await supabase.fetchRefundedBoundLinkAmounts(mockClient, {
      bookingGroupIds: ['grp-1'],
    });
    assert.equal(refundedBoundRows.length, 1);
  });

  it('partitions bound accommodation_difference links in Finance summary and single-day cards', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      EcoVilaPricing: pricing,
    });

    const summary = finance.summarizeFinanceRows({
      mode: 'paid',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-06-01',
      rows: [
        {
          id: 'res-1',
          booking_group_id: 'grp-1',
          room_id: 'room-1',
          check_in: '2026-05-10',
          check_out: '2026-05-12',
          total_price: 3000,
          payment_type: 'card',
          payment_status: 'paid',
          paid_at: '2026-05-05T10:00:00.000Z',
          rooms: { type: 'small' },
        },
      ],
      linkRows: [
        // Standalone link
        {
          id: 'link-standalone',
          amount: 2000,
          status: 'paid',
          paid_amount: 2000,
          paid_at: '2026-05-15T12:00:00.000Z',
          payment_rail: 'mia',
          purpose: 'standalone',
        },
        // Accommodation difference link
        {
          id: 'link-diff',
          booking_group_id: 'grp-1',
          reservation_id: 'res-1',
          room_type: 'small',
          amount: 500,
          status: 'paid',
          paid_amount: 500,
          paid_at: '2026-05-16T12:00:00.000Z',
          payment_rail: 'card',
          purpose: 'accommodation_difference',
        },
        // Refunded difference link
        {
          id: 'link-diff-refunded',
          booking_group_id: 'grp-1',
          reservation_id: 'res-1',
          room_type: 'small',
          amount: 400,
          status: 'paid',
          paid_amount: 400,
          refunded_amount: 100,
          paid_at: '2026-05-18T12:00:00.000Z',
          payment_rail: 'card',
          purpose: 'accommodation_difference',
        },
        // Link with amount but missing paid_amount (must contribute 0)
        {
          id: 'link-diff-unpaid-amount',
          booking_group_id: 'grp-1',
          reservation_id: 'res-1',
          room_type: 'small',
          amount: 999,
          status: 'paid',
          paid_at: '2026-05-19T12:00:00.000Z',
          purpose: 'accommodation_difference',
        },
      ],
    });

    // commercialTotal = 3000 (res) + 2000 (standalone) + 500 (diff) + 300 (diff net 400-100) = 5800
    assert.equal(summary.commercialTotal, 5800);
    assert.equal(summary.onlineTotal, 5800);
    // linksTotal contains ONLY standalone links = 2000
    assert.equal(summary.linksTotal, 2000);
    // paidBookings deduped by booking_group_id = 1
    assert.equal(summary.paidBookings, 1);
    // averageBookingValue numerator includes res + diff links = (3000 + 500 + 300) / 1 = 3800
    assert.equal(summary.averageBookingValue, 3800);
    // roomTypeTotals.small includes res + diff links = 3000 + 500 + 300 = 3800
    assert.equal(summary.roomTypeTotals.small, 3800);
    assert.equal(summary.occupiedNights, 2);
  });

  it('handles cancellation list with bound link refunds in crm-finance.js', () => {
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      EcoVilaPricing: pricing,
    });

    const cancelledRow = {
      id: 'res-cancel-1',
      booking_group_id: 'grp-cancel-1',
      check_in: '2026-05-10',
      check_out: '2026-05-12',
      total_price: 3000,
      payment_type: 'card',
      payment_status: 'cancelled',
      paid_at: '2026-05-01T10:00:00.000Z',
      cancelled_at: '2026-05-02T10:00:00.000Z',
      rooms: { number: 1, type: 'small' },
    };

    const boundLinksMap = new Map([
      ['res-cancel-1', [{ amount: 500, grossAmount: 500, withheldCommission: 0 }]],
    ]);

    const summary = finance.summarizeCancellationRows({
      rows: [cancelledRow],
      refundedGroupIds: new Map([
        ['grp-cancel-1', { amount: 3000, grossAmount: 3000, withheldCommission: 0 }],
      ]),
      refundedChangesByGroup: new Map(),
      refundedBoundLinksByReservation: boundLinksMap,
    });

    assert.equal(summary.count, 1);
    assert.equal(summary.refundedTotal, 3500); // 3000 base + 500 bound link
    assert.equal(summary.grossTotal, 3500);
  });

  it('implements ADR-107 daily supplement honest quoting and refuses repricing in crm-daily.js', async () => {
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      EcoVilaPricing: pricing,
      EcoVilaCrmCalendar: loadAdminModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing }).EcoVilaCrmCalendar,
      EcoVilaCrmSidebar: {
        calculateStaffTotal: () => ({ total: 4000 }),
        splitTotalPrice: (total) => [total],
      },
    });

    const res = {
      id: 'res-upgrade-1',
      booking_group_id: 'grp-upgrade-1',
      check_in: '2026-05-10',
      check_out: '2026-05-12',
      adults: 2,
      kids_ages: [],
      total_price: 3000,
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'large' },
    };

    const diffLink = {
      id: 'link-diff-1',
      booking_group_id: 'grp-upgrade-1',
      reservation_id: 'res-upgrade-1',
      purpose: 'accommodation_difference',
      status: 'paid',
      paid_amount: 1000,
    };

    // Calculate supplement with paid difference link: effective total is 3000 + 1000 = 4000
    // Staff total for large room is 4000 => balance is 4000 - 4000 = 0 MDL supplement!
    const quote = daily.calculateDailySupplement({
      reservations: [res],
      reservation: res,
      adults: 2,
      childBuckets: [],
      differenceLinks: [diffLink],
      pricingTiers: [],
      holidays: [],
    });

    assert.equal(quote.existingTotal, 4000, 'existingTotal must be the effective total');
    assert.equal(quote.quotedTotal, 4000);
    assert.equal(quote.supplement, 0, 'reception must NOT be told to collect already-paid difference');

    // saveDailyGuestEdit must refuse repricing when booking carries an accommodation_difference link
    const fakeState = {
      editor: {
        reservation: res,
        childBuckets: [],
        differenceLinks: [diffLink],
      },
      reservations: [res],
      differenceLinks: [diffLink],
    };

    await assert.rejects(
      () => daily.saveDailyGuestEdit({ client: {} }, fakeState),
      /diferență de cazare emisă prin link de plată/i,
      'saveDailyGuestEdit must refuse repricing with clear Romanian reason',
    );

    // Fail-closed guard: saveDailyGuestEdit must refuse repricing when difference link read failed
    const errorState = {
      editor: {
        reservation: res,
        childBuckets: [],
      },
      reservations: [res],
      differenceLinks: [],
      differenceLinksError: new Error('RLS denied'),
    };

    await assert.rejects(
      () => daily.saveDailyGuestEdit({ client: {} }, errorState),
      /Verificarea diferențelor de cazare a eșuat/i,
      'saveDailyGuestEdit must refuse repricing when differenceLinksError is set (fail-closed)',
    );

    // loadDaily records differenceLinksError on failure and refuses repricing
    const mockClientWithError = {};
    const mockSupabase = {
      fetchAdminReservations: () => Promise.resolve([res]),
      fetchPricingTiers: () => Promise.resolve([]),
      fetchHolidays: () => Promise.resolve([]),
      fetchDailyStatuses: () => Promise.resolve([]),
      fetchReservationDifferenceLinks: () => Promise.reject(new Error('Network error')),
    };

    const { EcoVilaCrmDaily: dailyWithMock } = loadAdminModule('admin/js/crm-daily.js', {
      EcoVilaPricing: pricing,
      EcoVilaSupabase: mockSupabase,
      EcoVilaCrmCalendar: loadAdminModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing }).EcoVilaCrmCalendar,
    });

    const stateFromLoad = {
      selectedDate: '2026-05-10',
      reservations: [],
      checkIns: [],
      checkOuts: [],
      statuses: [],
      differenceLinks: [],
      differenceLinksError: null,
    };

    await dailyWithMock.loadDaily({ client: mockClientWithError, formatDate: () => '' }, stateFromLoad);
    assert.ok(stateFromLoad.differenceLinksError, 'differenceLinksError must be captured');
    assert.equal(stateFromLoad.differenceLinks.length, 0, 'differenceLinks must be empty array');

    stateFromLoad.editor = {
      reservation: res,
      childBuckets: [],
    };

    await assert.rejects(
      () => dailyWithMock.saveDailyGuestEdit({ client: mockClientWithError }, stateFromLoad),
      /Verificarea diferențelor de cazare a eșuat/i,
      'saveDailyGuestEdit must refuse repricing following a failed loadDaily difference link read',
    );
  });

  it('ADR-107 Slice F: surfaces paid difference warning in full cancellation preflight ("Șterge rezervarea")', async () => {
    const deleteDiffWarning = createFakeElement('p');
    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.close = () => {};

    const fields = {
      '[data-edit-check-in]': createFakeElement('input'),
      '[data-edit-check-out]': createFakeElement('input'),
      '[data-edit-adults]': createFakeElement('input'),
      '[data-edit-kids-ages]': createFakeElement('input'),
      '[data-edit-name]': createFakeElement('input'),
      '[data-edit-phone]': createFakeElement('input'),
      '[data-edit-notes]': createFakeElement('textarea'),
      '[data-edit-payment]': createFakeElement('p'),
      '[data-edit-total]': createFakeElement('strong'),
      '[data-edit-total-breakdown]': createFakeElement('span'),
      '[data-edit-pending-difference]': createFakeElement('span'),
      '[data-delete-difference-warning]': deleteDiffWarning,
      '[data-delete-reservation]': createFakeElement('button'),
      '[data-refund-full-override]': createFakeElement('input'),
      '[data-send-payment-confirmation]': createFakeElement('button'),
    };
    dialog.querySelector = (selector) => fields[selector] || null;

    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing });
    let fetchedLinks = [];

    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: {
        createElement: createFakeElement,
        querySelector: (selector) => (selector === '[data-reservation-dialog]' ? dialog : null),
        querySelectorAll: () => [],
        addEventListener: () => {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: {
        formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`,
      },
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        fetchReservationDifferenceLinks: (_client, _options) => Promise.resolve(fetchedLinks),
      },
    });

    const res = {
      id: 'res-full-1',
      booking_group_id: 'grp-full-1',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      total_price: 3000,
      payment_type: 'card',
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };

    EcoVilaCrmDashboard.initStateForTests({
      context: { client: {}, formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL` },
      reservations: [res],
      differenceLinks: [],
      differenceLinksError: null,
      reload: async () => {},
    });

    // 1. With paid difference link (500 MDL)
    fetchedLinks = [
      {
        id: 'link-1',
        reservation_id: 'res-full-1',
        booking_group_id: 'grp-full-1',
        purpose: 'accommodation_difference',
        status: 'paid',
        paid_amount: 500,
      },
    ];

    await EcoVilaCrmDashboard.openReservation(res);
    assert.equal(deleteDiffWarning.hidden, false, 'Warning must be visible before delete');
    assert.equal(
      deleteDiffWarning.textContent,
      'Atenție: 500 MDL achitați prin link de plată se restituie separat, din portalul MAIB.',
    );

    // 2. With partially refunded difference link (500 MDL paid, 200 MDL refunded -> 300 MDL net)
    fetchedLinks = [
      {
        id: 'link-1',
        reservation_id: 'res-full-1',
        booking_group_id: 'grp-full-1',
        purpose: 'accommodation_difference',
        status: 'paid',
        paid_amount: 500,
        refunded_amount: 200,
      },
    ];

    await EcoVilaCrmDashboard.openReservation(res);
    assert.equal(deleteDiffWarning.hidden, false);
    assert.equal(
      deleteDiffWarning.textContent,
      'Atenție: 300 MDL achitați prin link de plată se restituie separat, din portalul MAIB.',
    );

    // 3. With fully refunded difference link (500 MDL paid, 500 MDL refunded -> 0 MDL net)
    fetchedLinks = [
      {
        id: 'link-1',
        reservation_id: 'res-full-1',
        booking_group_id: 'grp-full-1',
        purpose: 'accommodation_difference',
        status: 'paid',
        paid_amount: 500,
        refunded_amount: 500,
      },
    ];

    await EcoVilaCrmDashboard.openReservation(res);
    assert.equal(deleteDiffWarning.hidden, true, 'Warning must be hidden when fully refunded');
    assert.equal(deleteDiffWarning.textContent, '');

    // 4. With unpaid/active link (revoked on cancel, net 0 MDL -> warning hidden)
    fetchedLinks = [
      {
        id: 'link-1',
        reservation_id: 'res-full-1',
        booking_group_id: 'grp-full-1',
        purpose: 'accommodation_difference',
        status: 'active',
        amount: 500,
      },
    ];

    await EcoVilaCrmDashboard.openReservation(res);
    assert.equal(deleteDiffWarning.hidden, true, 'Unpaid links must not show as refundable');
  });

  it('ADR-107 Slice F: scopes partial-cancellation difference warning to the selected villas only', async () => {
    const deleteDiffWarning = createFakeElement('p');
    const partialDiffWarning = createFakeElement('p');
    const list = createFakeElement('ul');
    const partialCheckboxes = [];
    const sectionFields = {
      '[data-partial-body]': createFakeElement('div'),
      '[data-partial-toggle]': createFakeElement('button'),
      '[data-partial-villas]': list,
      '[data-partial-amount]': createFakeElement('input'),
      '[data-partial-confirm]': createFakeElement('input'),
      '[data-partial-error]': createFakeElement('p'),
      '[data-partial-warning]': createFakeElement('p'),
      '[data-partial-difference-warning]': partialDiffWarning,
      '[data-partial-submit]': createFakeElement('button'),
      '[data-partial-selected]': createFakeElement('p'),
      '[data-partial-hint]': createFakeElement('p'),
    };
    const section = createFakeElement('section');
    section.querySelector = (selector) => sectionFields[selector] || null;
    section.querySelectorAll = (selector) => {
      if (selector === '[data-partial-villa]') return partialCheckboxes;
      if (selector === 'input') return partialCheckboxes;
      return [];
    };
    list.appendChild = (item) => {
      list.children.push(item);
      partialCheckboxes.push(item.children[0].children[0]);
      return item;
    };

    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.close = () => {};

    const fields = {
      '[data-edit-check-in]': createFakeElement('input'),
      '[data-edit-check-out]': createFakeElement('input'),
      '[data-edit-adults]': createFakeElement('input'),
      '[data-edit-kids-ages]': createFakeElement('input'),
      '[data-edit-name]': createFakeElement('input'),
      '[data-edit-phone]': createFakeElement('input'),
      '[data-edit-notes]': createFakeElement('textarea'),
      '[data-edit-payment]': createFakeElement('p'),
      '[data-edit-total]': createFakeElement('strong'),
      '[data-delete-difference-warning]': deleteDiffWarning,
      '[data-delete-reservation]': createFakeElement('button'),
      '[data-refund-full-override]': createFakeElement('input'),
      '[data-partial-cancel]': section,
    };
    dialog.querySelector = (selector) => fields[selector] || null;

    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing });

    const res1 = {
      id: 'res-part-1',
      booking_group_id: 'grp-part-1',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      total_price: 3000,
      payment_type: 'card',
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };
    const res2 = {
      id: 'res-part-2',
      booking_group_id: 'grp-part-1',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      total_price: 4000,
      payment_type: 'card',
      payment_status: 'paid',
      rooms: { id: 'room-2', number: 2, type: 'large' },
    };

    const diffLinks = [
      {
        id: 'link-res1',
        reservation_id: 'res-part-1',
        booking_group_id: 'grp-part-1',
        purpose: 'accommodation_difference',
        status: 'paid',
        paid_amount: 600,
      },
      {
        id: 'link-res2',
        reservation_id: 'res-part-2',
        booking_group_id: 'grp-part-1',
        purpose: 'accommodation_difference',
        status: 'paid',
        paid_amount: 400,
      },
    ];

    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: {
        createElement: createFakeElement,
        querySelector: (selector) => (selector === '[data-reservation-dialog]' ? dialog : null),
        querySelectorAll: () => [],
        addEventListener: () => {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: {
        formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`,
      },
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        fetchReservationDifferenceLinks: (_client, _options) => Promise.resolve(diffLinks),
      },
    });

    EcoVilaCrmDashboard.initStateForTests({
      context: { client: {}, formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL` },
      reservations: [res1, res2],
      differenceLinks: diffLinks,
      differenceLinksError: null,
      reload: async () => {},
    });

    await EcoVilaCrmDashboard.openReservation(res1);

    // Full cancel warning sees both villas (1000 MDL total)
    assert.equal(deleteDiffWarning.hidden, false);
    assert.match(deleteDiffWarning.textContent, /1[.\s\u00a0\u202f]?000 MDL/);

    // 1. Initial partial cancel: 0 villas selected => partial diff warning hidden
    assert.equal(partialDiffWarning.hidden, true);

    // 2. Select only Vila 1 (res-part-1) with 600 MDL diff
    partialCheckboxes[0].checked = true;
    list.onchange();

    assert.equal(partialDiffWarning.hidden, false);
    assert.equal(
      partialDiffWarning.textContent,
      'Atenție: 600 MDL achitați prin link de plată se restituie separat, din portalul MAIB.',
    );

    // 3. Select both Vila 1 and Vila 2 (600 + 400 = 1000 MDL diff)
    partialCheckboxes[1].checked = true;
    list.onchange();

    assert.equal(partialDiffWarning.hidden, false);
    assert.match(partialDiffWarning.textContent, /1[.\s\u00a0\u202f]?000 MDL/);

    // 4. Deselect Vila 1, leaving only Vila 2 (res-part-2) with 400 MDL diff
    partialCheckboxes[0].checked = false;
    list.onchange();

    assert.equal(partialDiffWarning.hidden, false);
    assert.equal(
      partialDiffWarning.textContent,
      'Atenție: 400 MDL achitați prin link de plată se restituie separat, din portalul MAIB.',
    );

    // 5. Deselect all villas => warning hidden
    partialCheckboxes[1].checked = false;
    list.onchange();

    assert.equal(partialDiffWarning.hidden, true);
    assert.equal(partialDiffWarning.textContent, '');
  });

  it('ADR-107 Slice F: fails closed when difference-link read fails on dialog open or load', async () => {
    const deleteDiffWarning = createFakeElement('p');
    const partialDiffWarning = createFakeElement('p');
    const totalEl = createFakeElement('strong');
    const list = createFakeElement('ul');
    const partialCheckboxes = [];

    const sectionFields = {
      '[data-partial-body]': createFakeElement('div'),
      '[data-partial-toggle]': createFakeElement('button'),
      '[data-partial-villas]': list,
      '[data-partial-amount]': createFakeElement('input'),
      '[data-partial-confirm]': createFakeElement('input'),
      '[data-partial-error]': createFakeElement('p'),
      '[data-partial-warning]': createFakeElement('p'),
      '[data-partial-difference-warning]': partialDiffWarning,
      '[data-partial-submit]': createFakeElement('button'),
      '[data-partial-selected]': createFakeElement('p'),
      '[data-partial-hint]': createFakeElement('p'),
    };
    const section = createFakeElement('section');
    section.querySelector = (selector) => sectionFields[selector] || null;
    section.querySelectorAll = (selector) => {
      if (selector === '[data-partial-villa]') return partialCheckboxes;
      return [];
    };
    list.appendChild = (item) => {
      list.children.push(item);
      partialCheckboxes.push(item.children[0].children[0]);
      return item;
    };

    const dialog = createFakeElement('dialog');
    dialog.showModal = () => {};
    dialog.close = () => {};

    const fields = {
      '[data-edit-check-in]': createFakeElement('input'),
      '[data-edit-check-out]': createFakeElement('input'),
      '[data-edit-adults]': createFakeElement('input'),
      '[data-edit-kids-ages]': createFakeElement('input'),
      '[data-edit-name]': createFakeElement('input'),
      '[data-edit-phone]': createFakeElement('input'),
      '[data-edit-notes]': createFakeElement('textarea'),
      '[data-edit-payment]': createFakeElement('p'),
      '[data-edit-total]': totalEl,
      '[data-delete-difference-warning]': deleteDiffWarning,
      '[data-delete-reservation]': createFakeElement('button'),
      '[data-refund-full-override]': createFakeElement('input'),
      '[data-partial-cancel]': section,
    };
    dialog.querySelector = (selector) => fields[selector] || null;

    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing });

    const res = {
      id: 'res-err-1',
      booking_group_id: 'grp-err-1',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      total_price: 3000,
      payment_type: 'card',
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };

    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: {
        createElement: createFakeElement,
        querySelector: (selector) => (selector === '[data-reservation-dialog]' ? dialog : null),
        querySelectorAll: () => [],
        addEventListener: () => {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: {
        formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`,
      },
      EcoVilaCrmCalendar,
      EcoVilaSupabase: {
        fetchReservationDifferenceLinks: (_client, _options) => Promise.reject(new Error('Fetch failed: network down')),
      },
    });

    EcoVilaCrmDashboard.initStateForTests({
      context: { client: {}, formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL` },
      reservations: [res],
      differenceLinks: [],
      differenceLinksError: null,
      reload: async () => {},
    });

    await EcoVilaCrmDashboard.openReservation(res);

    // Full cancel warning fails closed
    assert.equal(deleteDiffWarning.hidden, false, 'Delete warning must show fail-closed message');
    assert.match(deleteDiffWarning.textContent, /diferențele de cazare nu au putut fi verificate/i);
    assert.match(deleteDiffWarning.textContent, /se restituie separat, din portalul MAIB/i);

    // Partial cancel warning fails closed
    assert.equal(partialDiffWarning.hidden, false, 'Partial cancel warning must show fail-closed message');
    assert.match(partialDiffWarning.textContent, /diferențele de cazare nu au putut fi verificate/i);
    assert.match(partialDiffWarning.textContent, /se restituie separat, din portalul MAIB/i);

    // The total itself reads plainly; the fail-closed warning above is what
    // tells staff the differences could not be checked.
    assert.match(totalEl.textContent, /Preț total/i);
    assert.doesNotMatch(totalEl.textContent, /neverificat/i);
  });

  it('ADR-107 Slice F: declares data-delete-difference-warning and data-partial-difference-warning in dashboard.html', () => {
    const dashboard = read('admin/dashboard.html');
    const dialogMarkup = dashboard.slice(
      dashboard.indexOf('data-reservation-dialog'),
      dashboard.indexOf('data-swap-dialog'),
    );
    assert.match(dialogMarkup, /data-delete-difference-warning/, 'data-delete-difference-warning must exist in reservation dialog');
    assert.match(dialogMarkup, /data-partial-difference-warning/, 'data-partial-difference-warning must exist in partial cancel section');
  });

  it('ADR-107 Audit Finding 1: effectiveTotal and calculateDailySupplement prevent links bound to other bookings from entering quotes', () => {
    const fakeDoc = {
      createElement: createFakeElement,
      querySelector: () => createFakeElement('div'),
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: createFakeElement('html'),
    };
    const { EcoVilaCrmCalendar: cal } = loadAdminModule('admin/js/crm-calendar.js', {
      EcoVilaPricing: pricing,
    });

    const bookingA = { id: 'res-A', total_price: 3000, payment_status: 'paid' };
    const bookingB = { id: 'res-B', total_price: 3000, payment_status: 'paid' };
    const bookingCancelled = { id: 'res-C', total_price: 3000, payment_status: 'cancelled', cancelled_at: '2026-08-01' };

    const linkA = { id: 'link-A', reservation_id: 'res-A', status: 'paid', paid_amount: 500, purpose: 'accommodation_difference' };
    const linkB = { id: 'link-B', reservation_id: 'res-B', status: 'paid', paid_amount: 200, purpose: 'accommodation_difference' };
    const linkCancelled = { id: 'link-C', reservation_id: 'res-C', status: 'paid', paid_amount: 800, purpose: 'accommodation_difference' };
    const linkNoResId = { id: 'link-orphan', status: 'paid', paid_amount: 500, purpose: 'accommodation_difference' };

    // 1. A link bound to booking A MUST NOT enter booking B's effectiveTotal
    assert.equal(
      cal.effectiveTotal([bookingB], [linkA]),
      3000,
      'effectiveTotal must not count a link belonging to a different reservation',
    );

    // 2. A link without reservation_id contributes nothing
    assert.equal(
      cal.effectiveTotal([bookingB], [linkNoResId]),
      3000,
      'effectiveTotal must not count a link without reservation_id',
    );

    // 3. A link belonging to a cancelled reservation contributes nothing
    assert.equal(
      cal.effectiveTotal([bookingCancelled], [linkCancelled]),
      0,
      'effectiveTotal must not count links belonging to cancelled reservations',
    );

    // 4. A link belonging to booking B contributes correctly
    assert.equal(
      cal.effectiveTotal([bookingB], [linkB]),
      3200,
      'effectiveTotal must count links belonging to live reservations in the list',
    );

    // 5. Passing window of all links into booking B only includes booking B's links
    assert.equal(
      cal.effectiveTotal([bookingB], [linkA, linkB, linkCancelled, linkNoResId]),
      3200,
      'effectiveTotal must filter links window strictly to the live reservations supplied',
    );

    // 6. Test calculateDailySupplement isolation
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
      EcoVilaCrmCalendar: cal,
      EcoVilaCrmSidebar: {
        calculateStaffTotal: () => ({ total: 4000 }),
        splitTotalPrice: (total) => [total],
      },
    });

    const resB = {
      id: 'res-B',
      booking_group_id: 'grp-B',
      check_in: '2026-05-10',
      check_out: '2026-05-12',
      adults: 2,
      kids_ages: [],
      total_price: 3000,
      payment_status: 'paid',
      rooms: { id: 'room-2', number: 2, type: 'large' },
    };

    // calculateDailySupplement with window of links including linkA:
    // Staff total 4000, booking base 3000 => supplement must be 800 MDL (4000 - 3200), NOT including linkA!
    const quote = daily.calculateDailySupplement({
      reservations: [resB],
      reservation: resB,
      adults: 2,
      childBuckets: [],
      differenceLinks: [linkA, linkB],
      pricingTiers: [],
      holidays: [],
    });

    // linkB has res-B, linkA has res-A. existingTotal = 3000 (base) + 200 (linkB) = 3200
    assert.equal(quote.existingTotal, 3200, 'existingTotal must only include res-B difference link');
    assert.equal(quote.supplement, 800, 'supplement must be 4000 - 3200 = 800 MDL');

    // 7. Group fallback isolation: cancelled villa difference link in same booking group is not misattributed to surviving villa
    const survivingVilla = {
      id: 'res-surviving',
      booking_group_id: 'grp-split',
      check_in: '2026-05-10',
      check_out: '2026-05-12',
      total_price: 3000,
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };
    const cancelledVilla = {
      id: 'res-cancelled',
      booking_group_id: 'grp-split',
      check_in: '2026-05-10',
      check_out: '2026-05-12',
      total_price: 3000,
      payment_status: 'cancelled',
      cancelled_at: '2026-05-01',
      rooms: { id: 'room-2', number: 2, type: 'small' },
    };
    const cancelledVillaLink = {
      id: 'link-cancelled-villa',
      booking_group_id: 'grp-split',
      reservation_id: 'res-cancelled',
      status: 'paid',
      paid_amount: 500,
      purpose: 'accommodation_difference',
    };

    const card = daily.buildDailyCard(
      { formatMDL: (n) => `${n} MDL` },
      {
        reservations: [survivingVilla, cancelledVilla],
        differenceLinks: [cancelledVillaLink],
        differenceLinksError: null,
      },
      survivingVilla,
      'in',
      {},
    );

    assert.match(card.innerHTML, /Achitat: 3000 MDL/);
    assert.doesNotMatch(card.innerHTML, /diferență/);
  });

  it('ADR-107 Audit Finding 2: fetchRefundedBoundLinksSafe fails visibly on error instead of silently deleting cancellations', async () => {
    const fakeDoc = {
      createElement: createFakeElement,
      querySelector: () => createFakeElement('div'),
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: createFakeElement('html'),
    };
    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
    });

    const mockClient = {};
    const failingSupabase = {
      fetchRefundedBoundLinkAmounts: () => Promise.reject(new Error('RLS denied')),
    };

    const { EcoVilaCrmFinance: financeWithFailingFetch } = loadAdminModule('admin/js/crm-finance.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
      EcoVilaSupabase: failingSupabase,
    });

    // 1. fetchRefundedBoundLinksSafe must reject with error rather than silently returning empty Map
    await assert.rejects(
      () => financeWithFailingFetch.fetchRefundedBoundLinksSafe(
        { client: mockClient },
        [{ id: 'res-1', booking_group_id: 'grp-1' }],
      ),
      /RLS denied/,
      'fetchRefundedBoundLinksSafe must throw when fetch fails',
    );

    // 2. loadFinance must reject and surface error via context.setAlert
    let alertCalledWith = null;
    const mockContext = {
      client: mockClient,
      formatDate: () => '',
      formatMDL: (n) => `${n} MDL`,
      setAlert: (msg) => { alertCalledWith = msg; },
    };

    const fullFailingSupabase = {
      fetchFinanceReservations: () => Promise.resolve([]),
      fetchFinanceChangePayments: () => Promise.resolve([]),
      fetchFinancePaymentLinks: () => Promise.resolve([]),
      fetchFinanceCancellations: () => Promise.resolve([
        {
          id: 'res-office-1',
          booking_group_id: 'grp-office-1',
          payment_type: 'office',
          payment_status: 'cancelled',
          total_price: 3000,
          cancelled_at: '2026-05-01',
          rooms: { number: 1, type: 'small' },
        },
      ]),
      fetchScheduledRefunds: () => Promise.resolve([]),
      fetchRefundedGroups: () => Promise.resolve([]),
      fetchRefundedBoundLinkAmounts: () => Promise.reject(new Error('Bound links read failed')),
    };

    const { EcoVilaCrmFinance: financeFullMock } = loadAdminModule('admin/js/crm-finance.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
      EcoVilaSupabase: fullFailingSupabase,
    });

    const state = {
      mode: 'paid',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-05-31',
      cancellationRows: [],
      refundedGroupIds: new Map(),
      refundedChangesByGroup: new Map(),
      refundedBoundLinksByReservation: new Map(),
      refundedBoundLinksError: null,
    };

    await assert.rejects(
      () => financeFullMock.loadFinance(mockContext, state),
      /Bound links read failed/,
      'loadFinance must reject when bound links read fails',
    );
    assert.ok(alertCalledWith, 'context.setAlert must be called on failure');

    // 3. summarizeCancellationRows reports unverified when refundedBoundLinksError is set
    const summary = finance.summarizeCancellationRows({
      rows: [
        {
          id: 'res-office-1',
          booking_group_id: 'grp-office-1',
          payment_type: 'office',
          payment_status: 'cancelled',
          total_price: 3000,
          cancelled_at: '2026-05-01',
          rooms: { number: 1, type: 'small' },
        },
      ],
      refundedGroupIds: new Map(),
      refundedChangesByGroup: new Map(),
      refundedBoundLinksByReservation: new Map(),
      refundedBoundLinksError: new Error('Read failed'),
    });

    assert.equal(summary.unverified, true);
    assert.equal(summary.reliable, false);

    // 4. A cancelled cash/office booking whose only refund is its bound link is recognized as refunded: true
    const boundLinksMap = new Map([
      ['res-office-1', [{ amount: 500, grossAmount: 500, withheldCommission: 0 }]],
    ]);
    const groups = finance.groupCancellationRows(
      [
        {
          id: 'res-office-1',
          booking_group_id: 'grp-office-1',
          payment_type: 'office',
          payment_status: 'cancelled',
          total_price: 3000,
          cancelled_at: '2026-05-01',
          rooms: { number: 1, type: 'small' },
        },
      ],
      new Map(),
      new Map(),
      boundLinksMap,
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].refunded, true, 'Office booking with bound link refund must be recognized as refunded');
    assert.equal(groups[0].refundedAmount, 500);
  });

  it('ADR-107 Audit Finding 3: daily cards show unverified status rather than base totals after failed difference read', () => {
    const fakeDoc = {
      createElement: createFakeElement,
      querySelector: () => createFakeElement('div'),
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: createFakeElement('html'),
    };
    const { EcoVilaCrmCalendar: cal } = loadAdminModule('admin/js/crm-calendar.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
    });
    const { EcoVilaCrmDaily: daily } = loadAdminModule('admin/js/crm-daily.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
      EcoVilaCrmCalendar: cal,
    });

    const res = {
      id: 'res-daily-1',
      booking_group_id: 'grp-daily-1',
      check_in: '2026-05-10',
      check_out: '2026-05-12',
      total_price: 3000,
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
    };

    // A failed read shows the booking price plainly. Blanking every card to
    // "neverificat" was pure noise on screen; the guarantee lives on the WRITE
    // path instead, where saveDailyGuestEdit refuses to reprice at all.
    const cardWithError = daily.buildDailyCard(
      { formatMDL: (n) => `${n} MDL` },
      {
        reservations: [res],
        differenceLinks: [],
        differenceLinksError: new Error('RLS denied'),
      },
      res,
      'in',
      {},
    );

    assert.match(cardWithError.innerHTML, /Achitat:\s*3000\s*MDL/i, 'Card shows the booking price plainly');
    assert.doesNotMatch(
      cardWithError.innerHTML,
      /neverificat/i,
      'no per-card unverified badge — the refusal lives on the write path',
    );

    // When differenceLinks loaded successfully with a paid difference:
    const diffLink = {
      id: 'diff-1',
      reservation_id: 'res-daily-1',
      purpose: 'accommodation_difference',
      status: 'paid',
      paid_amount: 500,
    };
    const cardSuccess = daily.buildDailyCard(
      { formatMDL: (n) => `${n} MDL` },
      {
        reservations: [res],
        differenceLinks: [diffLink],
        differenceLinksError: null,
      },
      res,
      'in',
      {},
    );

    assert.match(cardSuccess.innerHTML, /Achitat:\s*3500\s*MDL\s*\(3000\s*MDL\s*\+\s*500\s*MDL\s*diferență\)/i);
  });

  it('ADR-107 QA Finding 1: Finance cancellation path derives bound-link refunds by cancelled reservation_id, capturing ungrouped reservations', async () => {
    const fakeDoc = {
      createElement: createFakeElement,
      querySelector: () => createFakeElement('div'),
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: createFakeElement('html'),
    };

    const { EcoVilaSupabase: supabase } = loadAdminModule('js/supabase.js');

    // 1. Verify supabase.fetchRefundedBoundLinkAmounts queries by reservation_id
    const inCalls = [];
    const mockBuilder = {
      select() { return mockBuilder; },
      eq() { return mockBuilder; },
      gt() { return mockBuilder; },
      in(col, val) { inCalls.push({ col, val }); return mockBuilder; },
      order() { return mockBuilder; },
      range() {
        return Promise.resolve({
          data: [
            {
              id: 'diff-link-ungrouped',
              reservation_id: 'res-ungrouped-1',
              booking_group_id: null,
              paid_amount: 2000,
              refunded_amount: 2000,
              status: 'refunded',
              purpose: 'accommodation_difference',
            },
          ],
        });
      },
    };
    const mockClient = {
      from() { return mockBuilder; },
    };

    const fetchedRows = await supabase.fetchRefundedBoundLinkAmounts(mockClient, {
      reservationIds: ['res-ungrouped-1'],
    });
    assert.equal(fetchedRows.length, 1);
    assert.equal(fetchedRows[0].reservation_id, 'res-ungrouped-1');
    assert.equal(inCalls.length, 1);
    assert.equal(inCalls[0].col, 'reservation_id', 'fetchRefundedBoundLinkAmounts must query reservation_id column');
    assert.deepEqual(inCalls[0].val, ['res-ungrouped-1']);

    // 2. Ungrouped reservation (booking_group_id: null) with refunded bound link in loadFinance
    const cancellationRowUngrouped = {
      id: 'res-ungrouped-1',
      booking_group_id: null,
      payment_type: 'office',
      payment_status: 'cancelled',
      paid_at: '2026-05-01T10:00:00.000Z',
      cancelled_at: '2026-05-05T12:00:00.000Z',
      total_price: 3000,
      rooms: { number: 1, type: 'small' },
      guest_first_name: 'Denis',
      guest_last_name: 'Vilcov',
    };

    let passedReservationIds = null;
    const mockSupabaseForFinance = {
      fetchFinanceReservations: () => Promise.resolve([]),
      fetchFinanceChangePayments: () => Promise.resolve([]),
      fetchFinancePaymentLinks: () => Promise.resolve([]),
      fetchFinanceCancellations: () => Promise.resolve([cancellationRowUngrouped]),
      fetchScheduledRefunds: () => Promise.resolve([]),
      fetchRefundedGroups: () => Promise.resolve([]),
      fetchRefundedBoundLinkAmounts: (_client, options) => {
        passedReservationIds = options?.reservationIds;
        return Promise.resolve([
          {
            id: 'diff-link-ungrouped',
            reservation_id: 'res-ungrouped-1',
            booking_group_id: null,
            paid_amount: 2000,
            refunded_amount: 2000,
            status: 'refunded',
            purpose: 'accommodation_difference',
          },
        ]);
      },
    };

    const { EcoVilaCrmFinance: finance } = loadAdminModule('admin/js/crm-finance.js', {
      document: fakeDoc,
      EcoVilaPricing: pricing,
      EcoVilaSupabase: mockSupabaseForFinance,
    });

    const mockContext = {
      client: mockClient,
      formatDate: () => '2026-05-05',
      formatMDL: (n) => `${n} MDL`,
      setAlert: () => {},
    };

    const state = {
      mode: 'paid',
      rangeStart: '2026-05-01',
      rangeEnd: '2026-05-31',
      cancellationRows: [],
      refundedGroupIds: new Map(),
      refundedChangesByGroup: new Map(),
      refundedBoundLinksByReservation: new Map(),
      refundedBoundLinksError: null,
    };

    await finance.loadFinance(mockContext, state);

    assert.deepEqual(Array.from(passedReservationIds), ['res-ungrouped-1'], 'fetchRefundedBoundLinksSafe must pass cancelled reservation IDs');
    assert.equal(state.refundedBoundLinksByReservation.has('res-ungrouped-1'), true);

    const summary = finance.summarizeCancellationRows({
      rows: state.cancellationRows,
      refundedGroupIds: state.refundedGroupIds,
      refundedChangesByGroup: state.refundedChangesByGroup,
      refundedBoundLinksByReservation: state.refundedBoundLinksByReservation,
      refundedBoundLinksError: null,
    });

    assert.equal(summary.count, 1, 'Ungrouped cancellation with refunded bound link must be included in refunded count');
    assert.equal(summary.refundedTotal, 2000, 'Refunded bound link amount must be recognized in refunded total');
  });

  it('ADR-107 QA Finding 2: Move dialog summary indicates unverified figure when bookingMoney is not reliable', () => {
    const summaryEl = createFakeElement('div');
    const moveDialog = createFakeElement('dialog');
    moveDialog.querySelector = (selector) => {
      if (selector === '[data-move-summary]') return summaryEl;
      return createFakeElement('div');
    };
    moveDialog.showModal = () => {};
    moveDialog.close = () => {};

    const { EcoVilaCrmCalendar } = loadAdminModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing });
    const { EcoVilaCrmDashboard } = loadAdminModule('admin/js/crm-dashboard.js', {
      document: {
        createElement: createFakeElement,
        querySelector: (selector) => (selector === '[data-move-dialog]' ? moveDialog : null),
        querySelectorAll: () => [],
        addEventListener: () => {},
        documentElement: createFakeElement('html'),
      },
      EcoVilaCrmApp: {
        formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL`,
      },
      EcoVilaCrmCalendar,
    });

    const res = {
      id: 'res-move-1',
      booking_group_id: 'grp-move-1',
      room_id: 'room-1',
      check_in: '2026-06-10',
      check_out: '2026-06-12',
      total_price: 6000,
      payment_type: 'card',
      payment_status: 'paid',
      rooms: { id: 'room-1', number: 1, type: 'small' },
      guest_first_name: 'Elena',
      guest_last_name: 'Popa',
    };

    const targetRoom = { id: 'room-2', number: 2, type: 'large' };

    // Case 1: differenceLinks read failed (differenceLinksError is set)
    EcoVilaCrmDashboard.initStateForTests({
      context: { client: {}, formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL` },
      reservations: [res],
      rooms: [{ id: 'room-1', number: 1, type: 'small' }, targetRoom],
      differenceLinks: [],
      differenceLinksError: new Error('Network failure'),
      reload: async () => {},
    });

    EcoVilaCrmDashboard.renderMoveSummary(moveDialog, res, res.rooms, targetRoom);
    const summaryTextUnreliable = summaryEl.children.map((c) => c.textContent).join('\n');

    assert.match(summaryTextUnreliable, /Preț rezervare:\s*6[.\s]*000\s*MDL/i, 'Move summary shows the booking price plainly');
    assert.match(summaryTextUnreliable, /Diferențele de cazare nu au putut fi verificate/i, 'Move summary must still explain differences could not be verified');
    assert.doesNotMatch(summaryTextUnreliable, /Preț efectiv rezervare:\s*6[.\s]*000\s*MDL/i, 'Move summary must not print authoritative effective total when unverified');

    // Case 2: differenceLinks successfully loaded with paid 2 000 MDL difference
    const diffLink = {
      id: 'diff-move-1',
      reservation_id: 'res-move-1',
      booking_group_id: 'grp-move-1',
      purpose: 'accommodation_difference',
      status: 'paid',
      paid_amount: 2000,
    };

    EcoVilaCrmDashboard.initStateForTests({
      context: { client: {}, formatMDL: (amount) => `${Number(amount || 0).toLocaleString('ro-MD')} MDL` },
      reservations: [res],
      rooms: [{ id: 'room-1', number: 1, type: 'small' }, targetRoom],
      differenceLinks: [diffLink],
      differenceLinksError: null,
      reload: async () => {},
    });

    EcoVilaCrmDashboard.renderMoveSummary(moveDialog, res, res.rooms, targetRoom);
    const summaryTextReliable = summaryEl.children.map((c) => c.textContent).join('\n');

    assert.match(summaryTextReliable, /Preț efectiv rezervare:\s*8[.\s]*000\s*MDL/i, 'Move summary must state authoritative effective total when reliable');
    assert.match(summaryTextReliable, /Calcul:\s*6[.\s]*000\s*MDL\s*\+\s*2[.\s]*000\s*MDL\s*diferență achitată/i, 'Move summary must show breakdown when reliable');
  });
});
