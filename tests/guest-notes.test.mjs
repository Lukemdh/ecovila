import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const calendar = require('../admin/js/crm-calendar.js');
const helpers = require('../js/supabase.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function marker(overrides = {}) {
  return {
    id: 'note-1',
    guest_phone: '+37360111111',
    guest_email: 'ion@mail.md',
    severity: 'vip',
    created_at: '2026-08-30T10:00:00.000Z',
    body_preview: 'Client fidel',
    ...overrides,
  };
}

describe('ADR-111 guest flag matching', () => {
  it('normalizes guest email by trimming and lowercasing absent values to empty', () => {
    assert.equal(calendar.normalizeGuestEmail('  Ion@Mail.MD '), 'ion@mail.md');
    assert.equal(calendar.normalizeGuestEmail(null), '');
    assert.equal(calendar.normalizeGuestEmail(undefined), '');
  });

  it('skips empty phone and email keys when building the index', () => {
    const index = calendar.buildGuestFlagIndex([
      marker({ id: 'empty', guest_phone: null, guest_email: '' }),
      marker({ id: 'phone', guest_email: null }),
      marker({ id: 'email', guest_phone: null }),
    ]);

    assert.equal(index.byPhone.has(''), false);
    assert.equal(index.byEmail.has(''), false);
    assert.deepEqual(index.byPhone.get('+37360111111').map((item) => item.id), ['phone']);
    assert.deepEqual(index.byEmail.get('ion@mail.md').map((item) => item.id), ['email']);
  });

  it('matches by phone only', () => {
    const index = calendar.buildGuestFlagIndex([
      marker({ guest_email: null, severity: 'attention', body_preview: 'Sună înainte' }),
    ]);
    assert.deepEqual(calendar.guestFlagFor({ guest_phone: '+37360111111' }, index), {
      severity: 'attention',
      hasAttention: true,
      hasVip: false,
      count: 1,
      preview: 'Sună înainte',
    });
  });

  it('matches email without case sensitivity', () => {
    const index = calendar.buildGuestFlagIndex([
      marker({ guest_phone: null, guest_email: 'ion@mail.md' }),
    ]);
    assert.equal(calendar.guestFlagFor({ guest_email: 'Ion@Mail.MD' }, index).severity, 'vip');
  });

  it('does not match empty reservation email to a marker with no phone', () => {
    const index = calendar.buildGuestFlagIndex([
      marker({ guest_phone: null, guest_email: null }),
    ]);
    assert.equal(calendar.guestFlagFor({ guest_phone: '', guest_email: '' }, index), null);
  });

  it('lets attention beat vip and previews the newest attention marker', () => {
    const index = calendar.buildGuestFlagIndex([
      marker({
        id: 'attention-old',
        severity: 'attention',
        created_at: '2026-08-20T10:00:00.000Z',
        body_preview: 'Avertisment real',
      }),
      marker({
        id: 'vip-new',
        severity: 'vip',
        created_at: '2026-08-31T10:00:00.000Z',
        body_preview: 'Compliment recent',
      }),
    ]);
    const flag = calendar.guestFlagFor({
      guest_phone: '+37360111111',
      guest_email: 'ION@MAIL.MD',
    }, index);

    assert.equal(flag.severity, 'attention');
    assert.equal(flag.hasAttention, true);
    assert.equal(flag.hasVip, true);
    assert.equal(flag.preview, 'Avertisment real');
  });

  it('deduplicates one marker that matches both phone and email', () => {
    const shared = marker();
    const index = calendar.buildGuestFlagIndex([shared]);
    const flag = calendar.guestFlagFor({
      guest_phone: shared.guest_phone,
      guest_email: 'ION@MAIL.MD',
    }, index);

    assert.equal(flag.count, 1);
  });
});

describe('ADR-111 CRM markup and wiring contracts', () => {
  it('keeps the dossier hooks singular, flat, and button-driven', () => {
    const html = read('admin/dashboard.html');
    const hooks = [
      'data-guest-dossier',
      'data-dossier-count',
      'data-dossier-list',
      'data-dossier-empty',
      'data-dossier-compose',
      'data-dossier-body',
      'data-dossier-hint',
      'data-dossier-error',
      'data-dossier-add',
    ];
    hooks.forEach((hook) => {
      assert.equal((html.match(new RegExp(`\\b${hook}\\b`, 'g')) || []).length, 1, `${hook} must appear once`);
    });
    assert.equal((html.match(/\bdata-dossier-severity\b/g) || []).length, 3);

    const start = html.indexOf('<section class="crm-dossier"');
    const end = html.indexOf('</section>', start);
    const dossier = html.slice(start, end + '</section>'.length);
    assert.doesNotMatch(dossier, /<form\b/i);
    assert.match(dossier, /<button[^>]*type="button"[^>]*data-dossier-add|<button[^>]*data-dossier-add[^>]*type="button"/i);
    assert.match(html, /<span>Notă despre această rezervare<\/span>/);
  });

  it('keeps checkout dossier copying opt-in and unchecked', () => {
    const html = read('admin/dashboard.html');
    const match = html.match(/<input\b[^>]*data-checkout-to-dossier[^>]*>/i);
    assert.ok(match);
    assert.doesNotMatch(match[0], /\bchecked\b/i);
  });

  it('exports all guest-note helpers and searches with the full reservation shape', async () => {
    for (const name of [
      'fetchGuestFlagMarkers',
      'fetchGuestNotes',
      'createGuestNote',
      'archiveGuestNote',
      'fetchReservationGroupById',
    ]) {
      assert.equal(typeof helpers[name], 'function', `${name} must be exported`);
    }

    let selected = '';
    const builder = {
      select(columns) { selected = columns; return builder; },
      order() { return builder; },
      limit() { return builder; },
      gte() { return builder; },
      then(resolve) { resolve({ data: [], error: null }); },
    };
    await helpers.searchReservations({ from: () => builder }, {});
    assert.match(selected, /\bbooking_group_id\b/);
    assert.match(selected, /\badults\b/);
    assert.match(selected, /rooms\(id, number, type\)/);
  });
});
