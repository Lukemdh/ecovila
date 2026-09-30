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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function element(dataset = {}) {
  const classes = new Set();
  const handlers = new Map();
  return {
    dataset,
    hidden: false,
    disabled: false,
    textContent: '',
    scrollLeft: 0,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    addEventListener(name, handler) { handlers.set(name, handler); },
    fire(name, event = {}) { return handlers.get(name)?.(event); },
    setAttribute() {},
    append(...children) { children.forEach((child) => this.appendChild(child)); },
    appendChild(child) { (this.children ||= []).push(child); },
  };
}

function loadModule(file, extras = {}) {
  const sandbox = {
    Date, Intl, setTimeout, clearTimeout,
    setInterval() { return 1; }, clearInterval() {},
    ...extras,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return sandbox;
}

function appHarness(role, hash = '') {
  const session = deferred();
  const app = element();
  const label = element();
  const alert = element();
  const signOut = element();
  const tabs = ['dashboard', 'finance', 'payment-links', 'daily', 'towels', 'photos', 'pricing', 'probleme'];
  const buttons = tabs.map((tab) => element({ tab }));
  const panels = tabs.map((panel) => element({ panel }));
  const calls = [];
  const channels = [];
  const location = { hash, pathname: '/admin/dashboard.html', search: '' };
  const document = {
    querySelector(selector) {
      if (selector === '[data-crm-app]') return app;
      if (selector === '[data-crm-user-label]') return label;
      if (selector === '[data-crm-alert]') return alert;
      if (selector === '[data-crm-sign-out]') return signOut;
      if (selector === '[data-tab].is-active') return buttons.find((button) => button.classList.contains('is-active'));
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return buttons;
      if (selector === '[data-panel]') return panels;
      return [];
    },
  };
  const modules = Object.fromEntries([
    ['Dashboard', 'dashboard'], ['Finance', 'finance'], ['PaymentLinks', 'payment-links'],
    ['Daily', 'daily'], ['Towels', 'towels'], ['Photos', 'photos'], ['Pricing', 'pricing'],
    ['Complaints', 'probleme'],
  ].map(([suffix, tab]) => [`EcoVilaCrm${suffix}`, {
    init() { calls.push(`${tab}:init`); if (tab === 'probleme') channels.push('complaints'); },
    showPanel() { calls.push(`${tab}:show`); },
    showToday() { calls.push(`${tab}:show`); },
    loadPhotos() { calls.push(`${tab}:refresh`); return Promise.resolve(); },
    loadPricing() { calls.push(`${tab}:refresh`); return Promise.resolve(); },
  }]));
  const events = new Map();
  const sandbox = loadModule('admin/js/crm-app.js', {
    document, location,
    history: { replaceState(_state, _title, url) { location.hash = url.startsWith('#') ? url : ''; } },
    addEventListener(name, handler) { events.set(name, handler); },
    EcoVilaCrmAuth: { requireSession: () => session.promise },
    ...modules,
  });
  return {
    sandbox, session, calls, channels, buttons, panels, events,
    login: async () => { session.resolve({ role, client: {}, session: {} }); await flush(); },
    click: (tab) => buttons[tabs.indexOf(tab)].fire('click'),
    active: () => panels.find((panel) => panel.classList.contains('is-active'))?.dataset.panel,
  };
}

function dashboardHarness(readOnly = false) {
  const callbacks = [];
  const calls = [];
  const scans = [];
  const realtimeTimers = [];
  const controls = new Map([
    ['[data-panel="dashboard"]', element()],
    ['[data-reservation-calendar]', element()],
    ['[data-calendar-prev]', element()],
    ['[data-calendar-next]', element()],
    ['[data-calendar-today]', element()],
    ['[data-calendar-jump-date]', element()],
  ]);
  controls.get('[data-panel="dashboard"]').classList.add('is-active');
  controls.get('[data-reservation-calendar]').scrollLeft = 500;
  let state;
  const helpers = {
    fetchRooms: async () => [],
    fetchAdminReservations(_client, options) {
      calls.push(options);
      if (options.activeOnly) {
        const scan = deferred();
        scans.push(scan);
        return scan.promise;
      }
      return Promise.resolve([]);
    },
    fetchPendingCashReservations: async () => [],
    fetchPricingTiers: async () => [],
    fetchHolidays: async () => [],
    fetchTemporaryHolds: async () => [],
    fetchGuestFlagMarkers: async () => [],
  };
  const client = { channel() { return {
    on(_event, _filter, callback) { callbacks.push(callback); return this; },
    subscribe() { return this; },
  }; } };
  const sandbox = loadModule('admin/js/crm-dashboard.js', {
    setTimeout(callback, delay) {
      if (delay === 400) {
        realtimeTimers.push(callback);
        return 1000 + realtimeTimers.length;
      }
      return setTimeout(callback, delay);
    },
    clearTimeout(timer) { if (timer < 1000) clearTimeout(timer); },
    document: {
      querySelector: (selector) => controls.get(selector) || null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    EcoVilaCrmCalendar: loadModule('admin/js/crm-calendar.js', { EcoVilaPricing: pricing }).EcoVilaCrmCalendar,
    EcoVilaSupabase: helpers,
    EcoVilaCrmSidebar: { init(_context, dashboardState) { state = dashboardState; } },
  });
  sandbox.EcoVilaCrmDashboard.init({ client, permissions: { dashboardReadOnly: readOnly }, setAlert() {}, formatDate: String });
  return { sandbox, controls, callbacks, calls, scans, realtimeTimers, get state() { return state; } };
}

describe('CRM lazy tabs and add availability', () => {
  it('does not start tab modules before auth and only opens the dashboard and badge channel at login', async () => {
    const app = appHarness('diana');
    app.click('finance');
    assert.deepEqual(app.calls, []);
    await app.login();
    assert.equal(app.active(), 'finance');
    assert.deepEqual(app.calls, ['probleme:init', 'finance:init']);
    assert.deepEqual(app.channels, ['complaints']);
    app.click('dashboard');
    app.click('finance');
    app.click('dashboard');
    assert.equal(app.calls.filter((call) => call === 'finance:init').length, 1);
    assert.equal(app.calls.filter((call) => call === 'finance:show').length, 1);
    assert.equal(app.calls.filter((call) => call === 'dashboard:init').length, 1);
    assert.equal(app.calls.filter((call) => call === 'dashboard:show').length, 1);
  });

  it('opens an allowed finance deep link once and clamps Angela to dashboard through hashchange', async () => {
    const diana = appHarness('diana', '#finance');
    await diana.login();
    assert.equal(diana.active(), 'finance');
    assert.deepEqual(diana.calls, ['probleme:init', 'finance:init']);

    const angela = appHarness('angela', '#finance');
    await angela.login();
    assert.equal(angela.active(), 'dashboard');
    assert.equal(angela.buttons.find((button) => button.dataset.tab === 'finance').hidden, true);
    angela.sandbox.location.hash = '#finance';
    angela.events.get('hashchange')();
    assert.equal(angela.active(), 'dashboard');
    assert.equal(angela.sandbox.location.hash, '');
    assert.equal(angela.calls.includes('finance:init'), false);
    angela.sandbox.location.hash = '#unknown';
    angela.events.get('hashchange')();
    assert.equal(angela.sandbox.location.hash, '');
  });

  it('opens Probleme from a click and a deep link without reinitialising its badge channel', async () => {
    const clicked = appHarness('diana');
    await clicked.login();
    clicked.click('probleme');
    assert.equal(clicked.active(), 'probleme');
    assert.equal(clicked.calls.filter((call) => call === 'probleme:init').length, 1);
    assert.equal(clicked.calls.filter((call) => call === 'probleme:show').length, 1);

    const linked = appHarness('diana', '#probleme');
    await linked.login();
    assert.equal(linked.active(), 'probleme');
    assert.deepEqual(linked.calls, ['probleme:init', 'probleme:show']);
  });

  it('initialises remaining tabs once and preserves photos/pricing on re-entry', async () => {
    const app = appHarness('diana');
    await app.login();
    const cases = [
      ['daily', 'show', 1], ['towels', 'show', 1], ['payment-links', 'show', 1],
      ['photos', 'refresh', 0], ['pricing', 'refresh', 0],
    ];
    for (const [tab, refresh, expectedCalls] of cases) {
      app.click(tab);
      assert.equal(app.calls.filter((call) => call === `${tab}:init`).length, 1, `${tab} first open`);
      app.click('dashboard');
      app.click(tab);
      assert.equal(app.calls.filter((call) => call === `${tab}:init`).length, 1, `${tab} initialises once`);
      assert.equal(app.calls.filter((call) => call === `${tab}:${refresh}`).length, expectedCalls, `${tab} re-entry`);
    }
  });

  it('renders the calendar before the two-year scan and skips that scan on month navigation', async () => {
    const dashboard = dashboardHarness();
    await flush();
    assert.equal(dashboard.state.isLoading, false);
    assert.equal(dashboard.state.addAvailabilityStatus, 'loading');
    assert.equal(dashboard.scans.length, 1);
    assert.ok(dashboard.state.addAvailabilityEnd > dashboard.state.today);
    let navigationReads = dashboard.calls.length;
    dashboard.controls.get('[data-calendar-next]').fire('click');
    await flush();
    assert.ok(dashboard.calls.length > navigationReads, 'next reloads the calendar');
    assert.equal(dashboard.scans.length, 1);
    for (const selector of ['[data-calendar-prev]', '[data-calendar-today]']) {
      navigationReads = dashboard.calls.length;
      dashboard.controls.get(selector).fire('click');
      await flush();
      assert.ok(dashboard.calls.length > navigationReads, `${selector} reloads the calendar`);
      assert.equal(dashboard.scans.length, 1, `${selector} skips the two-year scan`);
    }
    navigationReads = dashboard.calls.length;
    dashboard.controls.get('[data-calendar-jump-date]').fire('change', { target: { value: '2026-11-15' } });
    await flush();
    assert.ok(dashboard.calls.length > navigationReads, 'jump-date reloads the calendar');
    assert.equal(dashboard.scans.length, 1, 'jump-date skips the two-year scan');
    await dashboard.state.reload();
    assert.equal(dashboard.scans.length, 2);
    dashboard.scans[1].resolve([{ id: 'fresh' }]);
    await dashboard.state.addAvailabilityPromise;
    dashboard.scans[0].resolve([{ id: 'stale' }]);
    await flush();
    assert.equal(dashboard.state.addReservations[0].id, 'fresh');
    assert.equal(dashboard.state.addAvailabilityStatus, 'ready');
    assert.equal(dashboard.calls.filter((options) => options.activeOnly).length, 2);
  });

  it('keeps hidden realtime off the calendar and reloads on return while visible', async () => {
    const dashboard = dashboardHarness();
    await flush();
    const panel = dashboard.controls.get('[data-panel="dashboard"]');
    panel.classList.remove('is-active');
    const before = dashboard.calls.length;
    dashboard.callbacks[0]();
    assert.equal(dashboard.state.needsReloadOnActivate, true);
    assert.equal(dashboard.calls.length, before);
    panel.classList.add('is-active');
    dashboard.sandbox.EcoVilaCrmDashboard.showPanel();
    await flush();
    assert.equal(dashboard.state.needsReloadOnActivate, false);
    assert.ok(dashboard.calls.length > before);
  });

  it('defers an active dashboard realtime event if the user switches tabs during its debounce', async () => {
    const dashboard = dashboardHarness();
    await flush();
    const panel = dashboard.controls.get('[data-panel="dashboard"]');
    const before = dashboard.calls.length;
    dashboard.callbacks[0]();
    assert.equal(dashboard.realtimeTimers.length, 1);
    panel.classList.remove('is-active');
    dashboard.realtimeTimers[0]();
    assert.equal(dashboard.calls.length, before);
    assert.equal(dashboard.state.needsReloadOnActivate, true);
    panel.classList.add('is-active');
    dashboard.sandbox.EcoVilaCrmDashboard.showPanel();
    await flush();
    assert.equal(dashboard.state.needsReloadOnActivate, false);
    assert.ok(dashboard.calls.length > before);
  });

  it('marks a failed add scan unavailable and recovers on retry; Angela never starts one', async () => {
    const dashboard = dashboardHarness();
    await flush();
    dashboard.scans[0].reject(new Error('read failed'));
    await dashboard.state.addAvailabilityPromise;
    assert.equal(dashboard.state.addAvailabilityStatus, 'error');
    const retry = dashboard.state.reloadAddAvailability();
    assert.equal(dashboard.state.addAvailabilityStatus, 'loading');
    dashboard.scans[1].resolve([]);
    await retry;
    assert.equal(dashboard.state.addAvailabilityStatus, 'ready');

    const angela = dashboardHarness(true);
    await flush();
    assert.equal(angela.scans.length, 0);
    assert.equal(angela.state.addAvailabilityStatus, 'idle');
  });

  it('skips hidden finance, payment-link, and towel realtime reads', () => {
    const cases = [
      {
        file: 'admin/js/crm-finance.js', tab: 'finance', helper: 'fetchFinanceReservations',
        extras: { EcoVilaPricing: pricing },
      },
      {
        file: 'admin/js/crm-payment-links.js', tab: 'payment-links', helper: 'listPaymentLinks',
        extras: {},
      },
      {
        file: 'admin/js/crm-towels.js', tab: 'towels', helper: 'fetchRooms',
        extras: { EcoVilaCrmCalendar: { todayISO: () => '2026-09-29' } },
      },
    ];
    for (const testCase of cases) {
      const panel = element();
      const callbacks = [];
      let reads = 0;
      const never = new Promise(() => {});
      const helpers = new Proxy({
        [testCase.helper]: () => { reads += 1; return never; },
      }, { get(target, key) { return target[key] || (() => Promise.resolve([])); } });
      const client = { channel() { return {
        on(_event, _filter, callback) { callbacks.push(callback); return this; },
        subscribe() { return this; },
      }; } };
      const sandbox = loadModule(testCase.file, {
        document: {
          querySelector: (selector) => selector === `[data-panel="${testCase.tab}"]` ? panel : null,
          querySelectorAll: () => [], addEventListener() {},
        },
        EcoVilaSupabase: helpers,
        ...testCase.extras,
      });
      const suffix = { finance: 'Finance', 'payment-links': 'PaymentLinks', towels: 'Towels' }[testCase.tab];
      sandbox[`EcoVilaCrm${suffix}`].init({ client, setAlert() {}, formatDate: String });
      assert.equal(reads, 1, `${testCase.tab} first activation reads once`);
      callbacks.forEach((callback) => callback());
      assert.equal(reads, 1, `${testCase.tab} hidden events do not read`);
      panel.classList.add('is-active');
      callbacks[0]();
      assert.equal(reads, 2, `${testCase.tab} active event reads`);
    }
  });

  it('filters active-only admin pages without changing ordinary query builders', async () => {
    const queryCalls = [];
    const makeBuilder = () => {
      const builder = {
        select: () => builder, order: () => builder,
        gt: () => builder, lt: () => builder,
        is(...args) { queryCalls.push(['is', ...args]); return builder; },
        neq(...args) { queryCalls.push(['neq', ...args]); return builder; },
        range: () => Promise.resolve({ data: [], error: null }),
      };
      return builder;
    };
    const helpers = loadModule('js/supabase.js').EcoVilaSupabase;
    await helpers.fetchAdminReservations({ from: makeBuilder }, { activeOnly: true });
    assert.deepEqual(queryCalls, [['is', 'cancelled_at', null], ['neq', 'payment_status', 'cancelled']]);
    queryCalls.length = 0;
    await helpers.fetchAdminReservations({ from: makeBuilder }, {});
    assert.deepEqual(queryCalls, []);
  });

  it('keeps unknown rooms in standby, selections intact, and refuses availability checks', () => {
    const sidebar = loadModule('admin/js/crm-sidebar.js', {
      EcoVilaPricing: pricing, EcoVilaCalendar: calendar,
    }).EcoVilaCrmSidebar;
    const model = sidebar.buildRoomPickerModel({
      rooms: [{ id: 'room-1', number: 1 }], reservations: [],
      checkIn: '2026-10-10', checkOut: '2026-10-11',
      selectedNumbers: [1], availabilityReady: false,
    });
    assert.equal(model.availabilityReady, false);
    assert.equal(model.freeCount, 0);
    assert.equal(model.groups.flatMap((group) => group.squares).find((square) => square.number === 1).state, 'standby');
    assert.deepEqual(Array.from(sidebar.reconcileSelectedRooms(model).kept), [1]);
    assert.equal(sidebar.areSelectedRoomsAvailable({
      rooms: [{ id: 'room-1', number: 1 }], reservations: null,
      roomNumbers: [1], checkIn: '2026-10-10', checkOut: '2026-10-11',
    }), false);
  });

  it('uses loading and error validation copy before the room check without falling back to calendar rows', () => {
    const sidebar = loadModule('admin/js/crm-sidebar.js', {
      EcoVilaPricing: pricing, EcoVilaCalendar: calendar,
    }).EcoVilaCrmSidebar;
    const fields = {
      '[data-add-room-numbers]': { value: '1' },
      '[data-add-adults]': { value: '2' },
      '[data-add-kids]': { value: '0' },
      '[data-add-check-in]': { value: '2026-10-10' },
      '[data-add-check-out]': { value: '2026-10-11' },
      '[data-add-phone]': { value: '+37369857607' },
      '[data-add-total]': { dataset: { total: '1000' } },
    };
    const form = { querySelector: (selector) => fields[selector] || null };
    const state = {
      rooms: [{ id: 'room-1', number: 1 }],
      reservations: [], addReservations: [], addAvailabilityStatus: 'loading',
    };
    assert.equal(sidebar.validateAddForm(state, form, { childBuckets: [] }),
      'Disponibilitatea camerelor se încarcă. Încearcă din nou în câteva secunde.');
    state.addAvailabilityStatus = 'error';
    assert.equal(sidebar.validateAddForm(state, form, { childBuckets: [] }),
      'Disponibilitatea nu s-a putut încărca. Apasă „Reîncearcă”.');
    state.addAvailabilityStatus = 'ready';
    state.addReservations = null;
    assert.equal(sidebar.validateAddForm(state, form, { childBuckets: [] }),
      'Camerele selectate nu sunt disponibile pentru perioada aleasă.');
  });

  it('shows an error retry, keeps the selected room, and enables squares after recovery', () => {
    const fields = {
      '[data-add-room-numbers]': Object.assign(element(), { value: '1' }),
      '[data-add-check-in]': Object.assign(element(), { value: '2026-10-10' }),
      '[data-add-check-out]': Object.assign(element(), { value: '2026-10-11' }),
      '[data-add-adults]': Object.assign(element(), { value: '2' }),
      '[data-add-kids]': Object.assign(element(), { value: '0' }),
      '[data-add-room-grid]': element(),
      '[data-add-room-status]': element(),
      '[data-add-total]': { dataset: {}, textContent: '' },
    };
    const form = element();
    form.querySelector = (selector) => fields[selector] || null;
    form.querySelectorAll = () => [];
    const state = {
      rooms: [{ id: 'room-1', number: 1, type: 'small' }],
      reservations: [], addReservations: [], addAvailabilityStatus: 'error',
      addAvailabilityEnd: '2028-09-29', pricingTiers: [], holidays: [],
    };
    state.reloadAddAvailability = () => {
      state.addAvailabilityStatus = 'ready';
      state.refreshAddReservationForm();
    };
    const sandbox = loadModule('admin/js/crm-sidebar.js', {
      document: {
        querySelector: (selector) => selector === '[data-add-reservation-form]' ? form : null,
        querySelectorAll: () => [], createElement: () => element(), addEventListener() {},
      },
      EcoVilaPricing: pricing, EcoVilaCalendar: calendar,
      EcoVilaCrmCalendar: { guestFlagFor: () => null },
      EcoVilaSupabase: {},
    });
    sandbox.EcoVilaCrmSidebar.init({ permissions: {}, setAlert() {}, formatDate: String }, state);
    const status = fields['[data-add-room-status]'];
    assert.match(status.textContent, /nu s-a putut încărca/);
    const retry = status.children.at(-1);
    assert.equal(retry.textContent, 'Reîncearcă');
    assert.equal(fields['[data-add-total]'].dataset.total, '0');
    const firstGroup = fields['[data-add-room-grid]'].children[0];
    assert.equal(firstGroup.children[1].children[0].disabled, true);
    assert.equal(fields['[data-add-room-numbers]'].value, '1');
    retry.fire('click');
    assert.equal(state.addAvailabilityStatus, 'ready');
    assert.equal(fields['[data-add-room-numbers]'].value, '1');
    const lastGroup = fields['[data-add-room-grid]'].children.at(-3);
    assert.equal(lastGroup.children[1].children[0].disabled, false);
  });

  it('keeps the add submit disabled until the fresh snapshot finishes after success or 23P01', async () => {
    for (const conflict of [false, true]) {
      const refreshed = deferred();
      const submit = element();
      const fields = {
        '[data-add-room-numbers]': Object.assign(element(), { value: '1' }),
        '[data-add-check-in]': Object.assign(element(), { value: '2026-10-10' }),
        '[data-add-check-out]': Object.assign(element(), { value: '2026-10-11' }),
        '[data-add-adults]': Object.assign(element(), { value: '2' }),
        '[data-add-kids]': Object.assign(element(), { value: '0' }),
        '[data-add-phone]': Object.assign(element(), { value: '+37369857607' }),
        '[data-add-full-name]': Object.assign(element(), { value: 'Ana Munteanu' }),
        '[data-add-room-grid]': element(),
        '[data-add-room-status]': element(),
        '[data-add-total]': { dataset: {}, textContent: '' },
        'button[type="submit"]': submit,
      };
      const form = element();
      form.querySelector = (selector) => fields[selector] || null;
      form.querySelectorAll = () => [];
      form.reset = () => {};
      let inserts = 0;
      let alert = '';
      const state = {
        rooms: [{ id: 'room-1', number: 1, type: 'small' }],
        reservations: [], addReservations: [], addAvailabilityStatus: 'ready',
        addAvailabilityEnd: '2028-09-29', pricingTiers: [], holidays: [],
        reload: async () => { state.addAvailabilityPromise = refreshed.promise; },
      };
      const sidebar = loadModule('admin/js/crm-sidebar.js', {
        document: {
          querySelector: (selector) => selector === '[data-add-reservation-form]' ? form : null,
          querySelectorAll: () => [], createElement: () => element(), addEventListener() {},
        },
        EcoVilaPricing: pricing, EcoVilaCalendar: calendar,
        EcoVilaCrmCalendar: { todayISO: () => '2026-09-29', guestFlagFor: () => null },
        EcoVilaSupabase: { insertStaffReservations: async () => {
          inserts += 1;
          if (conflict) throw { code: '23P01' };
        } },
      }).EcoVilaCrmSidebar;
      sidebar.init({ role: 'diana', permissions: {}, setAlert(message) { alert = message; }, formatDate: String, client: {} }, state);
      fields['[data-add-total]'].dataset.total = '1000';
      const pending = form.fire('submit', { preventDefault() {} });
      await flush();
      assert.equal(inserts, 1);
      assert.equal(submit.disabled, true);
      refreshed.resolve();
      await pending;
      assert.equal(submit.disabled, false);
      if (conflict) assert.match(alert, /tocmai au fost rezervate/);
    }
  });
});
