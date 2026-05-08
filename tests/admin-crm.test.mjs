import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
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

    for (const label of ['Dashboard', 'Situația zilnică', 'Poze', 'Prețuri']) {
      assert.match(dashboard, new RegExp(label, 'i'), `${label} tab should exist`);
    }

    assert.match(dashboard, /data-tab="dashboard"/i);
    assert.match(dashboard, /data-tab="daily"/i);
    assert.match(dashboard, /data-tab="photos"/i);
    assert.match(dashboard, /data-tab="pricing"/i);
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
    assert.match(css, /--crm-day-column-width:\s*(?:24[0-9]|2[5-9][0-9]|[3-9][0-9]{2})px/i);
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
      'Șterge rezervarea',
      'schimba',
      'sterge',
    ]) {
      assert.match(`${dashboard}\n${dashboardJs}\n${sidebarJs}`, new RegExp(label, 'i'));
    }

    assert.match(dashboardJs, /room_explicitly_selected/i);
    assert.match(dashboardJs, /payment_status:\s*'paid'/i);
    assert.match(dashboardJs, /cash_expires_at:\s*null/i);
  });

  it('implements the shared daily reception workflow', () => {
    const dashboard = read('admin/dashboard.html');
    const daily = read('admin/js/crm-daily.js');

    for (const label of [
      'Se cazează azi',
      'Pleacă azi',
      'S-a cazat',
      'A plecat',
      'Adaugă un feedback clientului',
    ]) {
      assert.match(`${dashboard}\n${daily}`, new RegExp(label, 'i'));
    }

    assert.match(daily, /crm_daily_statuses/i);
    assert.match(daily, /check_in/i);
    assert.match(daily, /check_out/i);
    assert.match(daily, /upsert/i);
    assert.match(daily, /sortByRoomWithCompletedLast/i);
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

  it('moves pricing and holidays into the Prețuri tab', () => {
    const dashboard = read('admin/dashboard.html');
    const pricing = read('admin/js/crm-pricing.js');

    for (const label of [
      'Dată intrare în vigoare',
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
