import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import { findUnversionedAssetRefs } from '../scripts/stamp-asset-versions.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const supabaseHelpers = require('../js/supabase.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

describe('EcoVila complaints — database migration (ADR-068)', () => {
  const migration = read('supabase/migrations/20260619170000_complaints.sql');

  it('creates the complaints, read-state and session tables', () => {
    assert.match(migration, /create table if not exists public\.complaints/);
    assert.match(migration, /create table if not exists public\.complaint_read_state/);
    assert.match(migration, /create table if not exists public\.complaint_sessions/);
  });

  it('retires the orphaned complaint_sessions table in ADR-080', () => {
    const drop = read('supabase/migrations/20260621120000_drop_complaint_sessions.sql');
    assert.match(drop, /drop table if exists public\.complaint_sessions/);
  });

  it('restricts categories and enforces true anonymity', () => {
    assert.match(migration, /category in \('casuta', 'facilitati', 'personal', 'altceva'\)/);
    assert.match(migration, /complaints_anonymous_identity_check/);
    assert.match(migration, /guest_phone is null and guest_first_name is null and reservation_id is null/);
  });

  it('locks the table to CRM staff and keeps inserts service-role only', () => {
    assert.match(migration, /enable row level security/);
    assert.match(migration, /CRM staff can read complaints/);
    assert.match(migration, /CRM staff can update complaints/);
    // No insert policy on complaints => only the service-role edge function writes.
    assert.equal(/for insert[\s\S]*?on public\.complaints/.test(migration), false);
  });

  it('adds the checkin_welcome notification event type and realtime', () => {
    assert.match(migration, /'checkin_welcome'/);
    assert.match(migration, /alter publication supabase_realtime add table public\.complaints/);
  });
});

describe('EcoVila complaints — edge functions', () => {
  it('ships complaint-submit + send-checkin-welcome with verify_jwt (login fns retired in ADR-080)', () => {
    for (const fn of ['complaint-submit', 'send-checkin-welcome']) {
      assert.equal(exists(`supabase/functions/${fn}/index.ts`), true, `${fn} should exist`);
    }
    // The OTP login functions were deleted when complaints went auth-free.
    assert.equal(exists('supabase/functions/complaint-login-start/index.ts'), false);
    assert.equal(exists('supabase/functions/complaint-login-verify/index.ts'), false);

    const config = read('supabase/config.toml');
    for (const fn of ['complaint-submit', 'send-checkin-welcome']) {
      assert.match(config, new RegExp(`\\[functions\\.${fn}\\]\\nverify_jwt = true`));
    }
    assert.equal(/\[functions\.complaint-login-/.test(config), false);
  });

  it('localizes the OTP SMS for the reservation lookup flow too', () => {
    const lookup = read('supabase/functions/reservation-lookup-start/index.ts');
    assert.match(lookup, /composeLookupCodeSms\(code, language\)/);
    const supabase = read('js/supabase.js');
    assert.match(supabase, /reservation-lookup-start'[\s\S]*?language: language \|\| 'ro'/);
  });

  it('is auth-free, prefixes the cabin number for casuta and keeps the phone optional', () => {
    const submit = read('supabase/functions/complaint-submit/index.ts');
    // The OTP session-token gate and the anonymity flag are both gone.
    assert.equal(/complaintToken/.test(submit), false);
    assert.equal(/isAnonymous/.test(submit), false);
    // Casuta reports bake "Căsuța <n> — …" straight into the description.
    assert.match(submit, /category === 'casuta'/);
    assert.match(submit, /composeCasutaDescription/);
    // An optional follow-up phone is the only identity a guest can leave.
    assert.match(submit, /normalizeOptionalPhone/);
    assert.match(submit, /guest_phone: null, guest_first_name: null, reservation_id: null/);
  });

  it('only welcomes paid, non-cancelled arrivals and dedups per group', () => {
    const welcome = read('supabase/functions/send-checkin-welcome/index.ts');
    assert.match(welcome, /requireStaffRole\(request, \['diana', 'angela'\]\)/);
    assert.match(welcome, /payment_status !== 'paid' \|\| reservation\.cancelled_at/);
    assert.match(welcome, /mapNotificationOwners/);
    assert.match(welcome, /'checkin_welcome'/);
  });

  it('registers the complaint-submit rate-limit bucket (login buckets retired in ADR-080)', () => {
    const rate = read('supabase/functions/_shared/rateLimit.ts');
    assert.match(rate, /complaintSubmitIp/);
    assert.equal(/complaintLoginStartIp|complaintLoginVerifyIp/.test(rate), false);
  });

  it('keeps the welcome SMS copy in the notifications module', () => {
    const notifications = read('supabase/functions/_shared/notifications.ts');
    assert.match(notifications, /composeCheckinWelcome/);
    assert.match(notifications, /ecovila\.md\/complaints/);
    assert.match(notifications, /Bun venit la EcoVila/);
    assert.match(notifications, /Добро пожаловать в EcoVila/);
    assert.match(notifications, /Welcome to EcoVila/);
  });
});

describe('EcoVila complaints — guest page', () => {
  const html = read('complaints.html');

  it('is noindex and links its dedicated stylesheet', () => {
    assert.match(html, /name="robots" content="noindex"/);
    assert.match(html, /css\/complaints\.css\?v=/);
  });

  it('offers the four categories, a cabin-number field, a description and an optional phone', () => {
    for (const category of ['casuta', 'facilitati', 'personal', 'altceva']) {
      assert.match(html, new RegExp(`data-cmp-category="${category}"`));
    }
    assert.match(html, /data-cmp-room-field/);
    assert.match(html, /data-cmp-room/);
    assert.match(html, /data-cmp-description/);
    assert.match(html, /data-cmp-phone/);
    assert.match(html, /data-cmp-submit/);
    // The OTP login card and the anonymity toggle are gone — complaints are auth-free.
    assert.equal(/data-cmp-anonymous/.test(html), false);
    assert.equal(/data-cmp-login/.test(html), false);
  });

  it('stamps every local asset reference', () => {
    assert.deepEqual(findUnversionedAssetRefs(html), []);
  });

  it('wires the front-end script to the auth-free submit helper', () => {
    const js = read('js/complaints.js');
    assert.match(js, /submitComplaint/);
    assert.match(js, /roomNumber:/);
    assert.match(js, /isCasuta\(\)/);
    // No OTP login flow anymore.
    assert.equal(/startComplaintLogin|verifyComplaintLogin/.test(js), false);
  });

  it('exposes the helper functions from the Supabase wrapper', () => {
    const supabase = read('js/supabase.js');
    for (const fn of [
      'submitComplaint',
      'fetchComplaints',
      'fetchBookingFailures',
      'markComplaintSolved',
      'fetchComplaintReadState',
      'upsertComplaintReadState',
      'countUnreadComplaints',
      'sendCheckinWelcome',
    ]) {
      assert.match(supabase, new RegExp(`function ${fn}\\b`), `${fn} should be defined`);
    }
  });

  it('translates the complaints UI into all three languages', () => {
    const translations = read('js/translations.js');
    assert.match(translations, /'complaints\.cat\.casuta': 'Căsuța'/);
    assert.match(translations, /'complaints\.cat\.casuta': 'Домик'/);
    assert.match(translations, /'complaints\.cat\.casuta': 'Villa'/);
    assert.match(translations, /'complaints\.roomLabel': 'Numărul căsuței'/);
    assert.match(translations, /'complaints\.roomLabel': 'Номер домика'/);
    assert.match(translations, /'complaints\.roomLabel': 'Villa number'/);
  });

  it('serves the clean /complaints URL', () => {
    assert.match(read('.htaccess'), /RewriteRule \^complaints\/\?\$ \/complaints\.html \[L\]/);
  });
});

describe('EcoVila complaints — admin Probleme tab', () => {
  it('adds the badged tab and panel to the dashboard', () => {
    const dashboard = read('admin/dashboard.html');
    assert.match(dashboard, /data-tab="probleme"/);
    assert.match(dashboard, /data-complaints-badge/);
    assert.match(dashboard, /data-panel="probleme"/);
    assert.match(dashboard, /data-complaints-list/);
    assert.match(dashboard, /data-complaints-view="current"/);
    assert.match(dashboard, /data-complaints-view="archive"/);
    assert.match(dashboard, /js\/crm-complaints\.js\?v=/);
  });

  it('makes the tab visible to both Diana and Angela', () => {
    const app = read('admin/js/crm-app.js');
    assert.match(app, /TAB_NAMES = \[[^\]]*'probleme'/);
    assert.match(app, /angela: \[[^\]]*'probleme'/);
    assert.match(app, /EcoVilaCrmComplaints\?\.showPanel/);
    assert.match(app, /EcoVilaCrmComplaints\?\.init/);
  });

  it('reads complaints and marks them solved in the module', () => {
    const module = read('admin/js/crm-complaints.js');
    assert.match(module, /fetchComplaints/);
    assert.match(module, /markComplaintSolved/);
    assert.match(module, /upsertComplaintReadState/);
    assert.match(module, /countUnreadComplaints/);
    // Description rendered via textContent (never innerHTML) to block injection.
    assert.match(module, /text\.textContent = complaint\.description/);
  });

  it('fires the welcome SMS from the daily check-in action', () => {
    const daily = read('admin/js/crm-daily.js');
    assert.match(daily, /sendCheckinWelcome\?\.\(context\.client, reservation\.id\)/);
  });
});

function createFakeElement(tagName = 'div') {
  const classes = new Set();
  const listeners = new Map();
  const attributes = new Map();
  let html = '';
  let text = '';
  const element = {
    tagName: tagName.toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    style: {},
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(val) {
      classes.clear();
      String(val || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classes.add(c));
    },
    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => c.textContent).join('');
      }
      return text;
    },
    set textContent(value) {
      text = String(value ?? '');
      this.children = [];
      html = '';
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = String(value ?? '');
      this.children = [];
      text = '';
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(eventName, handler) {
      listeners.set(eventName, [...(listeners.get(eventName) || []), handler]);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) || null;
    },
    hasAttribute(name) {
      return attributes.has(name);
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
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
      contains(name) {
        return classes.has(name);
      },
    },
    querySelector(selector) {
      return findDescendant(this, selector);
    },
    querySelectorAll(selector) {
      return findDescendants(this, selector);
    },
  };
  return element;
}

function matchesSelector(el, selector) {
  if (selector.startsWith('.')) {
    return el.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const attr = selector.slice(1, -1);
    if (attr.includes('=')) {
      const [k, v] = attr.split('=');
      const cleanVal = v.replace(/["']/g, '');
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return el.dataset[camel] === cleanVal || el.getAttribute(k) === cleanVal;
      }
      return el.getAttribute(k) === cleanVal;
    }
    if (attr.startsWith('data-')) {
      const camel = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return camel in el.dataset || el.hasAttribute(attr);
    }
    return el.hasAttribute(attr);
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function findDescendant(parent, selector) {
  for (const child of parent.children) {
    if (matchesSelector(child, selector)) return child;
    const found = findDescendant(child, selector);
    if (found) return found;
  }
  return null;
}

function findDescendants(parent, selector) {
  const results = [];
  for (const child of parent.children) {
    if (matchesSelector(child, selector)) results.push(child);
    results.push(...findDescendants(child, selector));
  }
  return results;
}

function createFakeDocument() {
  const rootEl = createFakeElement('html');
  const body = createFakeElement('body');
  rootEl.appendChild(body);

  return {
    createElement(tag) {
      return createFakeElement(tag);
    },
    querySelector(sel) {
      return findDescendant(rootEl, sel);
    },
    querySelectorAll(sel) {
      return findDescendants(rootEl, sel);
    },
    body,
    addEventListener() {},
  };
}

function loadComplaintsModule(document, supabase) {
  const sandbox = {
    console,
    Date,
    Intl,
    document,
    EcoVilaSupabase: supabase,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(read('admin/js/crm-complaints.js'), sandbox);
  return sandbox.EcoVilaCrmComplaints;
}

describe('EcoVila booking failures — CRM Probleme tab (Item 2)', () => {
  it('fetchBookingFailures queries booking_failures with 7-day default and total ordering (2a)', async () => {
    const calls = [];
    const dummyRows = [
      { id: 2, created_at: '2026-09-03T10:00:00Z', reason: 'rooms_unavailable' },
      { id: 1, created_at: '2026-09-02T10:00:00Z', reason: 'server_error' },
    ];

    const mockClient = {
      from(table) {
        calls.push({ call: 'from', table });
        const query = {
          select(cols) {
            calls.push({ call: 'select', cols });
            return this;
          },
          gte(col, val) {
            calls.push({ call: 'gte', col, val });
            return this;
          },
          order(col, opts) {
            calls.push({ call: 'order', col, opts });
            return this;
          },
          range(from, to) {
            calls.push({ call: 'range', from, to });
            return Promise.resolve({ data: dummyRows.slice(from, to + 1), error: null });
          },
        };
        return query;
      },
    };

    const before = Date.now();
    const rows = await supabaseHelpers.fetchBookingFailures(mockClient);
    const after = Date.now();

    assert.equal(rows.length, 2);
    assert.equal(calls[0].table, 'booking_failures');

    const gteCall = calls.find((c) => c.call === 'gte');
    assert.ok(gteCall, 'should filter gte created_at');
    assert.equal(gteCall.col, 'created_at');
    const cutoffTime = new Date(gteCall.val).getTime();
    assert.ok(cutoffTime >= before - 7 * 86400000 - 1000 && cutoffTime <= after - 7 * 86400000 + 1000);

    const orderCalls = calls.filter((c) => c.call === 'order');
    assert.equal(orderCalls.length, 2, 'should have 2 order calls for deterministic ordering');
    assert.equal(orderCalls[0].col, 'created_at');
    assert.equal(orderCalls[0].opts.ascending, false);
    assert.equal(orderCalls[1].col, 'id');
    assert.equal(orderCalls[1].opts.ascending, false);
  });

  it('pages via unwrapAllSupabaseRows to protect against the PostgREST 1000-row cap (B-37, ADR-092)', async () => {
    const rangeCalls = [];
    const totalRows = 1250;
    const mockData = Array.from({ length: totalRows }, (_, i) => ({
      id: totalRows - i,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      reason: 'rooms_unavailable',
    }));

    const mockClient = {
      from(table) {
        return {
          select() {
            return this;
          },
          gte() {
            return this;
          },
          order() {
            return this;
          },
          range(from, to) {
            rangeCalls.push([from, to]);
            return Promise.resolve({ data: mockData.slice(from, to + 1), error: null });
          },
        };
      },
    };

    const rows = await supabaseHelpers.fetchBookingFailures(mockClient, { sinceDays: 7 });
    assert.equal(rows.length, 1250);
    assert.deepEqual(rangeCalls, [
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('maps reason codes and room types to Romanian labels', () => {
    const doc = createFakeDocument();
    const crm = loadComplaintsModule(doc, supabaseHelpers);

    assert.equal(crm.FAILURE_REASON_LABELS.rooms_unavailable, 'Cazare ocupată');
    assert.equal(crm.FAILURE_REASON_LABELS.invalid_request, 'Date invalide');
    assert.equal(crm.FAILURE_REASON_LABELS.rate_limited, 'Limită de cereri atinsă');
    assert.equal(crm.FAILURE_REASON_LABELS.server_error, 'Eroare de server');

    assert.equal(crm.FAILURE_ROOM_TYPE_LABELS.small, 'căsuțe mici');
    assert.equal(crm.FAILURE_ROOM_TYPE_LABELS.large, 'căsuțe mari');
    assert.equal(crm.FAILURE_ROOM_TYPE_LABELS.hotel, 'hotel');
  });

  it('renders the calm zero-state line when there are no booking failures', () => {
    const doc = createFakeDocument();
    const container = doc.createElement('section');
    container.setAttribute('data-booking-failures', '');
    doc.body.appendChild(container);

    const crm = loadComplaintsModule(doc, supabaseHelpers);
    crm.renderBookingFailures({}, []);

    assert.match(container.textContent, /Nicio rezervare eșuată în ultimele 7 zile\./);
    const zeroEl = container.querySelector('.crm-booking-failures__zero');
    assert.ok(zeroEl, 'zero state paragraph should be present');
    assert.equal(container.querySelector('.crm-booking-failures__headline'), null);
  });

  it('renders the count and per-cause breakdown sorted most frequent first, including most-affected date range', () => {
    const doc = createFakeDocument();
    const container = doc.createElement('section');
    container.setAttribute('data-booking-failures', '');
    doc.body.appendChild(container);

    const crm = loadComplaintsModule(doc, supabaseHelpers);

    const failures = [
      ...Array.from({ length: 8 }, () => ({
        reason: 'rooms_unavailable',
        room_type: 'small',
        check_in: '2026-09-13',
        check_out: '2026-09-14',
      })),
      ...Array.from({ length: 4 }, () => ({
        reason: 'rooms_unavailable',
        room_type: 'hotel',
        check_in: '2026-09-13',
        check_out: '2026-09-14',
      })),
      { reason: 'server_error', room_type: null },
    ];

    crm.renderBookingFailures({}, failures);

    const headline = container.querySelector('.crm-booking-failures__headline');
    assert.ok(headline);
    assert.equal(headline.textContent, 'Rezervări eșuate (7 zile): 13');

    const causes = container.querySelectorAll('.crm-booking-failures__cause');
    assert.equal(causes.length, 2);

    assert.match(causes[0].textContent, /^Cazare ocupată — 12/);
    assert.match(causes[0].textContent, /căsuțe mici 8, hotel 4/);
    assert.match(causes[0].textContent, /cel mai afectat: 13–14 sept\./);

    assert.match(causes[1].textContent, /^Eroare de server — 1$/);
  });

  it('renders the CRM Romanian label for rate_limited booking failures', () => {
    const doc = createFakeDocument();
    const container = doc.createElement('section');
    container.setAttribute('data-booking-failures', '');
    doc.body.appendChild(container);

    const crm = loadComplaintsModule(doc, supabaseHelpers);

    crm.renderBookingFailures({}, [
      { reason: 'rate_limited', room_type: null },
    ]);

    const causes = container.querySelectorAll('.crm-booking-failures__cause');
    assert.equal(causes.length, 1);
    assert.match(causes[0].textContent, /^Limită de cereri atinsă — 1$/);
  });

  it('a failed read degrades quietly via context.setAlert and never stops complaints from rendering', async () => {
    const doc = createFakeDocument();
    const failuresBox = doc.createElement('section');
    failuresBox.setAttribute('data-booking-failures', '');
    doc.body.appendChild(failuresBox);

    const complaintsList = doc.createElement('div');
    complaintsList.setAttribute('data-complaints-list', '');
    doc.body.appendChild(complaintsList);

    let alertMessage = null;
    const mockComplaints = [
      {
        id: 'cmp-1',
        category: 'casuta',
        description: 'Frigiderul nu funcționează',
        created_at: '2026-09-02T12:00:00Z',
        is_anonymous: false,
        guest_first_name: 'Mihai',
      },
    ];

    const mockSupabase = {
      ...supabaseHelpers,
      fetchBookingFailures() {
        return Promise.reject(new Error('Network error on booking failures'));
      },
      fetchComplaints() {
        return Promise.resolve(mockComplaints);
      },
      fetchComplaintReadState() {
        return Promise.resolve(null);
      },
      upsertComplaintReadState() {
        return Promise.resolve([]);
      },
      countUnreadComplaints() {
        return Promise.resolve(1);
      },
    };

    const crm = loadComplaintsModule(doc, mockSupabase);

    const mockContext = {
      client: {
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
      },
      session: { user: { id: 'usr-angela' } },
      formatDate(d) {
        return d;
      },
      setAlert(msg) {
        alertMessage = msg;
      },
    };

    crm.init(mockContext);
    crm.showPanel();

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(alertMessage, 'Network error on booking failures');

    const cards = complaintsList.querySelectorAll('.crm-complaint-card');
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /Frigiderul nu funcționează/);
  });

  it('leaves the Probleme unread badge unaffected by booking-failure rows (2c)', async () => {
    const doc = createFakeDocument();
    const badge = doc.createElement('span');
    badge.setAttribute('data-complaints-badge', '');
    doc.body.appendChild(badge);

    let unreadCountCalls = 0;
    const mockSupabase = {
      ...supabaseHelpers,
      fetchBookingFailures() {
        return Promise.resolve(
          Array.from({ length: 50 }, (_, i) => ({
            id: i + 1,
            reason: 'rooms_unavailable',
            created_at: '2026-09-03T10:00:00Z',
          })),
        );
      },
      fetchComplaints() {
        return Promise.resolve([]);
      },
      fetchComplaintReadState() {
        return Promise.resolve({ last_seen_at: '2026-09-01T00:00:00Z' });
      },
      countUnreadComplaints() {
        unreadCountCalls += 1;
        return Promise.resolve(2);
      },
    };

    const crm = loadComplaintsModule(doc, mockSupabase);
    const mockContext = {
      client: {
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
      },
      session: { user: { id: 'usr-diana' } },
      formatDate(d) {
        return d;
      },
      setAlert() {},
    };

    crm.init(mockContext);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(unreadCountCalls, 1);
    assert.equal(badge.textContent, '2');
    assert.equal(badge.hidden, false);
  });

  it('admin/dashboard.html includes data-booking-failures in the Probleme panel', () => {
    const html = read('admin/dashboard.html');
    assert.match(html, /data-panel="probleme"[\s\S]*?data-booking-failures[\s\S]*?class="crm-complaints-bar"/);
    assert.match(html, /Nicio rezervare eșuată în ultimele 7 zile\./);
  });

  it('keeps failureReason return values and the migration CHECK allowlist in lockstep', () => {
    const migration = read(
      'supabase/migrations/20260903120000_booking_conflict_visibility.sql',
    );
    const createReservation = read(
      'supabase/functions/create-reservation/index.ts',
    );

    const checkMatch = migration.match(/reason\s+in\s*\(([^)]+)\)/i);
    assert.ok(checkMatch, 'booking_failures table must have a reason CHECK constraint');
    const checkValues = checkMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();

    const typeMatch = createReservation.match(/type\s+FailureReason\s*=\s*([^;]+);/);
    assert.ok(typeMatch, 'create-reservation must define FailureReason type');
    const typeValues = typeMatch[1]
      .split('|')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort();

    assert.deepEqual(
      typeValues,
      checkValues,
      'FailureReason type union must match migration reason CHECK allowlist exactly',
    );

    const fnMatch = createReservation.match(
      /function\s+failureReason\s*\([\s\S]*?\)\s*(?::\s*FailureReason\s*)?\{([\s\S]*?)\n\}/,
    );
    assert.ok(fnMatch, 'create-reservation must define failureReason function');
    const returnMatches = Array.from(
      fnMatch[1].matchAll(/return\s+'([^']+)'/g),
      (m) => m[1],
    );
    const fnReturnSet = [...new Set(returnMatches)].sort();

    assert.deepEqual(
      fnReturnSet,
      checkValues,
      'Every string returned by failureReason() must match the migration CHECK allowlist exactly',
    );
  });
});

